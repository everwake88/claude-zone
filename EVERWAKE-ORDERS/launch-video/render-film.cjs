// Records film.html: steps time frame by frame in Chromium, writes the
// soundtrack with music.py from the film's own cues (when the beat drops,
// the breakdown, every click, ring and message), and encodes the MP4.
//
//   node render-film.cjs                         → everwake-orders-film.mp4 (1920×1080, 30 fps)
//   node render-film.cjs --stills 12,45.5,80     → still-12.png … to check moments
//   node render-film.cjs --from 40 --to 60       → a preview of part of it
//   node render-film.cjs --page vertical.html    → the vertical cut (it sets its own size)
//   node render-film.cjs --page sales-agent.html → everwake-sales-agent.mp4, the chat agent film
//   … --format 45                                → its 4:5 cut for LinkedIn mobile (1080×1350), …-4x5.mp4
//   … --voice vo.wav                             → mix a voice-over in, the music ducking under it
//
// Needs Playwright (with Chromium), ffmpeg, and Python 3 with numpy.
// The frames come from capture/ (see capture/README.md).
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FPS = 30;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const PAGE = arg('--page') || 'film.html';
const BASE = PAGE.replace(/\.html$/, '');
const F45 = arg('--format') === '45';
const NAME = (PAGE === 'film.html' ? 'everwake-orders-film' : PAGE === 'vertical.html' ? 'everwake-orders-vertical' : 'everwake-' + BASE) + (F45 ? '-4x5' : '');

(async () => {
  const browser = await chromium.launch();
  const size = F45 ? { width: 1080, height: 1350 } : PAGE === 'vertical.html' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const page = await browser.newPage({ viewport: size });
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto('file://' + path.join(__dirname, PAGE) + (F45 ? '?format=45' : ''), { waitUntil: 'load' });
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
  const out = path.join(__dirname, from === 0 && to === duration ? `${NAME}.mp4` : `preview-${from}-${to}.mp4`);
  const cuesFile = path.join(__dirname, '.cues.json'), music = path.join(__dirname, '.film-music.wav');
  fs.writeFileSync(cuesFile, JSON.stringify(await page.evaluate(() => window.CUES)));
  execFileSync('python3', [path.join(__dirname, 'music.py'), cuesFile, music], { stdio: 'inherit' });
  if (arg('--voice')) {
    // the voice on top; the music steps back while it speaks
    const mixed = path.join(__dirname, '.film-mix.wav');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', music, '-i', arg('--voice'), '-filter_complex',
      '[1:a]aresample=48000,volume=1.0,asplit=2[v1][v2];[0:a][v1]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350[m];[m][v2]amix=inputs=2:normalize=0,alimiter=limit=0.95',
      mixed]);
    fs.renameSync(mixed, music);
  }

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
