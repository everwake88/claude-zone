// The upload queue: in order, again after a failure, nothing lost across a "reload".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploader, memoryStore, pieceKey } from './queue.ts';

const blob = (s: string) => new Blob([s], { type: 'audio/webm' });
const noWait = async () => {};

test('pieces go in order; a failed one is tried again before the next', async () => {
  const store = memoryStore();
  const sent: number[] = [];
  let fails = 2;
  const counts: number[] = [];
  const up = createUploader({ store, wait: noWait, onCount: n => counts.push(n),
    send: async (p) => { if (p.seq === 1 && fails-- > 0) return { ok: false }; sent.push(p.seq); return { ok: true, text: `t${p.seq}` } } });
  const heard: string[] = [];
  const up2 = createUploader({ store: memoryStore(), wait: noWait, send: async (p) => ({ ok: true, text: `t${p.seq}` }), onSent: (_p, t) => heard.push(t) });
  await up.push(7, 0, 20000, blob('a'));
  await up.push(7, 1, 20000, blob('b'));
  await up.push(7, 2, 9000, blob('c'));
  await up.idle();
  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal(store.size(), 0, 'sent pieces leave the browser');
  assert.equal(counts.at(-1), 0);
  await up2.push(1, 0, 1000, blob('x')); await up2.push(1, 1, 1000, blob('y')); await up2.idle();
  assert.deepEqual(heard, ['t0', 't1']);
});

test('a dropped network loses nothing: what was waiting is sent after a reload', async () => {
  const store = memoryStore();
  const first = createUploader({ store, wait: async () => { first.stop(); }, send: async () => ({ ok: false }) });
  await first.push(9, 0, 20000, blob('a'));
  await first.push(9, 1, 20000, blob('b'));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(store.size(), 2, 'both pieces are still in the browser');
  const sent: string[] = [];
  const again = createUploader({ store, wait: noWait, send: async (p) => { sent.push(p.key); return { ok: true }; } });
  await again.resume(9);
  await again.idle();
  assert.deepEqual(sent, [pieceKey(9, 0), pieceKey(9, 1)]);
  assert.equal(store.size(), 0);
});

test('a piece the server refuses for good (the recording was closed) is not retried forever', async () => {
  const store = memoryStore();
  let calls = 0;
  const up = createUploader({ store, wait: noWait, send: async () => { calls++; return { ok: false, fatal: true }; } });
  await up.push(3, 0, 1000, blob('a'));
  await up.idle();
  assert.equal(calls, 1);
  assert.equal(up.pending(), 0);
});
