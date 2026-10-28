// Gathers every scene.json (and the take's state: order number, payment
// reference) into shots/manifest.js, which the film page loads.
import fs from 'node:fs';
import path from 'node:path';

export function writeManifest(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name, 'scene.json');
    if (fs.existsSync(f)) out[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const state = path.join(dir, 'state.json');
  out.__state = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};
  fs.writeFileSync(path.join(dir, 'manifest.js'), 'window.SHOTS = ' + JSON.stringify(out) + ';\n');
  return Object.keys(out).length - 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log('scenes:', writeManifest(path.resolve(process.argv[2] || 'shots')));
}
