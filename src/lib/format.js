export function formatTime(sec, withTenths = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withTenths ? `${base}.${Math.floor((sec * 10) % 10)}` : base;
}

export function autoName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Errors from the desktop side arrive as "Error invoking remote method 'x': Error: message".
export function errorText(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}
