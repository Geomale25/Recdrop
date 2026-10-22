import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { encodeWav } from '../lib/wav.js';
import { autoName, errorText, formatTime } from '../lib/format.js';
import { computePeaks, maxPeak } from '../lib/peaks.js';
import { FitIcon, PauseIcon, PlayIcon, ZoomInIcon, ZoomOutIcon } from './Icons.jsx';

const MIN_SELECTION = 0.1; // seconds
const MIN_VIEW = 0.05; // most zoomed-in view, in seconds
const HANDLE_GRAB_PX = 10;
const ZOOM_STEP = 1.8;

const BAR_W = 3;
const GAP = 1;
const OV_BAR_W = 2;
const OV_GAP = 1;

function drawBars(canvas, width, peaks, scale, barW, gap, isOn, colors) {
  if (!canvas || !width) return;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, width, height);
  const mid = height / 2;
  const maxH = height - Math.min(16, height * 0.2);
  for (let i = 0; i < peaks.length; i++) {
    const x = i * (barW + gap);
    const h = Math.max(1.5, Math.min(1, peaks[i] / scale) * maxH);
    g.fillStyle = isOn(x + barW / 2) ? colors.on : colors.off;
    g.beginPath();
    g.roundRect(x, mid - h / 2, barW, h, barW / 2);
    g.fill();
  }
}

// mode "crop": crops the saved file (clip.filePath) and replaces it.
// mode "new":  the recording isn't saved yet (automatic save failed); pick a name and save it.
export default function Editor({ mode, clip, onSaved, onCancel, initialError = '' }) {
  const { buffer } = clip;
  const duration = buffer.duration;
  const cropping = mode === 'crop';
  const fileName = clip.filePath?.split(/[\\/]/).pop() || '';
  const origFormat = cropping ? fileName.split('.').pop().toLowerCase() : 'mp3';
  const [start, setStart] = useState(clip.start ?? 0);
  const [end, setEnd] = useState(clip.end ?? duration);
  const [view, setView] = useState({ start: 0, end: duration });
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(clip.start ?? 0);
  const [name, setName] = useState('');
  const [format, setFormat] = useState(origFormat);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(initialError);
  const [width, setWidth] = useState(0);

  const placeholder = useMemo(() => autoName(), []);
  const waveRef = useRef(null);
  const canvasRef = useRef(null);
  const overviewRef = useRef(null);
  const ovCanvasRef = useRef(null);
  const audioCtx = useRef(null);
  const source = useRef(null);
  const raf = useRef(0);
  const dragging = useRef(null);
  const ovDrag = useRef(null);
  const sel = useRef({ start, end });
  sel.current = { start, end };
  const viewRef = useRef(view);
  viewRef.current = view;

  const viewLen = view.end - view.start;
  const zoom = duration / viewLen;

  // ----- Zoom / pan -----
  const clampView = useCallback(
    (s, len) => {
      len = Math.min(duration, Math.max(Math.min(MIN_VIEW, duration), len));
      s = Math.min(Math.max(0, s), duration - len);
      return { start: s, end: s + len };
    },
    [duration]
  );

  // Zoom keeping time `t` at the same place on screen.
  const zoomAt = useCallback(
    (t, factor) => {
      const v = viewRef.current;
      const len = v.end - v.start;
      const newLen = Math.min(duration, Math.max(Math.min(MIN_VIEW, duration), len * factor));
      const ratio = (t - v.start) / len;
      let s = t - ratio * newLen;
      // Snap to the recording's edges when very close, so handles there stay on screen.
      const snap = newLen * 0.03;
      if (s < snap) s = 0;
      if (s + newLen > duration - snap) s = duration - newLen;
      setView(clampView(s, newLen));
    },
    [clampView, duration]
  );

  const zoomButton = (factor) => {
    const v = viewRef.current;
    const inView = playhead >= v.start && playhead <= v.end;
    zoomAt(inView ? playhead : (v.start + v.end) / 2, factor);
  };
  const fitAll = () => setView({ start: 0, end: duration });

  useEffect(() => {
    const el = waveRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const v = viewRef.current;
      const len = v.end - v.start;
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 40 : 1; // lines → pixels
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal) {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
        setView(clampView(v.start + (d / rect.width) * len, len));
      } else {
        const t = v.start + ((e.clientX - rect.left) / rect.width) * len;
        zoomAt(t, Math.exp(e.deltaY * unit * 0.002));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clampView, zoomAt]);

  // ----- Audio playback -----
  useEffect(() => {
    audioCtx.current = new AudioContext({ sampleRate: buffer.sampleRate });
    return () => {
      cancelAnimationFrame(raf.current);
      try {
        source.current?.stop();
      } catch {}
      audioCtx.current.close().catch(() => {});
    };
  }, [buffer]);

  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (source.current) {
      source.current.onended = null;
      try {
        source.current.stop();
      } catch {}
      source.current = null;
    }
    setPlaying(false);
  }, []);

  const play = useCallback(
    (from) => {
      stopPlayback();
      const ctx = audioCtx.current;
      const { start: s, end: e } = sel.current;
      if (from < s || from >= e - 0.02) from = s;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0, from, e - from);
      source.current = src;
      const t0 = ctx.currentTime;

      src.onended = () => {
        cancelAnimationFrame(raf.current);
        source.current = null;
        setPlaying(false);
        setPlayhead(sel.current.start);
      };

      const loop = () => {
        setPlayhead(Math.min(e, from + (ctx.currentTime - t0)));
        raf.current = requestAnimationFrame(loop);
      };
      setPlaying(true);
      loop();
    },
    [buffer, stopPlayback]
  );

  const togglePlay = useCallback(() => {
    if (playing) stopPlayback();
    else play(playhead);
  }, [playing, playhead, play, stopPlayback]);

  // While playing zoomed in, page the view so the playhead stays visible.
  useEffect(() => {
    if (!playing) return;
    const v = viewRef.current;
    if (playhead > v.end || playhead < v.start) {
      const len = v.end - v.start;
      setView(clampView(playhead - len * 0.05, len));
    }
  }, [playhead, playing, clampView]);

  // Keyboard: Space = play/pause, +/- = zoom, 0 = show all (unless typing a name)
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (['INPUT', 'SELECT'].includes(tag)) return;
      if (e.code === 'Space' && tag !== 'BUTTON') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === '+' || e.key === '=') zoomButton(1 / ZOOM_STEP);
      else if (e.key === '-') zoomButton(ZOOM_STEP);
      else if (e.key === '0') fitAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ----- Waveforms -----
  useEffect(() => {
    const el = waveRef.current;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => maxPeak(buffer), [buffer]);

  const peaks = useMemo(
    () => (width ? computePeaks(buffer, view.start, view.end, Math.floor(width / (BAR_W + GAP))) : []),
    [buffer, width, view.start, view.end]
  );

  const overviewPeaks = useMemo(
    () => (width ? computePeaks(buffer, 0, duration, Math.floor(width / (OV_BAR_W + OV_GAP))) : []),
    [buffer, width, duration]
  );

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const colors = {
      on: styles.getPropertyValue('--wave-on').trim(),
      off: styles.getPropertyValue('--wave-off').trim(),
    };
    const len = view.end - view.start;
    drawBars(canvasRef.current, width, peaks, scale, BAR_W, GAP, (x) => {
      const t = view.start + (x / width) * len;
      return t >= start && t <= end;
    }, colors);
    drawBars(ovCanvasRef.current, width, overviewPeaks, scale, OV_BAR_W, OV_GAP, (x) => {
      const t = (x / width) * duration;
      return t >= start && t <= end;
    }, colors);
  }, [peaks, overviewPeaks, scale, start, end, width, view, duration]);

  // ----- Dragging handles / seeking in the main waveform -----
  const timeFromEvent = (e) => {
    const rect = waveRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
    const v = viewRef.current;
    return v.start + (x / rect.width) * (v.end - v.start);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = waveRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const toX = (t) => ((t - view.start) / viewLen) * rect.width;
    const handle = e.target.dataset?.handle;

    let which = handle || null;
    if (!which) {
      const dStart = Math.abs(x - toX(start));
      const dEnd = Math.abs(x - toX(end));
      if (Math.min(dStart, dEnd) <= HANDLE_GRAB_PX) which = dStart <= dEnd ? 'start' : 'end';
    }

    if (which) {
      if (playing) stopPlayback();
      dragging.current = which;
      waveRef.current.setPointerCapture(e.pointerId);
      return;
    }

    // Click inside the waveform: move the playhead (within the selection).
    const t = Math.min(Math.max(timeFromEvent(e), start), end);
    setPlayhead(t);
    if (playing) play(t);
  };

  const onPointerMove = (e) => {
    if (!dragging.current) return;
    const t = timeFromEvent(e);
    if (dragging.current === 'start') {
      const s = Math.max(0, Math.min(t, end - MIN_SELECTION));
      setStart(s);
      setPlayhead(s);
    } else {
      const en = Math.min(duration, Math.max(t, start + MIN_SELECTION));
      setEnd(en);
      setPlayhead((p) => Math.min(p, en));
    }
  };

  const onPointerUp = (e) => {
    if (dragging.current) waveRef.current.releasePointerCapture?.(e.pointerId);
    dragging.current = null;
  };

  // ----- Overview strip: drag the box (or click) to move around -----
  const ovTime = (e) => {
    const rect = overviewRef.current.getBoundingClientRect();
    return (Math.min(Math.max(0, e.clientX - rect.left), rect.width) / rect.width) * duration;
  };

  const onOvDown = (e) => {
    if (e.button !== 0) return;
    const t = ovTime(e);
    const v = viewRef.current;
    const len = v.end - v.start;
    if (t >= v.start && t <= v.end) {
      ovDrag.current = t - v.start;
    } else {
      ovDrag.current = len / 2;
      setView(clampView(t - len / 2, len));
    }
    overviewRef.current.setPointerCapture(e.pointerId);
  };

  const onOvMove = (e) => {
    if (ovDrag.current == null) return;
    const v = viewRef.current;
    setView(clampView(ovTime(e) - ovDrag.current, v.end - v.start));
  };

  const onOvUp = (e) => {
    if (ovDrag.current != null) overviewRef.current.releasePointerCapture?.(e.pointerId);
    ovDrag.current = null;
  };

  const resetSelection = () => {
    stopPlayback();
    setStart(0);
    setEnd(duration);
    setPlayhead(0);
  };

  // ----- Save -----
  async function save() {
    stopPlayback();
    setSaving(true);
    setError('');
    try {
      const wavBuffer = encodeWav(buffer, start, end);
      const res = cropping
        ? await window.api.saveFile({ wavBuffer, format, replacePath: clip.filePath })
        : await window.api.saveFile({ wavBuffer, name: name.trim() || placeholder, format });
      onSaved({ start, end, format, filePath: res.filePath, size: res.size });
    } catch (err) {
      console.error(err);
      setError('Saving failed: ' + errorText(err));
      setSaving(false);
    }
  }

  function cancel() {
    if (cropping || window.confirm('Discard this recording? It has not been saved.')) {
      stopPlayback();
      onCancel();
    }
  }

  // Positions inside the zoomed view, in %
  const pos = (t) => ((t - view.start) / viewLen) * 100;
  const clampPct = (p) => Math.min(100, Math.max(0, p));
  const inView = (t) => t >= view.start - 1e-9 && t <= view.end + 1e-9;
  const ovPct = (t) => `${(t / duration) * 100}%`;
  const trimmed = start > 0.001 || end < duration - 0.001;
  // In crop mode there's nothing to save until the selection or format changes.
  const changed =
    !cropping || Math.abs(start - clip.start) > 0.001 || Math.abs(end - clip.end) > 0.001 || format !== origFormat;
  const zoomed = zoom > 1.001;

  return (
    <div className="editor">
      <div className="editor-head">
        <h2>Crop recording</h2>
        <span className="muted">Drag the handles · scroll to zoom · Shift+scroll to move</span>
        <div className="zoom-tools">
          <span className="zoom-label" title="Zoom level">
            {zoom < 10 ? zoom.toFixed(1).replace('.0', '') : Math.round(zoom)}×
          </span>
          <button className="tool-btn" onClick={() => zoomButton(ZOOM_STEP)} disabled={!zoomed} title="Zoom out (−)">
            <ZoomOutIcon />
          </button>
          <button
            className="tool-btn"
            onClick={() => zoomButton(1 / ZOOM_STEP)}
            disabled={viewLen <= Math.min(MIN_VIEW, duration) + 1e-6}
            title="Zoom in (+)"
          >
            <ZoomInIcon />
          </button>
          <button className="tool-btn" onClick={fitAll} disabled={!zoomed} title="Show whole recording (0)">
            <FitIcon />
          </button>
        </div>
      </div>

      <div
        className="wave"
        ref={waveRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} />
        <div className="shade" style={{ left: 0, width: `${clampPct(pos(start))}%` }} />
        <div className="shade" style={{ left: `${clampPct(pos(end))}%`, right: 0 }} />
        {inView(start) && (
          <div className="handle" data-handle="start" style={{ left: `${pos(start)}%` }}>
            <span data-handle="start" />
          </div>
        )}
        {inView(end) && (
          <div className="handle" data-handle="end" style={{ left: `${pos(end)}%` }}>
            <span data-handle="end" />
          </div>
        )}
        {inView(playhead) && <div className="playhead" style={{ left: `${pos(playhead)}%` }} />}
        <div className="view-times">
          <span>{formatTime(view.start, true)}</span>
          <span>{formatTime(view.end, true)}</span>
        </div>
      </div>

      <div
        className={`overview ${zoomed ? 'zoomed' : ''}`}
        ref={overviewRef}
        onPointerDown={onOvDown}
        onPointerMove={onOvMove}
        onPointerUp={onOvUp}
        onPointerCancel={onOvUp}
        title="Whole recording: drag the box to move around"
      >
        <canvas ref={ovCanvasRef} />
        <div className="ov-window" style={{ left: ovPct(view.start), width: ovPct(viewLen) }} />
        <div className="ov-playhead" style={{ left: ovPct(playhead) }} />
      </div>

      <div className="transport">
        <button className="play-btn" onClick={togglePlay} title={playing ? 'Pause (Space)' : 'Play selection (Space)'}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="times">
          <div>
            <label>Start</label>
            <span>{formatTime(start, true)}</span>
          </div>
          <div>
            <label>End</label>
            <span>{formatTime(end, true)}</span>
          </div>
          <div>
            <label>Length</label>
            <span className="accent">{formatTime(end - start, true)}</span>
          </div>
        </div>
        <button className="ghost small" onClick={resetSelection} disabled={!trimmed} title="Select the whole recording">
          Reset
        </button>
      </div>

      <div className="save-row">
        {cropping ? (
          <span className="save-note" title={fileName}>
            Replaces <strong>{fileName}</strong>
          </span>
        ) : (
        <input
          className="name-input"
          type="text"
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !saving && save()}
          spellCheck={false}
          aria-label="File name"
        />
        )}
        <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="File format">
          <option value="mp3">MP3</option>
          <option value="mp4">MP4</option>
          <option value="wav">WAV</option>
        </select>
        <button className="primary" onClick={save} disabled={saving || !changed}>
          {saving ? 'Saving…' : cropping ? 'Save crop' : 'Save'}
        </button>
      </div>

      <div className="editor-foot">
        {cropping ? (
          <button className="ghost small" onClick={cancel} disabled={saving}>
            Cancel
          </button>
        ) : (
          <button className="ghost danger small" onClick={cancel} disabled={saving}>
            Discard recording
          </button>
        )}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
