import { useEffect, useState } from 'react';
import { FolderIcon } from './Icons.jsx';

export default function Settings({ onClose }) {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    window.api.getSettings().then(setSettings);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function change() {
    setSettings(await window.api.chooseFolder());
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Settings">
        <h3>Options</h3>

        <label className="field-label">Save location</label>
        <div className="folder-row">
          <FolderIcon />
          <span className="folder-path" title={settings?.saveDir || ''}>
            {settings?.saveDir || 'Not set yet. You’ll be asked the first time you save.'}
          </span>
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={change}>
            {settings?.saveDir ? 'Change folder…' : 'Choose folder…'}
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
