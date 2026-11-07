// Records the Family Feud launch video.
// Starts a demo copy of the game on :3200, opens stage.html in headless Chrome at 1920×1080,
// plays a scripted game with real taps on the phone, captures frames live, then encodes an MP4.
// Usage: node video/record.js   (from the promo folder)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..', '..');           // the family-feud app
const DEMO = path.join(__dirname, '.demo');               // throwaway copy the video plays on
const FRAMES = path.join(__dirname, 'frames');
const OUT = path.join(__dirname, 'family-feud-launch.mp4');
const POSTER = path.join(__dirname, 'family-feud-poster.jpg');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 3200;
const LENGTH = 36500;                                     // ms

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(type, extra = {}) {
  await fetch(`http://localhost:${PORT}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...extra }),
  });
}

function startDemoServer() {
  fs.rmSync(DEMO, { recursive: true, force: true });
  fs.mkdirSync(DEMO, { recursive: true });
  for (const f of ['server.js', 'questions.json']) fs.copyFileSync(path.join(ROOT, f), path.join(DEMO, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(DEMO, 'public'), { recursive: true });
  const proc = spawn('node', ['server.js'], {
    cwd: DEMO, env: { ...process.env, PORT: String(PORT), HOST_URL: 'http://192.168.1.20:3000/host' }, stdio: 'ignore',
  });
  return proc;
}

let server, browser;
(async () => {
  server = startDemoServer();
  await sleep(800);
  await api('reset');

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--window-size=1920,1080', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'stage.html'), { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(1500);

  const ph = page.frames().find(f => f.url().includes('/host'));
  await ph.waitForSelector('#t1', { timeout: 15000 });   // host setup screen is up
  const tv = page.frames().find(f => f.url().includes('/board'));
  await tv.waitForSelector('#qr img, #qr canvas', { timeout: 15000 });
  // The board scales itself to its frame on load; make sure it measured a real size before recording.
  for (let i = 0; i < 10; i++) {
    const w = await tv.evaluate(() => { dispatchEvent(new Event('resize')); return document.getElementById('stage').getBoundingClientRect().width; });
    if (w > 1200) break;
    if (i === 9) throw new Error('TV board did not lay out (width ' + w + ')');
    await sleep(500);
  }
  const phoneScale = await page.evaluate(() => {
    const r = document.getElementById('ph').getBoundingClientRect();
    return { x: r.left, y: r.top, s: r.width / 390 };
  });

  // A visible tap: ring on the stage at the button's spot, then a real click inside the phone.
  async function tap(sel) {
    const el = await ph.waitForSelector(sel, { timeout: 4000 });
    const r = await el.evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    const pos = await page.evaluate(() => document.getElementById('ph').getBoundingClientRect());
    await page.evaluate((x, y) => window.ring(x, y), pos.left + r.x * phoneScale.s, pos.top + r.y * phoneScale.s);
    await sleep(160);
    await el.evaluate(e => e.click());
  }
  async function type(sel, text) {
    await tap(sel);
    await ph.type(sel, text, { delay: 45 });
  }

  // ---------- live capture ----------
  const cdp = await page.createCDPSession();
  const frames = [];
  let n = 0, recording = true;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    const file = `f${String(++n).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(FRAMES, file), Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp * 1000 });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  const t0 = Date.now();
  const at = ms => sleep(Math.max(0, t0 + ms - Date.now()));

  // ---------- the script ----------
  await page.evaluate(() => window.setBeat(0));
  await at(800);   await page.evaluate(() => window.phoneIn());

  await at(4000);  await page.evaluate(() => window.setBeat(1));
  await at(4300);  await type('#t1', 'The Aunties');
  await at(5150);  await type('#t2', 'The Bros');
  await at(5900);  await tap('[data-rounds="5"]');
  await at(6600);  await tap('#start');

  await at(8000);  await page.evaluate(() => window.setBeat(2));
  await at(8400);  await tap('[data-filter="spicy"]');
  await at(9000);  await tap('[data-filter="funny"]');
  await at(9600);  await tap('[data-filter="all"]');
  await at(10300); await tap('[data-a="pick"][data-id="1"]');

  await at(11400); await page.evaluate(() => window.setBeat(3));
  await at(11800); await tap('[data-a="buzz"][data-team="0"]');
  await at(12800); await tap('[data-a="reveal"][data-i="3"]');   // Aunties: #4 Ex showed up
  await at(14000); await tap('[data-a="reveal"][data-i="1"]');   // Bros: #2 Got sick, wins the face-off
  await at(15300); await tap('[data-a="decide"][data-choice="play"]');

  await at(16200); await page.evaluate(() => window.setBeat(4));
  await at(16600); await tap('[data-a="reveal"][data-i="0"]');   // Too drunk, 30

  await at(19000); await page.evaluate(() => window.setBeat(5));
  await at(19300); await tap('[data-a="strike"]');
  await at(19900); await tap('[data-a="strike"]');
  await at(20500); await tap('[data-a="strike"]');
  await at(23200); await tap('[data-a="reveal"][data-i="2"]');   // Aunties steal with Work in the morning

  await at(25400); await page.evaluate(() => window.setBeat(6));
  await api('fmSetup'); await api('fmStart', { names: ['Priya', 'Rohan'] });
  for (let i = 0; i < 5; i++) await api('fmAnswer', { kind: 'match', i: 0 });
  await api('fmNext'); await api('fmTimer', { run: true });
  for (const [k, ms] of [26100, 26600, 27100, 27600, 28100].entries()) {
    await at(ms); await tap('[data-a="fmAnswer"][data-kind="match"][data-i="1"]');
  }
  await at(28700); await tap('[data-a="fmRevealP1"]');

  await at(32000); await page.evaluate(() => window.endCard());
  await at(LENGTH);

  recording = false;
  await cdp.send('Page.stopScreencast');
  await browser.close();
  server.kill();

  // ---------- encode ----------
  // Screencast frames arrive only when the page changes, so each frame lasts until the next one.
  const fr = frames.filter(f => f.t >= t0);
  const before = frames.filter(f => f.t < t0).at(-1);
  if (before) fr.unshift({ ...before, t: t0 });
  const list = [];
  fr.forEach((f, i) => {
    const next = i + 1 < fr.length ? fr[i + 1].t : t0 + LENGTH;
    list.push(`file '${f.file}'`, `duration ${Math.max(0.001, (next - f.t) / 1000).toFixed(4)}`);
  });
  list.push(`file '${fr[fr.length - 1].file}'`);
  fs.writeFileSync(path.join(FRAMES, 'list.txt'), list.join('\n'));
  console.log(`captured ${fr.length} frames, ${(fr.length / (LENGTH / 1000)).toFixed(1)} fps average`);

  execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(FRAMES, 'list.txt'),
    '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-movflags', '+faststart', '-an', OUT], { stdio: 'inherit' });
  execFileSync(ffmpeg, ['-y', '-ss', '17.5', '-i', OUT, '-frames:v', '1', '-q:v', '3', POSTER], { stdio: 'ignore' });
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.rmSync(DEMO, { recursive: true, force: true });
  console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(2), 'MB');
})().catch(async e => {
  console.error(e);
  try { await browser?.close(); } catch {}
  server?.kill();
  process.exit(1);
});
