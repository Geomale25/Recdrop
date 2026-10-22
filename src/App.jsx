import { useState } from 'react';
import Recorder from './components/Recorder.jsx';
import Editor from './components/Editor.jsx';
import Settings from './components/Settings.jsx';
import { GearIcon } from './components/Icons.jsx';

export default function App() {
  const [buffer, setBuffer] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState(null);

  function handleSaved(filePath) {
    setNotice({ filePath, fileName: filePath.split(/[\\/]/).pop() });
    setBuffer(null);
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="dot" />
          Sound Recorder
        </div>
        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Options">
          <GearIcon />
        </button>
      </header>

      <main className="content">
        {buffer ? (
          <Editor buffer={buffer} onSaved={handleSaved} onDiscard={() => setBuffer(null)} />
        ) : (
          <Recorder onRecorded={setBuffer} notice={notice} onDismissNotice={() => setNotice(null)} />
        )}
      </main>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
