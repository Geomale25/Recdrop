import { useEffect, useRef, useState } from 'react';
import { startRecording } from '../lib/recorder.js';
import { formatTime } from '../lib/format.js';
import { MicIcon, MicOffIcon } from './Icons.jsx';

const BARS = 48;

export default function Recorder({ onRecorded, notice, onDismissNotice }) {
  const [status, setStatus] = useState('idle'); // idle | starting | recording | processing
  const [micOn, setMicOn] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState(() => Array(BARS).fill(0));
  const [error, setError] = useState('');

  const session = useRef(null);
  const startedAt = useRef(0);
  const raf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  function tick() {
    const s = session.current;
    if (!s) return;
    setElapsed((performance.now() - startedAt.current) / 1000);
    const level = s.getLevel();
    setLevels((prev) => [...prev.slice(1), level]);
    raf.current = requestAnimationFrame(tick);
  }

  async function start() {
    setError('');
    onDismissNotice?.();
    setStatus('starting');
    try {
      const s = await startRecording({ micOn });
      if (s.micError) {
        setMicOn(false);
        setError('Microphone unavailable — recording system audio only.');
      }
      session.current = s;
      startedAt.current = performance.now();
      setLevels(Array(BARS).fill(0));
      setStatus('recording');
      raf.current = requestAnimationFrame(tick);
    } catch (err) {
      console.error(err);
      setStatus('idle');
      setError('Could not start recording: ' + (err?.message || err));
    }
  }

  async function stop() {
    cancelAnimationFrame(raf.current);
    const s = session.current;
    session.current = null;
    setStatus('processing');
    try {
      const buffer = await s.stop();
      await onRecorded(buffer); // saves the file and switches to the Saved screen
    } catch (err) {
      console.error(err);
      setStatus('idle');
      setError('Could not process the recording: ' + (err?.message || err));
    }
  }

  async function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    if (session.current) {
      try {
        await session.current.setMicOn(next);
        setError('');
      } catch (err) {
        console.error(err);
        setMicOn(false);
        setError('Could not turn on the microphone. Check Windows microphone privacy settings.');
      }
    }
  }

  const recording = status === 'recording';
  const busy = status === 'starting' || status === 'processing';

  return (
    <div className="recorder">
      <div className={`timer ${recording ? 'live' : ''}`}>{formatTime(elapsed)}</div>

      <div className="meter" aria-hidden>
        {levels.map((l, i) => (
          <span key={i} style={{ height: `${Math.max(4, l * 100)}%`, opacity: recording ? 1 : 0.35 }} />
        ))}
      </div>

      <div className="controls">
        <div className="side-slot" />
        <button
          className={`record-btn ${recording ? 'is-recording' : ''}`}
          onClick={recording ? stop : start}
          disabled={busy}
          aria-label={recording ? 'Stop recording' : 'Start recording'}
          title={recording ? 'Stop' : 'Record'}
        >
          <span className="record-shape" />
        </button>
        <div className="side-slot">
          <button
            className={`mic-btn ${micOn ? 'on' : ''}`}
            onClick={toggleMic}
            disabled={busy}
            title={micOn ? 'Mute microphone' : 'Unmute microphone'}
            aria-pressed={micOn}
          >
            {micOn ? <MicIcon /> : <MicOffIcon />}
          </button>
        </div>
      </div>

      <div className="hint">
        {status === 'idle' && 'Click to record everything playing on your computer'}
        {status === 'starting' && 'Starting…'}
        {status === 'recording' && (micOn ? 'Recording system audio + microphone' : 'Recording system audio · mic muted')}
        {status === 'processing' && 'Saving…'}
      </div>

      {error && <div className="toast error">{error}</div>}
      {notice && !error && (
        <div className="toast">
          <span>{notice}</span>
          <button className="link muted" onClick={onDismissNotice} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
