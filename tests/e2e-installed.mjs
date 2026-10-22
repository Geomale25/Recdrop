// End-to-end test of the packaged Sound Recorder app, driven over the Chrome DevTools Protocol.
// Records test tones played through the speakers, crops, saves MP3/MP4/WAV and checks the files.
//
//   node tests/e2e-installed.mjs                         → tests the installed app
//   APP_DIR=release/win-unpacked node tests/...          → tests a fresh build before installing
//   SCENARIO=firstsave node tests/...                    → checks the "choose folder" prompt on first save
//
// Uses its own test profile and output folder (in %TEMP%), so your settings and recordings are untouched.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HERE = path.join(os.tmpdir(), 'sound-recorder-e2e');
fs.mkdirSync(HERE, { recursive: true });
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(process.env.LOCALAPPDATA, 'Programs', 'Sound Recorder'));
const EXE = path.join(APP_DIR, 'Sound Recorder.exe');
const FFMPEG = path.join(APP_DIR, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = path.join(HERE, 'out');
const UD = path.join(HERE, 'userdata');
const PORT = 9333;
const SCENARIO = process.env.SCENARIO || 'main';

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); log(ok ? 'PASS' : 'FAIL', name, info); };

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(UD, { recursive: true, force: true }); fs.mkdirSync(UD, { recursive: true });
if (SCENARIO === 'main') fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ saveDir: OUT }));

// Test tone: L 1 kHz, R 3 kHz, 3 s
const tone = path.join(HERE, 'tone.wav');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'sine=f=1000:d=3:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=f=3000:d=3:sample_rate=48000',
  '-filter_complex', '[0]volume=0.3[l];[1]volume=0.3[r];[l][r]join=inputs=2:channel_layout=stereo[o]', '-map', '[o]', tone]);

const isTmpWav = (f) => /^sound-recorder-\d+\.wav$/.test(f);
const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter(isTmpWav));

const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { stdio: 'ignore' });
let exited = false; proc.on('exit', (c) => { exited = true; log('app exited, code', c); });

// ---- CDP plumbing ----
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) { log('no page target'); proc.kill(); process.exit(1); }
check('installed app launches and opens a window', true, target.url);
log('app:', EXE);
check('loads built UI from inside app.asar', /app\.asar[\\/]dist[\\/]index\.html$/.test(decodeURIComponent(target.url)), target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('EXCEPTION ' + m.params.exceptionDetails.exception?.description);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push('LOG ' + m.params.entry.text);
  if (m.method === 'Page.javascriptDialogOpening') { log('dialog:', m.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
});
function send(method, params = {}) {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
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
async function mouse(type, x, y) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
const playTone = () => new Promise((res) => spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${tone}').PlaySync()`], { windowsHide: true }).on('exit', res));
const setVal = (sel, proto, v) => js(`(() => { const el = document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(${proto}.prototype,'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await waitFor(`!!document.querySelector('.record-btn')`);
await sleep(500);
await shot('01-start');

async function record(ms = 0) {
  await js(`document.querySelector('.record-btn').click()`);
  const started = await waitFor(`!!document.querySelector('.record-btn.is-recording')`);
  await sleep(300);
  if (ms) await sleep(ms); else await playTone();
  await sleep(300);
  await js(`document.querySelector('.record-btn').click()`);
  const editor = await waitFor(`!!document.querySelector('.editor')`);
  return started && editor;
}

async function saveAs(format, name) {
  await setVal('select', 'HTMLSelectElement', format);
  await setVal('.name-input', 'HTMLInputElement', name);
  await sleep(100);
  await js(`document.querySelector('.save-row .primary').click()`);
  await waitFor(`!!document.querySelector('.toast.success') || !!document.querySelector('.error-text')`, 30000);
  return js(`(document.querySelector('.toast.success')||document.querySelector('.error-text')).textContent`);
}

if (SCENARIO === 'firstsave') {
  // No save folder yet → the app should ask for one. We only check a folder dialog appears (main process), then quit.
  check('record works', await record(1500));
  await js(`document.querySelector('.save-row .primary').click()`);
  await sleep(2500);
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName UIAutomationClient; $r=[Windows.Automation.AutomationElement]::RootElement; $c=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, ${proc.pid}); $r.FindAll('Descendants',$c) | % { $_.Current.Name }`]).stdout.toString();
  log('windows/elements of app:', ps.split(/\r?\n/).filter(Boolean).slice(0, 15).join(' | '));
  check('first save opens a "choose folder" dialog', /Choose where to save/i.test(ps));
} else {
  // 1) Record, crop the first ~1 s, save MP3
  check('record #1 (system audio) → editor opens', await record());
  await shot('02-editor');
  const lenBefore = await js(`document.querySelectorAll('.times span')[2]?.textContent`);
  const r = await js(`(() => { const b = document.querySelector('.handle[data-handle="start"]').getBoundingClientRect(); const w = document.querySelector('.wave').getBoundingClientRect(); return {hx:b.left+b.width/2, hy:b.top+b.height/2, wx:w.left, ww:w.width}; })()`);
  await mouse('mousePressed', r.hx, r.hy); await mouse('mouseMoved', r.wx + r.ww * 0.15, r.hy); await mouse('mouseMoved', r.wx + r.ww * 0.3, r.hy); await mouse('mouseReleased', r.wx + r.ww * 0.3, r.hy);
  await sleep(200);
  const lenAfter = await js(`document.querySelectorAll('.times span')[2]?.textContent`);
  check('dragging start handle shortens selection', lenBefore !== lenAfter, `${lenBefore} → ${lenAfter}`);
  await js(`document.querySelector('.play-btn').click()`); await sleep(600); await js(`document.querySelector('.play-btn').click()`);
  let msg = await saveAs('mp3', 'e2e test');
  check('save MP3', /saved/i.test(msg), msg);
  await shot('03-saved');

  // 2) Record → MP4 with same name (tests duplicate naming + invalid chars)
  check('record #2', await record());
  msg = await saveAs('mp4', 'e2e test');
  check('save MP4', /saved/i.test(msg), msg);
  check('record #3', await record());
  msg = await saveAs('wav', 'e2e: test?');
  check('save WAV (invalid chars stripped)', /saved/i.test(msg), msg);
  check('record #4', await record());
  msg = await saveAs('mp3', 'e2e test');
  check('duplicate name saved as "(1)"', /saved/i.test(msg), msg);

  // 3) Auto name when empty
  check('record #5', await record(1500));
  msg = await saveAs('mp3', '');
  check('empty name → auto name', /saved/i.test(msg), msg);

  // 4) Discard
  check('record #6', await record(1000));
  await js(`[...document.querySelectorAll('.editor-foot button')].find(b=>/discard/i.test(b.textContent)).click()`);
  check('discard returns to recorder', await waitFor(`!!document.querySelector('.record-btn') && !document.querySelector('.editor')`, 3000));

  // 5) Mic toggle during recording
  await js(`document.querySelector('.record-btn').click()`);
  await waitFor(`!!document.querySelector('.record-btn.is-recording')`);
  await js(`document.querySelector('.mic-btn').click()`); await sleep(1200);
  const micState = await js(`document.querySelector('.mic-btn').className + ' | ' + (document.querySelector('.toast.error')?.textContent||'')`);
  check('mic toggle turns on without error', /\bon\b/.test(micState) && !/\|\s*\S/.test(micState), micState);
  await js(`document.querySelector('.mic-btn').click()`); await sleep(300);
  await js(`document.querySelector('.record-btn').click()`);
  await waitFor(`!!document.querySelector('.editor')`);
  await js(`[...document.querySelectorAll('.editor-foot button')].find(b=>/discard/i.test(b.textContent)).click()`);
  await sleep(300);

  // 6) Options window shows the folder
  await js(`document.querySelector('.icon-btn').click()`);
  await waitFor(`!!document.querySelector('.modal')`, 3000);
  const folder = await js(`document.querySelector('.folder-path')?.textContent`);
  check('options window shows save folder', folder === OUT, folder);
  await shot('04-options');
  await js(`document.querySelector('.modal .primary').click()`);

  // ---- Check output files ----
  const files = fs.readdirSync(OUT).sort();
  log('files:', files);
  const expect = ['e2e test.mp3', 'e2e test.mp4', 'e2e test.wav', 'e2e test (1).mp3'];
  for (const f of expect) check(`file exists: ${f}`, files.includes(f));
  check('auto-named file exists', files.some((f) => /^Recording \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.mp3$/.test(f)));
  const band = (file, ch, f) => Number(/mean_volume: ([-\d.]+)/.exec(spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', `pan=mono|c0=c${ch},bandpass=f=${f}:width_type=q:w=20,volumedetect`, '-f', 'null', '-']).stderr.toString())?.[1] ?? -99);
  const info = (file) => spawnSync(FFMPEG, ['-hide_banner', '-i', file]).stderr.toString();
  for (const f of files) {
    const p = path.join(OUT, f), i = info(p);
    const dur = /Duration: ([\d:.]+)/.exec(i)?.[1], stream = /Audio: [^\n]+/.exec(i)?.[0];
    log(f, '|', dur, '|', stream);
  }
  for (const f of expect) {
    const p = path.join(OUT, f);
    if (!fs.existsSync(p)) continue;
    const i = info(p);
    const codecOk = f.endsWith('.mp3') ? /mp3.*320 kb\/s/.test(i) : f.endsWith('.mp4') ? /aac.*stereo/.test(i) : /pcm_s16le.*stereo/.test(i);
    check(`${f}: correct format`, codecOk);
    const L1 = band(p, 0, 1000), R3 = band(p, 1, 3000), L3 = band(p, 0, 3000), R1 = band(p, 1, 1000);
    check(`${f}: test tone captured in stereo`, L1 > -40 && R3 > -40 && L3 < L1 - 20 && R1 < R3 - 20, `L1k=${L1} R3k=${R3} L3k=${L3} R1k=${R1}`);
  }
  const durOf = (f) => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(info(path.join(OUT, f))); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };
  check('cropped MP3 shorter than uncropped one', durOf('e2e test.mp3') < durOf('e2e test (1).mp3') - 0.5, `${durOf('e2e test.mp3')} vs ${durOf('e2e test (1).mp3')}`);
  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => isTmpWav(f) && !tmpBefore.has(f));
  check('temp WAV files cleaned up', tmpAfter.length === 0, tmpAfter.join(','));
}

check('no console errors / exceptions', consoleErrors.length === 0, consoleErrors.join(' || '));

// Closing the window should quit the app
await js(`window.close()`).catch(() => {});
for (let i = 0; i < 50 && !exited; i++) await sleep(100);
check('closing the window exits the app', exited);
if (!exited) proc.kill();

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
