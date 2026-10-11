// Typing activity: keystrokes in the reply box, and how long the agent was
// actively typing. Keys pressed within 2.5s of each other count as continuous
// typing; an isolated key counts as 0.3s. Sent to the server every ~20s.
const IGNORE = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'ContextMenu']);
let keys = 0;
let ms = 0;
let last = 0;

export function onKeyDown(e) {
  if (IGNORE.has(e.key) || e.repeat) return;
  const t = performance.now();
  const gap = t - last;
  ms += last && gap < 2500 ? gap : 300;
  last = t;
  keys += 1;
}

export function take() {
  const out = { k: keys, ms: Math.round(Math.min(ms, 60_000)) };
  keys = 0;
  ms = 0;
  return out;
}
