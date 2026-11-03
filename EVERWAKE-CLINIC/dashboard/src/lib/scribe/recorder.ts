'use client';
// The visit's microphone: opus at 32 kbps in pieces of about 20 seconds. Each piece is a whole file
// on its own (the recorder restarts for every piece), so it can be heard by itself the moment it is
// sent. The level (0–1) drives the gold arc around the button.

export type RecState = 'idle' | 'recording' | 'paused' | 'stopped';

export function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
  if (typeof MediaRecorder === 'undefined') return '';
  return options.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

export class VisitRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mr: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private seq: number;
  private pieceStart = 0;
  private flushed: Promise<void> = Promise.resolve();
  state: RecState = 'idle';
  elapsedMs = 0;                                 // recorded so far (pauses not counted)
  private readonly chunkMs: number;
  private readonly onPiece: (p: { seq: number; blob: Blob; ms: number }) => void;
  private readonly onLevel: (v: number) => void;

  constructor(opts: { chunkMs?: number; startSeq?: number; onPiece: (p: { seq: number; blob: Blob; ms: number }) => void; onLevel?: (v: number) => void }) {
    this.chunkMs = opts.chunkMs ?? 20_000;
    this.seq = opts.startSeq ?? 0;
    this.onPiece = opts.onPiece;
    this.onLevel = opts.onLevel || (() => {});
  }

  static supported(): boolean {
    return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.meter();
    } catch { /* no level meter; recording still works */ }
    this.state = 'recording';
    this.begin();
  }

  private meter() {
    const a = this.analyser;
    if (!a) return;
    const buf = new Uint8Array(a.fftSize);
    let smooth = 0;
    const tick = () => {
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      smooth = smooth * 0.8 + Math.min(1, rms * 4) * 0.2;
      this.onLevel(this.state === 'recording' ? smooth : 0);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private begin() {
    if (!this.stream) return;
    const mime = pickMime();
    const mr = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 });
    const parts: Blob[] = [];
    const seq = this.seq++;
    this.pieceStart = performance.now();
    let done!: () => void;
    this.flushed = new Promise<void>(r => { done = r; });
    mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    mr.onstop = () => {
      const ms = Math.round(performance.now() - this.pieceStart);
      this.elapsedMs += ms;
      if (parts.length) this.onPiece({ seq, blob: new Blob(parts, { type: mr.mimeType || mime || 'audio/webm' }), ms });
      done();
      if (this.state === 'recording') this.begin();
    };
    mr.start();
    this.mr = mr;
    this.timer = setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, this.chunkMs);
  }

  // how long so far, counting the piece being recorded now
  now(): number { return this.elapsedMs + (this.state === 'recording' ? performance.now() - this.pieceStart : 0); }

  async pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    if (this.timer) clearTimeout(this.timer);
    if (this.mr?.state === 'recording') this.mr.stop();
    await this.flushed;
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.begin();
  }

  async stop() {
    const was = this.state;
    this.state = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    if (was === 'recording' && this.mr?.state === 'recording') this.mr.stop();
    await this.flushed;
    cancelAnimationFrame(this.raf);
    this.onLevel(0);
    this.stream?.getTracks().forEach(t => t.stop());
    await this.ctx?.close().catch(() => {});
    this.stream = null; this.ctx = null; this.analyser = null;
  }
}
