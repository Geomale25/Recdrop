const { app, BrowserWindow, ipcMain, dialog, shell, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// ---------- Settings (stored as JSON in the app's user data folder) ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

// ---------- ffmpeg (bundled, used for MP3 / MP4 encoding) ----------
function ffmpegPath() {
  // Inside the packaged app the binary lives in app.asar.unpacked.
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().split('\n').slice(-5).join('\n') || err.message));
      else resolve();
    });
  });
}

// ---------- File name helpers ----------
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function cleanName(name) {
  return (name || '').replace(INVALID_CHARS, '').replace(/[. ]+$/, '').trim().slice(0, 150);
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i}).${ext}`);
    i++;
  }
  return candidate;
}

async function pickFolder(win, title) {
  const res = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: readSettings().saveDir || app.getPath('music'),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

// ---------- Window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 560,
    minHeight: 460,
    backgroundColor: '#0e0f13',
    title: 'Sound Recorder',
    // build/ isn't packaged; the installed app uses the icon embedded in the .exe instead.
    icon: isDev ? path.join(__dirname, '..', 'build', 'icon.png') : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f13', symbolColor: '#c9ccd6', height: 36 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  // Allow microphone access for our own window.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'display-capture');
  });

  // getDisplayMedia() in the renderer → capture the whole system's audio (loopback).
  // A screen source is required by Chromium, but the renderer drops the video track.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:chooseFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const dir = await pickFolder(win, 'Choose where to save your recordings');
  if (!dir) return readSettings();
  return writeSettings({ saveDir: dir });
});

ipcMain.handle('file:showInFolder', (_e, filePath) => shell.showItemInFolder(filePath));

ipcMain.handle('file:save', async (e, { wavBuffer, name, format }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  let { saveDir } = readSettings();

  // First save (or folder was deleted): ask once, then remember it.
  if (!saveDir || !fs.existsSync(saveDir)) {
    saveDir = await pickFolder(win, 'Choose where to save your recordings');
    if (!saveDir) return { canceled: true };
    writeSettings({ saveDir });
  }

  const ext = ['mp3', 'mp4', 'wav'].includes(format) ? format : 'mp3';
  const base = cleanName(name) || defaultName();
  const outPath = uniquePath(saveDir, base, ext);
  const wav = Buffer.from(wavBuffer);

  if (ext === 'wav') {
    fs.writeFileSync(outPath, wav);
  } else {
    const tmp = path.join(os.tmpdir(), `sound-recorder-${Date.now()}.wav`);
    fs.writeFileSync(tmp, wav);
    try {
      const codec =
        ext === 'mp3'
          ? ['-c:a', 'libmp3lame', '-b:a', '320k'] // highest MP3 quality
          : ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'];
      await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', ...codec, outPath]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  return { canceled: false, filePath: outPath };
});

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
