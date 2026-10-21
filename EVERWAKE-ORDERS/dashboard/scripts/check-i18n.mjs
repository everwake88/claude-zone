// Every t('…') in the dashboard must have an Arabic translation, with the
// same {placeholders}. Run: npm run i18n:check
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = new URL('../src/', import.meta.url).pathname;
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && files.push(p); } })(src);

const ar = readFileSync(join(src, 'lib/i18n-ar.ts'), 'utf8');
const AR = Object.fromEntries([...ar.matchAll(/^\s*("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),$/gm)].map(m => [JSON.parse(m[1]), JSON.parse(m[2])]));
const ph = s => (s.match(/\{\w+\}/g) || []).sort().join(',');

const problems = [];
for (const f of files) {
  if (f.endsWith('i18n-ar.ts')) continue;
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\b(?:t|tt)\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const key = m[2].replace(/\\(['"])/g, '$1');
    if (!(key in AR)) problems.push(`${f.replace(src, 'src/')}: no Arabic for "${key}"`);
    else if (ph(key) !== ph(AR[key])) problems.push(`${f.replace(src, 'src/')}: placeholders differ for "${key}"`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`i18n ok: ${Object.keys(AR).length} Arabic texts, every t() key covered`);
