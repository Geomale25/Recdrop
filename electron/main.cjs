const { app, BrowserWindow, ipcMain, dialog, shell, session, desktopCapturer, nativeImage } = require('electron');
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

// The app used to be called "Sound Recorder". Bring its settings (save folder) over once.
function migrateOldSettings() {
  const appData = app.getPath('appData');
  if (app.getPath('userData') !== path.join(appData, 'Recdrop')) return; // custom profile (e.g. tests)
  const oldFile = path.join(appData, 'Sound Recorder', 'settings.json');
  if (fs.existsSync(settingsPath()) || !fs.existsSync(oldFile)) return;
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.copyFileSync(oldFile, settingsPath());
  } catch {}
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

// Where recordings go. If none is set yet (or the folder was deleted), use Music\Recdrop.
function saveDir() {
  const dir = readSettings().saveDir || path.join(app.getPath('music'), 'Recdrop');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    throw new Error(`The save folder "${dir}" isn't available. Choose another folder in Options (gear icon), then save.`);
  }
  if (readSettings().saveDir !== dir) writeSettings({ saveDir: dir });
  return dir;
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
    title: 'Recdrop',
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
  migrateOldSettings();

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
ipcMain.handle('settings:get', () => ({ ...readSettings(), saveDir: saveDir() }));

ipcMain.handle('settings:chooseFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const dir = await pickFolder(win, 'Choose where to save your recordings');
  if (!dir) return readSettings();
  return writeSettings({ saveDir: dir });
});

ipcMain.handle('file:showInFolder', (_e, filePath) => shell.showItemInFolder(filePath));

// Saves audio (sent as WAV) as MP3 / MP4 / WAV.
// With `replacePath`, the new file replaces that one (same name; extension follows the format).
ipcMain.handle('file:save', async (_e, { wavBuffer, name, format, replacePath }) => {
  const ext = ['mp3', 'mp4', 'wav'].includes(format) ? format : 'mp3';
  let outPath;
  if (replacePath) {
    const { dir, name: base } = path.parse(replacePath);
    outPath = path.join(dir, `${base}.${ext}`);
    if (!samePath(outPath, replacePath) && fs.existsSync(outPath)) outPath = uniquePath(dir, base, ext);
  } else {
    outPath = uniquePath(saveDir(), cleanName(name) || defaultName(), ext);
  }

  // Write to a temp file first, then move it into place, so a failed save never destroys the old file.
  const tmpOut = path.join(path.dirname(outPath), `.recdrop-${Date.now()}.${ext}`);
  const wav = Buffer.from(wavBuffer);
  try {
    if (ext === 'wav') {
      fs.writeFileSync(tmpOut, wav);
    } else {
      const tmp = path.join(os.tmpdir(), `recdrop-${Date.now()}.wav`);
      fs.writeFileSync(tmp, wav);
      try {
        const codec =
          ext === 'mp3'
            ? ['-c:a', 'libmp3lame', '-b:a', '320k'] // highest MP3 quality
            : ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'];
        await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', ...codec, '-f', ext, tmpOut]);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    fs.renameSync(tmpOut, outPath);
  } catch (err) {
    fs.rmSync(tmpOut, { force: true });
    if (err.code === 'EBUSY' || err.code === 'EPERM') throw new Error('The file is open in another program. Close it and try again.');
    throw err;
  }
  if (replacePath && !samePath(outPath, replacePath)) fs.rmSync(replacePath, { force: true });

  cacheIcon(outPath);
  return { canceled: false, filePath: outPath, size: fs.statSync(outPath).size };
});

// Renames a saved file in place (keeps its extension). Never overwrites another file.
ipcMain.handle('file:rename', (_e, { filePath, name }) => {
  const base = cleanName(name);
  if (!base) throw new Error('Please enter a file name.');
  const { dir, ext } = path.parse(filePath);
  const target = path.join(dir, base + ext);
  if (target === filePath) return { filePath };
  // A different file already has that name (a case-only change is fine).
  if (fs.existsSync(target) && !samePath(target, filePath)) throw new Error(`"${base}${ext}" already exists.`);
  try {
    fs.renameSync(filePath, target);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') throw new Error('The file is open in another program. Close it and try again.');
    throw err;
  }
  cacheIcon(target);
  return { filePath: target };
});

// Moves a file to the Recycle Bin (recoverable).
ipcMain.handle('file:trash', (_e, filePath) => shell.trashItem(filePath));

// Puts the file itself on the clipboard, like Ctrl+C in Explorer, so it can be pasted into chats, emails or folders.
ipcMain.handle('file:copy', (_e, filePath) => {
  if (process.platform !== 'win32') {
    require('electron').clipboard.writeText(filePath);
    return;
  }
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // File drop list, like Explorer's Ctrl+C. Retries if another program is holding the clipboard.
        'Add-Type -AssemblyName System.Windows.Forms;' +
          '$c = New-Object System.Collections.Specialized.StringCollection; [void]$c.Add($env:RECDROP_COPY);' +
          '$d = New-Object System.Windows.Forms.DataObject; $d.SetFileDropList($c);' +
          '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true, 10, 100)',
      ],
      { windowsHide: true, env: { ...process.env, RECDROP_COPY: filePath } },
      (err) => (err ? reject(new Error('Could not copy the file.')) : resolve())
    );
  });
});

// Drag the file out of the app into Explorer, a chat, an email…
const fileIcons = new Map();
const fallbackIcon = nativeImage.createFromPath(path.join(__dirname, 'drag-icon.png'));
function cacheIcon(filePath) {
  app.getFileIcon(filePath, { size: 'normal' }).then((img) => fileIcons.set(filePath, img)).catch(() => {});
}
ipcMain.on('file:startDrag', (e, filePath) => {
  if (!fs.existsSync(filePath)) return;
  const icon = fileIcons.get(filePath);
  e.sender.startDrag({ file: filePath, icon: icon && !icon.isEmpty() ? icon : fallbackIcon });
});

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
