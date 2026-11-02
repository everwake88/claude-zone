// Loads src/shared/*.js the way n8n's Code nodes see them (one script, no modules).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
export function loadShared(files, names) {
  const code = files.map(f => readFileSync(join(HERE, '..', 'src', 'shared', f), 'utf8')).join('\n');
  return new Function(code + `\nreturn { ${names.join(', ')} };`)();
}
