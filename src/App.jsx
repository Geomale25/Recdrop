import { useState } from 'react';
import Recorder from './components/Recorder.jsx';
import Editor from './components/Editor.jsx';
import Saved from './components/Saved.jsx';
import Settings from './components/Settings.jsx';
import { GearIcon } from './components/Icons.jsx';
import { encodeWav } from './lib/wav.js';
import { autoName, errorText } from './lib/format.js';

// Screens: recorder → (stop) auto-save → saved ⇄ crop.
// If the automatic save fails, the editor opens in "new" mode so the recording isn't lost.
export default function App() {
  const [screen, setScreen] = useState('recorder'); // recorder | saved | crop | unsaved
  // The recording in memory (lossless) + the part of it that's in the saved file.
  const [clip, setClip] = useState(null); // { buffer, start, end, filePath, size }
  const [status, setStatus] = useState(''); // message on the Saved screen
  const [notice, setNotice] = useState(''); // message on the Recorder screen
  const [showSettings, setShowSettings] = useState(false);

  // Copying runs in the background; the Saved screen shows the result.
  function copyToClipboard(filePath) {
    return window.api.copyFile(filePath).then(
      () => true,
      () => false
    );
  }

  // Called by the Recorder when recording stops. Throws on failure so the Recorder can show it.
  async function handleRecorded(buffer) {
    const base = { buffer, start: 0, end: buffer.duration };
    try {
      const wavBuffer = encodeWav(buffer, 0, buffer.duration);
      const res = await window.api.saveFile({ wavBuffer, name: autoName(), format: 'mp3' });
      setClip({ ...base, filePath: res.filePath, size: res.size });
      setScreen('saved');
      setStatus('Saved as MP3');
      const copied = await copyToClipboard(res.filePath);
      setStatus(copied ? 'Saved as MP3 · copied to clipboard' : 'Saved as MP3');
    } catch (err) {
      console.error(err);
      setClip({ ...base, filePath: null });
      setScreen('unsaved');
      setNotice('');
      setStatus('Automatic save failed: ' + errorText(err));
    }
  }

  // Crop editor saved: the cropped audio replaced the file.
  async function handleCropSaved({ start, end, filePath, size, format }) {
    setClip((c) => ({ ...c, start, end, filePath, size }));
    setScreen('saved');
    const label = `Cropped · saved as ${format.toUpperCase()}`;
    setStatus(label);
    const copied = await copyToClipboard(filePath);
    if (copied) setStatus(label + ' · copied to clipboard');
  }

  // "Unsaved" editor (fallback) saved a new file.
  function handleManualSaved({ start, end, filePath, size, format }) {
    setClip((c) => ({ ...c, start, end, filePath, size }));
    setScreen('saved');
    setStatus(`Saved as ${format.toUpperCase()}`);
    copyToClipboard(filePath);
  }

  function newRecording(message = '') {
    setClip(null);
    setStatus('');
    setNotice(message);
    setScreen('recorder');
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="dot" />
          Recdrop
        </div>
        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Options">
          <GearIcon />
        </button>
      </header>

      <main className="content">
        {screen === 'recorder' && (
          <Recorder onRecorded={handleRecorded} notice={notice} onDismissNotice={() => setNotice('')} />
        )}
        {screen === 'saved' && clip && (
          <Saved
            clip={clip}
            status={status}
            onRenamed={(filePath) => setClip((c) => ({ ...c, filePath }))}
            onCopy={(filePath) => copyToClipboard(filePath)}
            onCrop={() => setScreen('crop')}
            onNew={() => newRecording()}
            onDeleted={() => newRecording('Recording moved to the Recycle Bin')}
          />
        )}
        {screen === 'crop' && clip && (
          <Editor
            mode="crop"
            clip={clip}
            onSaved={handleCropSaved}
            onCancel={() => setScreen('saved')}
          />
        )}
        {screen === 'unsaved' && clip && (
          <Editor
            mode="new"
            clip={clip}
            initialError={status}
            onSaved={handleManualSaved}
            onCancel={() => newRecording()}
          />
        )}
      </main>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
