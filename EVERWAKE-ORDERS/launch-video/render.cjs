// Renders video.html to an MP4: steps time frame by frame, screenshots each
// frame in Chromium and pipes it to ffmpeg, then lays a soft music bed under it.
//
//   node render.cjs                      → everwake-orders-launch.mp4 (1920×1080, 30 fps)
//   node render.cjs --stills 3,12,24,33  → frame-3.png … to check a moment quickly
//
// Needs Playwright (with Chromium) and ffmpeg on the PATH.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const FPS = 30;
const OUT = path.join(__dirname, 'everwake-orders-launch.mp4');
const MUSIC = path.join(__dirname, '.music.wav');

function music(seconds) {
  // A slow two-chord pad (A minor 9 → F major 7), every voice a sine with a
  // gentle swell, softened by a low-pass and an echo. No samples, no licence.
  const chord = (notes) => notes.map(([f, a]) => `${a}*sin(2*PI*${f}*t)*(0.85+0.15*sin(2*PI*0.25*t))`).join('+');
  const am = chord([[110, .30], [164.81, .22], [220, .20], [261.63, .14], [329.63, .10], [493.88, .05]]);
  const fm = chord([[87.31, .30], [130.81, .22], [174.61, .20], [220, .14], [329.63, .10], [523.25, .05]]);
  const bar = 5.75;  // seconds per chord
  const expr = `0.22*if(lt(mod(t,${bar * 2}),${bar}),${am},${fm})`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `aevalsrc='${expr}':s=48000:d=${seconds}`,
    '-af', `lowpass=f=1400,aecho=0.8:0.7:420:0.35,afade=t=in:d=2,afade=t=out:st=${seconds - 3}:d=3,volume=3.2`,
    MUSIC]);
}

(async () => {
  const stillsArg = process.argv.indexOf('--stills');
  const stills = stillsArg > 0 ? process.argv[stillsArg + 1].split(',').map(Number) : null;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto('file://' + path.join(__dirname, 'video.html'));
  await page.evaluate(() => window.ready);
  const duration = await page.evaluate(() => DURATION);

  if (stills) {
    for (const t of stills) {
      await page.evaluate(t => window.render(t), t);
      await page.screenshot({ path: path.join(__dirname, `frame-${t}.png`) });
    }
    await browser.close();
    return;
  }

  music(duration);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-i', MUSIC,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', OUT],
    { stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(duration * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate(t => window.render(t), f / FPS);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 150 === 0) process.stdout.write(`frame ${f}/${frames}\n`);
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exited ' + c))));
  await browser.close();
  require('fs').rmSync(MUSIC, { force: true });
  console.log('wrote', OUT);
})();
