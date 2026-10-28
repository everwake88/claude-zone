// Records film.html: steps time frame by frame in Chromium, writes the
// soundtrack with music.py from the film's own cues (when the beat drops,
// the breakdown, every click, ring and message), and encodes the MP4.
//
//   node render-film.cjs                         → everwake-orders-film.mp4 (1920×1080, 30 fps)
//   node render-film.cjs --stills 12,45.5,80     → still-12.png … to check moments
//   node render-film.cjs --from 40 --to 60       → a preview of part of it
//
// Needs Playwright (with Chromium), ffmpeg, and Python 3 with numpy.
// The frames come from capture/ (see capture/README.md).
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FPS = 30;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto('file://' + path.join(__dirname, 'film.html'));
  await page.evaluate(() => window.ready);
  const duration = await page.evaluate(() => window.DURATION);
  console.log(`film: ${duration.toFixed(1)}s`);

  if (arg('--stills')) {
    for (const t of arg('--stills').split(',').map(Number)) {
      await page.evaluate((t) => window.render(t), t);
      await page.screenshot({ path: path.join(__dirname, `still-${t}.png`) });
    }
    await browser.close();
    return;
  }

  const from = Number(arg('--from') || 0), to = Number(arg('--to') || duration);
  const out = path.join(__dirname, from === 0 && to === duration ? 'everwake-orders-film.mp4' : `preview-${from}-${to}.mp4`);
  const cuesFile = path.join(__dirname, '.cues.json'), music = path.join(__dirname, '.film-music.wav');
  fs.writeFileSync(cuesFile, JSON.stringify(await page.evaluate(() => window.CUES)));
  execFileSync('python3', [path.join(__dirname, 'music.py'), cuesFile, music], { stdio: 'inherit' });

  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-ss', String(from), '-i', music,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });

  const first = Math.round(from * FPS), last = Math.round(to * FPS);
  const started = Date.now();
  for (let f = first; f < last; f++) {
    await page.evaluate((t) => window.render(t), f / FPS);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 93 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if ((f - first) % 300 === 0) {
      const done = (f - first) / (last - first), secs = (Date.now() - started) / 1000;
      console.log(`frame ${f}/${last}${done > 0 ? ` · about ${Math.round(secs / done - secs)}s left` : ''}`);
    }
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited ' + c)))));
  await browser.close();
  fs.rmSync(music, { force: true });
  fs.rmSync(cuesFile, { force: true });
  console.log('wrote', out);
})();
