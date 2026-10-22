// End-to-end test of Recdrop, driven over the Chrome DevTools Protocol.
// Plays test tones through the speakers, records them and checks the whole flow:
// auto-save → Saved screen (clipboard, rename, play, copy, drag) → crop (replaces the file) → delete.
//
//   node tests/e2e-installed.mjs                         → tests the installed app
//   APP_DIR=release/win-unpacked node tests/...          → tests a fresh build before installing
//   APP_DIR=dev node tests/...                           → tests the project as it is (run `npm run build` first)
//   SCENARIO=defaultfolder node tests/...                → no folder set yet → saves to Music\Recdrop
//   SCENARIO=savefail node tests/...                     → save folder unusable → editor opens so nothing is lost
//
// Uses its own test profile and output folder (in %TEMP%), so your settings and recordings are untouched.
// Note: it uses the clipboard (copy-file checks).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(os.tmpdir(), 'recdrop-e2e');
fs.mkdirSync(HERE, { recursive: true });
const DEV = process.env.APP_DIR === 'dev';
const APP_DIR = DEV ? PROJECT : path.resolve(process.env.APP_DIR || path.join(process.env.LOCALAPPDATA, 'Programs', 'Recdrop'));
const EXE = DEV ? path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(APP_DIR, 'Recdrop.exe');
const FFMPEG = DEV
  ? path.join(PROJECT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  : path.join(APP_DIR, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = path.join(HERE, 'out');
const UD = path.join(HERE, 'userdata');
const PORT = 9333;
const SCENARIO = process.env.SCENARIO || 'main';

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok: !!ok });
  log(ok ? 'PASS' : 'FAIL', name, info);
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });
const MUSIC_DIR = path.join(os.homedir(), 'Music', 'Recdrop');
const musicDirExisted = fs.existsSync(MUSIC_DIR);
const musicBefore = new Set(musicDirExisted ? fs.readdirSync(MUSIC_DIR) : []);
if (SCENARIO === 'main') fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ saveDir: OUT }));
if (SCENARIO === 'savefail') fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ saveDir: 'Q:\\no-such-drive\\x' }));

// Test tone: L 1 kHz, R 3 kHz, 3 s
const tone = path.join(HERE, 'tone.wav');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'sine=f=1000:d=3:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=f=3000:d=3:sample_rate=48000',
  '-filter_complex', '[0]volume=0.3[l];[1]volume=0.3[r];[l][r]join=inputs=2:channel_layout=stereo[o]', '-map', '[o]', tone]);

const isTmpWav = (f) => /^recdrop-\d+\.wav$/.test(f);
const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter(isTmpWav));

const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`];
const proc = spawn(EXE, DEV ? [PROJECT, ...args] : args, { stdio: 'ignore' });
let exited = false;
proc.on('exit', (c) => { exited = true; log('app exited, code', c); });

// ---- CDP plumbing ----
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) { log('no page target'); proc.kill(); process.exit(1); }
log('app:', EXE);
check('app launches and opens a window', true, target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
const dialogs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  // console.error from expected failures (save-fail scenario) is fine; exceptions never are.
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error' && SCENARIO !== 'savefail')
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('EXCEPTION ' + m.params.exceptionDetails.exception?.description);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message);
    send('Page.handleJavaScriptDialog', { accept: true });
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
}
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
}
async function waitFor(expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(100); }
  return false;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(HERE, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const playTone = () => new Promise((res) => spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${tone}').PlaySync()`], { windowsHide: true }).on('exit', res));
const setVal = (sel, proto, v) => js(`(() => { const el = document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(${proto}.prototype,'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
const clickText = (sel, re) => js(`[...document.querySelectorAll('${sel}')].find(b => ${re}.test(b.textContent)).click()`);
const text = (sel) => js(`document.querySelector('${sel}')?.textContent ?? null`);
const clipboardFile = () => spawnSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList()']).stdout.toString().trim();
const info = (file) => spawnSync(FFMPEG, ['-hide_banner', '-i', file]).stderr.toString();
const durOf = (file) => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(info(file)); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };
const band = (file, ch, f) => Number(/mean_volume: ([-\d.]+)/.exec(spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', `pan=mono|c0=c${ch},bandpass=f=${f}:width_type=q:w=20,volumedetect`, '-f', 'null', '-']).stderr.toString())?.[1] ?? -99);
const toneOk = (file) => {
  const L1 = band(file, 0, 1000), R3 = band(file, 1, 3000), L3 = band(file, 0, 3000), R1 = band(file, 1, 1000);
  // Each tone must be clearly louder on its own side (a mono capture would show ~0 dB difference).
  // Not stricter, because other sounds playing on the PC during the test leak into both sides.
  return [L1 > -40 && R3 > -40 && L3 < L1 - 6 && R1 < R3 - 6, `L1k=${L1} R3k=${R3} L3k=${L3} R1k=${R1}`];
};
const outFiles = () => fs.readdirSync(OUT).sort();

await send('Runtime.enable');
await send('Page.enable');
await waitFor(`!!document.querySelector('.record-btn')`);
await sleep(500);

// Records (tone, or silence for `ms`) and waits for the next screen.
async function record(ms = 0) {
  await js(`document.querySelector('.record-btn').click()`);
  await waitFor(`!!document.querySelector('.record-btn.is-recording')`);
  await sleep(300);
  if (ms) await sleep(ms);
  else await playTone();
  await sleep(300);
  await js(`document.querySelector('.record-btn').click()`);
  return waitFor(`!!document.querySelector('.saved') || !!document.querySelector('.editor')`, 30000);
}
const savedPath = async () => {
  const name = await js(`document.querySelector('.file-name').value + document.querySelector('.file-ext').textContent`);
  return path.join(await js(`window.api.getSettings().then(s => s.saveDir)`), name);
};

async function rename(newName) {
  await js(`document.querySelector('.file-name').focus()`);
  await setVal('.file-name', 'HTMLInputElement', newName);
  await js(`document.querySelector('.file-name').blur()`);
  await sleep(600);
}

async function dragStartHandle(toFraction) {
  const r = await js(`(() => { const b = document.querySelector('.handle[data-handle="start"]').getBoundingClientRect(); const w = document.querySelector('.wave').getBoundingClientRect(); return {hx:b.left+b.width/2, hy:b.top+b.height/2, wx:w.left, ww:w.width}; })()`);
  await mouse('mousePressed', r.hx, r.hy);
  await mouse('mouseMoved', r.wx + r.ww * toFraction * 0.5, r.hy);
  await mouse('mouseMoved', r.wx + r.ww * toFraction, r.hy);
  await mouse('mouseReleased', r.wx + r.ww * toFraction, r.hy);
  await sleep(200);
}

if (SCENARIO === 'main') {
  await shot('01-start');

  // 1) Stop → saved automatically as MP3 and copied to the clipboard
  check('record → Saved screen opens (no editor)', (await record()) && (await js(`!!document.querySelector('.saved')`)));
  await waitFor(`/clipboard/.test(document.querySelector('.saved-status').textContent)`, 8000);
  await shot('02-saved');
  const status = await text('.saved-status');
  check('status says saved as MP3 + copied', /Saved as MP3/.test(status) && /clipboard/.test(status), status);
  let files = outFiles();
  check('exactly one file saved automatically', files.length === 1 && /^Recording \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.mp3$/.test(files[0]), files.join(', '));
  let p = path.join(OUT, files[0]);
  check('auto-saved MP3 is 320 kbps stereo', /mp3.*stereo.*320 kb\/s/.test(info(p)));
  const [okTone, toneInfo] = toneOk(p);
  check('auto-saved file contains the test tone (stereo)', okTone, toneInfo);
  check('file is on the clipboard', clipboardFile().toLowerCase() === p.toLowerCase(), clipboardFile());
  const meta = await text('.file-meta');
  check('card shows length and size', /^00:0[3-5] · \d+(\.\d)? (KB|MB)$/.test(meta), meta);
  check('card shows MP3 badge', (await text('.file-badge')) === 'MP3');

  // 2) Play / pause
  await js(`document.querySelector('.card-play').click()`);
  await sleep(700);
  const prog = await js(`parseFloat(document.querySelector('.card-progress').style.width)`);
  check('play moves the progress bar', prog > 5, `${prog}%`);
  await js(`document.querySelector('.card-play').click()`);

  // 3) Rename → renames the file (no copy), clipboard follows
  await rename('e2e test');
  files = outFiles();
  check('rename renames the file in place', files.length === 1 && files[0] === 'e2e test.mp3', files.join(', '));
  p = path.join(OUT, 'e2e test.mp3');
  await sleep(1500);
  check('clipboard updated after rename', clipboardFile().toLowerCase() === p.toLowerCase(), clipboardFile());

  // Name taken → error, nothing changes
  fs.writeFileSync(path.join(OUT, 'taken.mp3'), 'x');
  await rename('taken');
  const err = await text('.saved-foot .error-text');
  check('renaming to an existing name shows an error', /already exists/.test(err || ''), err);
  check('…and keeps the file + name', fs.existsSync(p) && (await js(`document.querySelector('.file-name').value`)) === 'e2e test');
  fs.rmSync(path.join(OUT, 'taken.mp3'));

  // Invalid characters are removed; Escape cancels
  await rename('e2e: test?');
  check('invalid characters removed on rename', fs.existsSync(path.join(OUT, 'e2e test.mp3')) && (await text('.saved-foot .error-text')) === null);
  await js(`document.querySelector('.file-name').focus()`);
  await setVal('.file-name', 'HTMLInputElement', 'should not apply');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  check('Escape cancels renaming', outFiles().join() === 'e2e test.mp3' && (await js(`document.querySelector('.file-name').value`)) === 'e2e test');

  // 4) Copy file button
  await spawnSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value x']);
  await clickText('.action-btn', /Copy file/);
  await waitFor(`/Copied/.test(document.querySelector('.saved-actions').textContent)`, 5000);
  check('Copy file puts the file on the clipboard', clipboardFile().toLowerCase() === p.toLowerCase(), clipboardFile());

  // 5) Drag out: starting a drag must not freeze or crash the app
  await js(`document.querySelector('.file-card').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
  await sleep(800);
  check('starting a drag keeps the app responsive', (await js(`1 + 1`)) === 2);

  // 6) Crop → replaces the same file
  const fullDur = durOf(p);
  await clickText('.action-btn', /Crop/);
  check('Crop opens the editor', await waitFor(`!!document.querySelector('.editor')`, 3000));
  check('Save crop disabled until something changes', await js(`document.querySelector('.save-row .primary').disabled`));
  check('editor says it replaces the file', /Replaces e2e test\.mp3/.test(await text('.save-note')));
  await dragStartHandle(0.3);
  await shot('03-crop');
  await js(`document.querySelector('.save-row .primary').click()`);
  check('Save crop returns to Saved screen', await waitFor(`!!document.querySelector('.saved')`, 20000));
  files = outFiles();
  const cropDur = durOf(p);
  check('crop replaced the file (no copy)', files.join() === 'e2e test.mp3', files.join(', '));
  check('cropped file is shorter', cropDur < fullDur - 0.5, `${fullDur}s → ${cropDur}s`);
  check('status says cropped', /Cropped/.test(await text('.saved-status')), await text('.saved-status'));

  // Crop again: widen back to the full recording (original audio is kept in memory) and switch to WAV
  await clickText('.action-btn', /Crop/);
  await waitFor(`!!document.querySelector('.editor')`, 3000);
  await clickText('.transport button', /Reset/);
  await setVal('select', 'HTMLSelectElement', 'wav');
  await js(`document.querySelector('.save-row .primary').click()`);
  await waitFor(`!!document.querySelector('.saved')`, 20000);
  files = outFiles();
  const wav = path.join(OUT, 'e2e test.wav');
  check('format change replaces .mp3 with .wav', files.join() === 'e2e test.wav', files.join(', '));
  check('un-crop restores full length', Math.abs(durOf(wav) - fullDur) < 0.15, `${durOf(wav)}s vs ${fullDur}s`);
  check('badge shows WAV', (await text('.file-badge')) === 'WAV');
  check('WAV still has the tone', toneOk(wav)[0], toneOk(wav)[1]);

  // Cancel crop changes nothing
  await clickText('.action-btn', /Crop/);
  await waitFor(`!!document.querySelector('.editor')`, 3000);
  await dragStartHandle(0.5);
  await clickText('.editor-foot button', /Cancel/);
  await waitFor(`!!document.querySelector('.saved')`, 3000);
  check('Cancel crop leaves the file unchanged', Math.abs(durOf(wav) - fullDur) < 0.15 && outFiles().join() === 'e2e test.wav');

  // 7) New recording keeps the file
  await clickText('.action-btn', /New recording/);
  check('New recording → recorder screen', await waitFor(`!!document.querySelector('.record-btn') && !document.querySelector('.saved')`, 3000));
  check('previous file kept', fs.existsSync(wav));

  // 8) Second recording → Delete moves it to the Recycle Bin
  check('second recording saved', await record(1500));
  const second = await savedPath();
  check('second file exists', fs.existsSync(second), second);
  dialogs.length = 0;
  // Answer the confirmation from inside the page (a native dialog can stall the DevTools connection).
  await js(`window.confirm = (m) => (window.__lastConfirm = m, true)`);
  await clickText('.saved-foot button', /Delete/);
  dialogs.push(await js(`window.__lastConfirm`));
  check('delete asks first', await waitFor(`!!document.querySelector('.record-btn')`, 5000) && /Recycle Bin/.test(dialogs[0] || ''), dialogs[0]);
  check('deleted file is gone from the folder', !fs.existsSync(second));
  const bin = spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ? { $_.Name -like '${path.parse(second).name}*' } | % Name`]).stdout.toString();
  check('…and is in the Recycle Bin', bin.trim().length > 0, bin.trim());
  check('recorder shows "moved to Recycle Bin"', /Recycle Bin/.test((await text('.toast')) || ''));
  // Clean the test file out of the Recycle Bin again
  spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ? { $_.Name -like '${path.parse(second).name}*' } | % { Remove-Item -LiteralPath $_.Path -Force }`]);

  // 9) Options shows the folder
  await js(`document.querySelector('.icon-btn').click()`);
  await waitFor(`!!document.querySelector('.modal')`, 3000);
  check('Options shows the save folder', (await text('.folder-path')) === OUT, await text('.folder-path'));
  await js(`document.querySelector('.modal .primary').click()`);

  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => isTmpWav(f) && !tmpBefore.has(f));
  check('temp files cleaned up', tmpAfter.length === 0 && !fs.readdirSync(OUT).some((f) => f.startsWith('.recdrop-')), tmpAfter.join(','));
} else if (SCENARIO === 'defaultfolder') {
  check('record → Saved screen', (await record(1500)) && (await js(`!!document.querySelector('.saved')`)));
  const p = await savedPath();
  check('saved into Music\\Recdrop', p.toLowerCase().startsWith(MUSIC_DIR.toLowerCase()) && fs.existsSync(p), p);
  // Clean up only what the test created
  fs.rmSync(p, { force: true });
  if (!musicDirExisted && fs.readdirSync(MUSIC_DIR).length === 0) fs.rmdirSync(MUSIC_DIR);
} else if (SCENARIO === 'savefail') {
  check('save fails → editor opens instead (recording kept)', (await record(1500)) && (await js(`!!document.querySelector('.editor')`)));
  const err = await text('.editor-foot .error-text');
  check('editor explains the automatic save failed', /Automatic save failed/.test(err || ''), err);
  check('editor offers name + Save + Discard', await js(`!!document.querySelector('.name-input') && /Discard/.test(document.querySelector('.editor-foot').textContent)`));
  await clickText('.editor-foot button', /Discard/);
  check('Discard returns to recorder', await waitFor(`!!document.querySelector('.record-btn')`, 3000));
}

check('no errors in the app', consoleErrors.length === 0, consoleErrors.join(' || '));

await js(`window.close()`).catch(() => {});
for (let i = 0; i < 50 && !exited; i++) await sleep(100);
check('closing the window exits the app', exited);
if (!exited) proc.kill();

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
