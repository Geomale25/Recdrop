import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, formatSize, formatTime } from '../lib/format.js';
import {
  CheckIcon,
  CopyIcon,
  CropIcon,
  FolderIcon,
  GripIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
} from './Icons.jsx';

// Shown after a recording is saved: the file card (drag it out, rename it, play it) and actions.
export default function Saved({ clip, status, onRenamed, onCopy, onCrop, onNew, onDeleted }) {
  const { buffer, start, end, filePath, size } = clip;
  const fileName = filePath.split(/[\\/]/).pop();
  const dot = fileName.lastIndexOf('.');
  const baseName = fileName.slice(0, dot);
  const ext = fileName.slice(dot + 1);

  const [draft, setDraft] = useState(baseName);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const inputRef = useRef(null);
  const audioCtx = useRef(null);
  const source = useRef(null);
  const raf = useRef(0);

  useEffect(() => setDraft(baseName), [baseName]);

  // ----- Playback (from the lossless copy in memory) -----
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

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (source.current) {
      source.current.onended = null;
      try {
        source.current.stop();
      } catch {}
      source.current = null;
    }
    setPlaying(false);
    setProgress(0);
  }, []);

  const togglePlay = useCallback(() => {
    if (playing) return stop();
    const ctx = audioCtx.current;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0, start, end - start);
    source.current = src;
    const t0 = ctx.currentTime;
    src.onended = stop;
    const loop = () => {
      setProgress(Math.min(1, (ctx.currentTime - t0) / (end - start)));
      raf.current = requestAnimationFrame(loop);
    };
    setPlaying(true);
    loop();
  }, [playing, buffer, start, end, stop]);

  // Space = play/pause (unless typing the name)
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (e.code === 'Space' && !['INPUT', 'BUTTON', 'SELECT'].includes(tag)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  // ----- Rename (renames the file itself) -----
  async function commitName() {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === baseName) {
      setDraft(baseName);
      if (!next) setError('');
      return;
    }
    try {
      const res = await window.api.renameFile(filePath, next);
      setError('');
      onRenamed(res.filePath);
      // The clipboard still points at the old name: copy again.
      onCopy(res.filePath);
    } catch (err) {
      setError(errorText(err));
      setDraft(baseName);
    }
  }

  function onNameKey(e) {
    if (e.key === 'Enter') e.currentTarget.blur();
    else if (e.key === 'Escape') {
      setDraft(baseName);
      setError('');
      // Blur without saving
      setEditing(false);
      requestAnimationFrame(() => inputRef.current?.blur());
    }
  }

  // ----- Actions -----
  async function copy() {
    const ok = await onCopy(filePath);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else setError('Could not copy the file.');
  }

  async function remove() {
    if (!window.confirm(`Move "${fileName}" to the Recycle Bin?`)) return;
    stop();
    try {
      await window.api.trashFile(filePath);
      onDeleted();
    } catch (err) {
      setError('Could not delete: ' + errorText(err));
    }
  }

  function onDragStart(e) {
    e.preventDefault();
    stop();
    window.api.startDrag(filePath);
  }

  return (
    <div className="saved">
      <div className="saved-status">
        <CheckIcon />
        <span>{status}</span>
      </div>

      <div className="drop-zone">
        <div
          className={`file-card ${editing ? 'editing' : ''}`}
          draggable={!editing}
          onDragStart={onDragStart}
          title={editing ? undefined : 'Drag into any chat, email or folder'}
        >
          <span className="grip" aria-hidden>
            <GripIcon />
          </span>
          <span className="file-badge">{ext.toUpperCase()}</span>
          <div className="file-info">
            <div className="file-name-row">
              <input
                ref={inputRef}
                className="file-name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => setEditing(true)}
                onBlur={() => editing && commitName()}
                onKeyDown={onNameKey}
                spellCheck={false}
                aria-label="File name"
                title="Click to rename"
              />
              <span className="file-ext">.{ext}</span>
              <span className="rename-hint" aria-hidden>
                <PencilIcon />
              </span>
            </div>
            <div className="file-meta">
              {formatTime(end - start)} · {formatSize(size)}
            </div>
          </div>
          <button
            className="card-play"
            onClick={togglePlay}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="card-progress" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="drop-hint">Drag the file into any chat, email or folder</div>
      </div>

      <div className="saved-actions">
        <button className="action-btn" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy file'}
        </button>
        <button className="action-btn" onClick={() => window.api.showInFolder(filePath)}>
          <FolderIcon />
          Show in folder
        </button>
        <button className="action-btn crop" onClick={() => (stop(), onCrop())}>
          <CropIcon />
          Crop
        </button>
        <button className="action-btn new" onClick={() => (stop(), onNew())}>
          <PlusIcon />
          New recording
        </button>
      </div>

      <div className="saved-foot">
        <button className="ghost danger small" onClick={remove}>
          Delete recording
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
