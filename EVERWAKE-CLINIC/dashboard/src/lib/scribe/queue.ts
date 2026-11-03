// The visit's audio pieces wait here until the server has them. Each piece is written to the
// browser's own database first (IndexedDB), then sent in order; a failed send waits and tries
// again (1 s, 2 s, 4 s … up to 30 s) and a dropped network loses nothing — the pieces are still
// there after a reload. Pure logic with the store passed in, for `node --test`.

export interface Piece { key: string; rec: number; seq: number; ms: number; blob: Blob; tries?: number }
export interface Store {
  put(p: Piece): Promise<void>;
  del(key: string): Promise<void>;
  list(rec: number): Promise<Piece[]>;
}

export const pieceKey = (rec: number, seq: number) => `${rec}:${String(seq).padStart(5, '0')}`;

export function memoryStore(): Store & { size(): number } {
  const m = new Map<string, Piece>();
  return {
    async put(p) { m.set(p.key, p); },
    async del(k) { m.delete(k); },
    async list(rec) { return [...m.values()].filter(p => p.rec === rec).sort((a, b) => a.seq - b.seq); },
    size: () => m.size
  };
}

export function idbStore(name = 'everwake-scribe'): Store {
  const open = () => new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pieces', { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((res, rej) => {
      const t = db.transaction('pieces', mode);
      const q = fn(t.objectStore('pieces'));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
      t.oncomplete = () => db.close();
    });
  };
  return {
    async put(p) { await tx('readwrite', s => s.put(p)); },
    async del(k) { await tx('readwrite', s => s.delete(k)); },
    async list(rec) {
      const all = await tx<Piece[]>('readonly', s => s.getAll() as IDBRequest<Piece[]>);
      return all.filter(p => p.rec === rec).sort((a, b) => a.seq - b.seq);
    }
  };
}

// a store that falls back to memory when the browser will not give one (a private window)
export function safeStore(): Store {
  try { if (typeof indexedDB !== 'undefined') return idbStore(); } catch { /* memory */ }
  return memoryStore();
}

export interface Uploader {
  push(rec: number, seq: number, ms: number, blob: Blob): Promise<void>;
  resume(rec: number): Promise<void>;          // after a reload: send what is still waiting
  idle(): Promise<void>;                       // resolves when nothing is waiting
  pending(): number;
  stop(): void;
}

export function createUploader({ store, send, onSent, onCount, wait = (ms) => new Promise(r => setTimeout(r, ms)), maxDelay = 30_000 }:
  { store: Store; send: (p: Piece) => Promise<{ ok: boolean; text?: string; fatal?: boolean }>;
    onSent?: (p: Piece, text: string) => void; onCount?: (n: number) => void;
    wait?: (ms: number) => Promise<void>; maxDelay?: number }): Uploader {
  const queue: Piece[] = [];
  let running = false;
  let stopped = false;
  let waiters: (() => void)[] = [];
  const count = () => onCount?.(queue.length);
  const settle = () => { if (!queue.length && !running) { waiters.forEach(w => w()); waiters = []; } };

  async function pump() {
    if (running || stopped) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        const p = queue[0];
        let r: { ok: boolean; text?: string; fatal?: boolean };
        try { r = await send(p); } catch { r = { ok: false }; }
        if (r.ok || r.fatal) {
          queue.shift();
          await store.del(p.key).catch(() => {});
          if (r.ok) onSent?.(p, r.text || '');
          count();
          continue;
        }
        p.tries = (p.tries || 0) + 1;
        await wait(Math.min(maxDelay, 1000 * 2 ** (p.tries - 1)));
      }
    } finally { running = false; settle(); }
  }

  return {
    async push(rec, seq, ms, blob) {
      const p: Piece = { key: pieceKey(rec, seq), rec, seq, ms, blob };
      await store.put(p).catch(() => {});
      if (!queue.some(q => q.key === p.key)) queue.push(p);
      queue.sort((a, b) => a.rec - b.rec || a.seq - b.seq);
      count();
      void pump();
    },
    async resume(rec) {
      for (const p of await store.list(rec).catch(() => [] as Piece[])) if (!queue.some(q => q.key === p.key)) queue.push(p);
      queue.sort((a, b) => a.rec - b.rec || a.seq - b.seq);
      count();
      void pump();
    },
    idle() { return queue.length || running ? new Promise<void>(r => waiters.push(r)) : Promise.resolve(); },
    pending: () => queue.length,
    stop() { stopped = true; }
  };
}
