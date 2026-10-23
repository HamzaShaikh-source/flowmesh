'use strict';
/**
 * Records the on-site demo clip from the real page.
 *
 * It serves web/ locally (so the page is in its hosted "browser edition" mode), drives headless
 * Edge/Chrome over the DevTools protocol, and types sentences into the voice capture field with
 * Input.insertText: the same way Wispr Flow inserts a dictated phrase, in one piece. The sentences
 * are TYPED, standing in for dictation, and the clip says so in a badge that stays on screen.
 * Frames are timestamped and assembled with ffmpeg so the timing is true to what happened.
 *
 *   node scripts/record_demo.js [--out web/media/demo.mp4] [--poster web/media/demo-poster.jpg]
 *
 * Needs: Edge or Chrome, ffmpeg on PATH, Node 22+ (global WebSocket).
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const OUT = path.resolve(ROOT, opt('--out', 'web/media/demo.mp4'));
const POSTER = path.resolve(ROOT, opt('--poster', 'web/media/demo-poster.jpg'));
const PORT = 8791;
const DEBUG_PORT = 9333;
const W = 1280;
const H = 720;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.json': 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(WEB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function connect() {
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('the browser did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method && listeners.has(msg.method)) listeners.get(msg.method)(msg.params);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { id += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  return { send, on: (method, fn) => listeners.set(method, fn), close: () => ws.close() };
}

const OVERLAY = `
(() => {
  if (document.getElementById('demoOverlay')) return;
  const style = document.createElement('style');
  style.textContent = \`
    #demoBadge { position: fixed; left: 14px; bottom: 14px; z-index: 2147483000; font: 600 11px/1.3 ui-monospace, Consolas, monospace; letter-spacing: .05em; text-transform: uppercase; color: #1a1a1a; background: #f0d7ff; border: 1.5px solid #1a1a1a; border-radius: 8px; padding: 6px 10px; max-width: 330px; }
    #demoCaption { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483000; max-width: 960px; text-align: center; font: 400 26px/1.25 'EB Garamond', Georgia, serif; color: #ffffeb; background: rgba(26,26,26,.92); border-radius: 14px; padding: 10px 22px; transition: opacity .25s; }
    #demoCaption.off { opacity: 0; }
    #demoCaption small { display: block; margin-top: 4px; font: 500 13px/1.3 Figtree, system-ui, sans-serif; color: #d3efe3; letter-spacing: .02em; }
    #demoCursor { position: fixed; left: 640px; top: 700px; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; background: #f0d7ff; border: 2.5px solid #1a1a1a; z-index: 2147483002; pointer-events: none; transition: left .5s cubic-bezier(.2,.7,.2,1), top .5s cubic-bezier(.2,.7,.2,1), transform .15s; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    #demoCursor.down { transform: scale(.7); }
    #demoCursor.hide { opacity: 0; transition: opacity .3s; }
    #demoEnd { position: fixed; inset: 0; z-index: 2147483001; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 14px; background: #ffffeb; text-align: center; padding: 40px; }
    #demoEnd h1 { font: 400 64px/1.05 'EB Garamond', Georgia, serif; margin: 0; color: #1a1a1a; }
    #demoEnd h1 em { color: #034f46; }
    #demoEnd p { font: 500 20px/1.4 Figtree, system-ui, sans-serif; margin: 0; color: #3a3a36; }
    #demoEnd code { font: 600 18px ui-monospace, Consolas, monospace; background: #f0d7ff; border: 1.5px solid #1a1a1a; border-radius: 8px; padding: 4px 10px; }
  \`;
  document.head.appendChild(style);
  const wrap = document.createElement('div');
  wrap.id = 'demoOverlay';
  wrap.innerHTML = '<div id="demoBadge">Recording of the live page. Sentences are typed in, standing in for Wispr dictation.</div><div id="demoCaption" class="off"></div><div id="demoCursor" class="hide"></div><div id="demoEnd"></div>';
  document.body.appendChild(wrap);
})();`;

async function main() {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) throw new Error('no Edge or Chrome found');
  const server = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-rec-'));
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
    '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  const frames = [];
  let recording = false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-frames-'));
  try {
    const cdp = await connect();
    const { send } = cdp;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?demo=1#/` });
    await sleep(2500);
    const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    await evaluate(OVERLAY);

    // The compositor's screencast pushes a frame whenever the page changes, with real timestamps; a static page
    // sends nothing, and the assembler holds the last frame until the next one arrives.
    recording = true;
    const started = Date.now();
    cdp.on('Page.screencastFrame', (params) => {
      if (recording) frames.push({ t: Date.now() - started, data: params.data });
      send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    });
    await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await evaluate("document.body.dataset.rec = '1'"); // make sure a first frame is produced

    const caption = async (text, sub = '') => {
      await evaluate(`(() => { const c = document.getElementById('demoCaption'); c.innerHTML = ${JSON.stringify(text)} + ${JSON.stringify(sub ? `<small>${sub}</small>` : '')}; c.classList.remove('off'); })()`);
    };
    const hideCaption = () => evaluate("document.getElementById('demoCaption').classList.add('off')");
    // Wispr inserts a dictated phrase in one piece into whatever field has focus: so does this.
    const say = async (text, wait = 2100) => {
      await evaluate("document.getElementById('voiceCatch').focus()");
      await send('Input.insertText', { text });
      await sleep(wait);
    };
    // A real mouse click (so the browser grants the user gesture window.open needs), with a visible cursor.
    const click = async (selector) => {
      const rect = (await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; n.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)).result.value;
      if (!rect) return;
      await evaluate(`(() => { const c = document.getElementById('demoCursor'); c.classList.remove('hide'); c.style.left = '${rect.x}px'; c.style.top = '${rect.y}px'; })()`);
      await sleep(650);
      await evaluate("document.getElementById('demoCursor').classList.add('down')");
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await sleep(180);
      await evaluate("document.getElementById('demoCursor').classList.remove('down')");
      await sleep(700);
      await evaluate("document.getElementById('demoCursor').classList.add('hide')");
    };
    const key = async (name) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name }); };

    // ---------------------------------------------------------------- the story
    await caption('Say it. Approve it. Keep the receipt.');
    await sleep(3200);
    await caption('Hold your Wispr key and talk', 'It types into the dock. FlowMesh acts on whole sentences and plans the rest.');
    await sleep(1800);
    await say('go to tools', 2300);
    await caption('Drive a tool entirely by voice', 'Demo tools run inside this page. Real MCP servers run in the desktop app.');
    await say('use the calculator tool', 2400);
    await say('set expression to 12 times 3 plus 4', 2600);
    await say('plan this call', 3000);
    await caption('Nothing has run yet', 'The plan shows the exact call, its risk, and when it expires.');
    await sleep(2200);
    await caption('Approval by voice is off by default', 'Say approve and it is refused. You approve with a click.');
    await say('approve', 2400);
    await click('#approveButton');
    await caption('One approval, one run, one receipt', '“Returned” is not “verified”: the page says which it is.');
    await sleep(3400);

    await caption('The page pilot: zoom, volume, screenshots, scroll', 'A small rule-based agent. It cannot approve or delete anything.');
    await say('zoom in', 2000);
    await say('zoom in', 2000);
    await say('scroll to the receipts section', 2200);
    await say('reset zoom', 2000);
    await caption('Ask what you can say', 'The list is generated from the grammar itself.');
    await say('what can I say', 3600);
    await evaluate("document.getElementById('voiceHelp').close()");
    await sleep(700);

    await caption('Ordinary sentences become plans', 'Not a command, so it is planned. Nothing is silently dropped.');
    await say('Start a 25 minute research sprint and open the project board.', 3400);
    await caption('Five actions, each on its own surface', 'PC, phone and lamp. Phone and lamp are not configured here, and say so.');
    await sleep(2200);
    await click('#approveButton');
    await caption('Honest receipts', 'verified, sent, or not configured. Never a success it did not observe.');
    await sleep(3600);
    await say('scroll to the receipts section', 2400);
    await sleep(1800);

    await evaluate('window.scrollTo(0, 0)');
    await sleep(500);
    await say('delete all my files', 2300);
    await caption('Dangerous requests are refused', 'With a reason, and no plan.');
    await sleep(3600);
    await hideCaption();
    await sleep(400);
    await evaluate(`(() => { const e = document.getElementById('demoEnd'); e.innerHTML = '<h1>Say the work.<br><em>See it happen.</em></h1><p>FlowMesh · plans you approve · receipts you can read</p><p><code>flowmesh-nohands.netlify.app</code></p><p>Open source · MIT · no accounts, no telemetry</p>'; e.style.display = 'flex'; })()`);
    await sleep(4200);

    await send('Page.stopScreencast').catch(() => {});
    recording = false;
    cdp.close();
  } finally {
    recording = false;
    child.kill();
    server.close();
  }

  if (frames.length < 20) throw new Error(`only ${frames.length} frames were captured`);
  // Assemble with true timing: each frame lasts until the next one.
  const lines = ['ffconcat version 1.0'];
  frames.forEach((frame, index) => {
    const file = path.join(tmp, `f${String(index).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(frame.data, 'base64'));
    const next = frames[index + 1] ? frames[index + 1].t : frame.t + 400;
    lines.push(`file '${file.replace(/\\/g, '/')}'`, `duration ${Math.max(0.01, (next - frame.t) / 1000).toFixed(3)}`);
  });
  lines.push(`file '${path.join(tmp, `f${String(frames.length - 1).padStart(5, '0')}.jpg`).replace(/\\/g, '/')}'`);
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, lines.join('\n'));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=30,scale=${W}:${H},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', '-an', OUT]);
  // Poster: the frame at the moment the first plan was on screen (about a third of the way in).
  const posterFrame = frames[Math.floor(frames.length * 0.3)];
  fs.writeFileSync(POSTER, Buffer.from(posterFrame.data, 'base64'));
  const seconds = (frames[frames.length - 1].t / 1000).toFixed(1);
  console.log(`frames=${frames.length} seconds=${seconds} out=${OUT} bytes=${fs.statSync(OUT).size}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exit(1); });
