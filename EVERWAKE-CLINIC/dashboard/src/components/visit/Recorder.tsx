'use client';
import { Check, Mic, MicOff, Pause, Play, RotateCcw, Square, Trash2, Volume2, WifiOff } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { transcribeHint } from '@/lib/scribe/prompts';
import { createUploader, safeStore, type Uploader } from '@/lib/scribe/queue';
import { VisitRecorder } from '@/lib/scribe/recorder';
import { clock, tail, type Segment } from '@/lib/scribe/transcript';
import { Button, Checkbox, Dialog, useToast } from '../ui';
import { useVisit } from './context';
import type { VisitContext } from './types';

const EASE = [0.23, 1, 0.32, 1] as const;
type Stage = 'transcript' | 'extract' | 'verify';
const STAGES: { key: Stage; label: string }[] = [
  { key: 'transcript', label: 'Writing it out' }, { key: 'extract', label: 'Filling the form' }, { key: 'verify', label: 'Checking every field' }
];

// "Listen to the visit": consent, the round button, the words as they come, then three named
// stages while the note is filled. The audio pieces wait in the browser until the server has them.
export function Recorder({ ctx, audioDays, onChanged, onSegments }:
  { ctx: VisitContext; audioDays: number; onChanged: () => Promise<void> | void; onSegments: (s: Segment[]) => void }) {
  const { t, lang } = useLang();
  const toast = useToast();
  const rec = ctx.recording && ctx.recording.status !== 'discarded' ? ctx.recording : null;
  const [consent, setConsent] = useState(false);
  const [noKey, setNoKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<'off' | 'recording' | 'paused'>('off');
  const [elapsed, setElapsed] = useState(0);
  const [pieces, setPieces] = useState<{ seq: number; ms: number; text: string }[]>([]);
  const [pending, setPending] = useState(0);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const recorder = useRef<VisitRecorder | null>(null);
  const uploader = useRef<Uploader | null>(null);
  const arc = useRef<SVGCircleElement | null>(null);
  const halo = useRef<HTMLSpanElement | null>(null);
  const lastText = useRef('');
  const reduce = useReducedMotion();

  const status = live !== 'off' ? 'live' : stage ? 'finishing' : rec?.status || 'none';
  const saved = rec?.duration_ms || 0;

  // the timer: what is saved plus the piece being recorded
  useEffect(() => {
    if (live === 'off') return;
    const id = setInterval(() => setElapsed((recorder.current?.now() || 0)), 500);
    return () => clearInterval(id);
  }, [live]);
  useEffect(() => () => { recorder.current?.stop(); uploader.current?.stop(); }, []);

  const hint = () => transcribeHint({ patient: ctx.patient?.full_name, specialty: ctx.doctor?.specialty, terms: ctx.terms, last: tail(lastText.current) });
  const makeUploader = (id: number) => {
    uploader.current?.stop();
    const u = createUploader({
      store: safeStore(),
      onCount: setPending,
      onSent: (p, text) => {
        if (text) lastText.current += ' ' + text;
        setPieces(list => [...list.filter(x => x.seq !== p.seq), { seq: p.seq, ms: p.ms, text }].sort((a, b) => a.seq - b.seq));
      },
      send: async (p) => {
        const f = new FormData();
        f.append('recording_id', String(id)); f.append('seq', String(p.seq)); f.append('ms', String(p.ms));
        f.append('hint', hint()); f.append('file', p.blob, `piece-${p.seq}.webm`);
        const r = await fetch('/api/scribe/chunk', { method: 'POST', body: f });
        if (r.status === 409 || r.status === 404 || r.status === 400) return { ok: false, fatal: true };
        if (!r.ok) return { ok: false };
        const j = await r.json();
        return { ok: !!j.ok, text: j.text || '' };
      }
    });
    uploader.current = u;
    return u;
  };

  const level = (v: number) => {
    const c = arc.current;
    if (c) { const len = 2 * Math.PI * 64; c.style.strokeDasharray = `${(0.04 + v * 0.62) * len} ${len}`; c.style.opacity = String(0.35 + v * 0.65); }
    if (halo.current && !reduce) halo.current.style.transform = `scale(${1 + v * 0.1})`;
  };

  const startMic = async (id: number, startSeq: number) => {
    const r = new VisitRecorder({ startSeq, onLevel: level, onPiece: p => uploader.current?.push(id, p.seq, p.ms, p.blob) });
    await r.start();
    recorder.current = r;
    setLive('recording');
  };

  const start = async () => {
    if (!VisitRecorder.supported()) { setError(t('This browser cannot record. Use Chrome, Edge or Safari, or type the note.')); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/scribe/start', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appointment_id: ctx.appointment.id, consent: true, consent_text: t('The patient agreed to the visit being recorded for the medical record.') }) });
      const j = await res.json().catch(() => ({}));
      if (j.error === 'NEEDS_OPENAI_KEY') { setNoKey(true); return; }
      if (!j.ok) throw new Error(j.error || t('Could not start listening.'));
      makeUploader(j.id);
      lastText.current = '';
      setPieces([]);
      try { await startMic(j.id, 0); }
      catch {
        await fetch('/api/scribe/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recording_id: j.id }) });
        throw new Error(t('The microphone is blocked. Allow it in the browser’s address bar, then try again.'));
      }
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  // the page was reloaded during the visit: pick up where it was
  const resume = async () => {
    if (!rec) return;
    setBusy(true); setError(null);
    try {
      const u = makeUploader(rec.id);
      await u.resume(rec.id);
      lastText.current = rec.chunks.map(c => c.text).join(' ');
      setPieces(rec.chunks.map(c => ({ seq: c.seq, ms: c.ms, text: c.text })));
      await startMic(rec.id, Math.max(-1, ...rec.chunks.map(c => c.seq)) + 1);
    } catch { setError(t('The microphone is blocked. Allow it in the browser’s address bar, then try again.')); }
    finally { setBusy(false); }
  };

  const pause = async () => { await recorder.current?.pause(); setLive('paused'); level(0); };
  const cont = () => { recorder.current?.resume(); setLive('recording'); };

  const finish = async () => {
    if (!rec && !recorder.current) return;
    const id = rec?.id;
    setError(null);
    await recorder.current?.stop();
    recorder.current = null;
    setLive('off');
    setStage('transcript');
    try {
      const u = uploader.current || (id ? makeUploader(id) : null);
      if (u && id) { await u.resume(id); await u.idle(); }
      const res = await fetch('/api/scribe/finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recording_id: id, lang }) });
      if (!res.body) throw new Error(t('The server did not answer.'));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = false;
      while (!done) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === 'stage') setStage(d.key);
          if (ev === 'transcript') onSegments(d.segments);
          if (ev === 'error') throw new Error(d.message);
          if (ev === 'done') { done = true; toast(t('The note is filled. Check it, then sign.')); }
        }
      }
      if (!done) throw new Error(t('The server stopped before the note was ready.'));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m === 'NEEDS_OPENAI_KEY' ? t('Listening needs OPENAI_API_KEY on the server. Type the note instead.') : m === 'NOTHING_HEARD' ? t('Nothing was heard in the recording.') : m);
    } finally {
      setStage(null);
      await onChanged();
    }
  };

  const discard = async () => {
    setAskDiscard(false);
    await recorder.current?.stop(); recorder.current = null; setLive('off');
    if (rec) await fetch('/api/scribe/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recording_id: rec.id }) });
    setPieces([]); lastText.current = '';
    await onChanged();
  };

  const showTimer = live !== 'off' ? elapsed : saved;
  const segs = useVisit().segments;

  return (
    <section className="card c-rise min-w-0 overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-6">{t('Listen to the visit')}</h2>
          <p className="text-[12.5px] text-faint">{status === 'signed' ? t('Signed. The words stay with the note.')
            : status === 'review' ? t('Done listening. Check the note, then sign.')
            : status === 'live' ? (live === 'paused' ? t('Paused') : t('Listening — talk as usual'))
            : status === 'finishing' ? t('Writing the note…')
            : t('The note fills itself while you talk with the patient.')}</p>
        </div>
        {rec && !['signed'].includes(status) && live === 'off' && !stage && (
          <button onClick={() => setAskDiscard(true)} className="press -me-1.5 rounded-full p-2 text-faint hover:bg-sunk/70 hover:text-critical" aria-label={t('Start over')} title={t('Start over')}>
            <Trash2 className="size-4" aria-hidden />
          </button>
        )}
      </header>

      <div className="px-5 pb-5 pt-4">
        {/* the button */}
        {(status === 'none' || status === 'live' || status === 'recording') && !noKey && (
          <div className="flex flex-col items-center gap-4">
            <div className="relative grid size-[164px] place-items-center">
              <span ref={halo} aria-hidden className={cx('absolute inset-3 rounded-full bg-gold-wash transition-transform duration-150', live === 'recording' ? 'opacity-100' : 'opacity-0')} />
              <svg viewBox="0 0 164 164" className="absolute inset-0 -rotate-90 rtl:scale-y-[-1]" aria-hidden>
                <circle cx="82" cy="82" r="64" fill="none" stroke="var(--color-gold-line)" strokeWidth="3" opacity={live !== 'off' ? 0.9 : 0.5} />
                <circle ref={arc} cx="82" cy="82" r="64" fill="none" stroke="var(--color-gold)" strokeWidth="5" strokeLinecap="round"
                  style={{ strokeDasharray: `0 ${2 * Math.PI * 64}`, transition: 'stroke-dasharray 90ms linear, opacity 120ms linear' }} />
              </svg>
              {live === 'off' && status === 'none' ? (
                <button onClick={start} disabled={!consent || busy}
                  className="press relative grid size-[112px] place-items-center rounded-full bg-navy text-gold-bright shadow-[0_14px_30px_-14px_rgb(11_34_46/.7)] transition-opacity hover:bg-navy-soft disabled:opacity-40"
                  aria-label={t('Start listening')}>
                  <Mic className="size-9" aria-hidden />
                </button>
              ) : live === 'off' ? (
                <button onClick={resume} disabled={busy} className="press relative grid size-[112px] place-items-center rounded-full bg-navy text-gold-bright hover:bg-navy-soft" aria-label={t('Continue listening')}>
                  <Mic className="size-9" aria-hidden />
                </button>
              ) : (
                <button onClick={finish} className="press relative grid size-[112px] place-items-center rounded-full bg-navy text-white hover:bg-navy-soft" aria-label={t('Stop and fill the note')}>
                  <span className="flex flex-col items-center gap-1">
                    <span className="text-[22px] font-semibold tabular-nums leading-none" dir="ltr">{clock(showTimer / 1000)}</span>
                    <span className="flex items-center gap-1 text-[11px] text-on-navy-muted"><Square className="size-2.5 fill-current" aria-hidden />{t('Stop')}</span>
                  </span>
                </button>
              )}
            </div>

            {status === 'none' && live === 'off' && (
              <div className="w-full space-y-2.5">
                <div className="rounded-2xl bg-raised px-3.5 py-3 ring-1 ring-inset ring-border">
                  <Checkbox checked={consent} onChange={setConsent} label={<span className="text-[13.5px] font-medium">{t('The patient agreed to recording this visit')}</span>} />
                  <p className="mt-1.5 ps-6 text-[12px] leading-relaxed text-muted">{t('The audio is kept {n} days, then deleted. The words stay with the note.', { n: audioDays })}</p>
                </div>
                <p className="text-center text-[12.5px] text-faint">{t('Or type the note yourself — the form is open.')}</p>
              </div>
            )}
            {status === 'recording' && live === 'off' && (
              <div className="flex w-full flex-col items-center gap-2 text-center">
                <p className="text-[13px] text-muted">{t('A recording was in progress ({t} kept).', { t: clock(saved / 1000) })}</p>
                <div className="flex gap-2"><Button variant="outline" size="sm" onClick={finish}>{t('Fill the note from it')}</Button></div>
              </div>
            )}
            {live !== 'off' && (
              <div className="flex items-center gap-2">
                {live === 'recording'
                  ? <Button variant="outline" size="sm" onClick={pause}><Pause className="size-3.5" aria-hidden />{t('Pause')}</Button>
                  : <Button variant="outline" size="sm" onClick={cont}><Play className="size-3.5" aria-hidden />{t('Continue')}</Button>}
                <Button size="sm" onClick={finish}><Check className="size-3.5" aria-hidden />{t('Done — fill the note')}</Button>
              </div>
            )}
            {pending > 1 && (
              <p className="c-fade flex items-center gap-1.5 text-[12.5px] text-caution"><WifiOff className="size-3.5" aria-hidden />{t('{n} pieces are waiting to upload. Nothing is lost.', { n: pending })}</p>
            )}
          </div>
        )}

        {noKey && (
          <p className="flex items-start gap-2 rounded-2xl bg-raised px-3.5 py-3 text-[13px] leading-relaxed text-muted ring-1 ring-inset ring-border">
            <MicOff className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />{t('Listening needs OPENAI_API_KEY on the server. Type the note instead.')}
          </p>
        )}

        {/* the three stages */}
        {stage && (
          <ol className="space-y-2.5" aria-live="polite">
            {STAGES.map((s, i) => {
              const at = STAGES.findIndex(x => x.key === stage);
              const state = i < at ? 'done' : i === at ? 'now' : 'next';
              return (
                <li key={s.key} className="flex items-center gap-3 text-[14px]">
                  <span className={cx('grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-300',
                    state === 'done' ? 'bg-gold text-navy' : state === 'now' ? 'bg-navy text-gold-bright' : 'bg-sunk text-faint')}>
                    {state === 'done' ? <Check className="size-3.5" aria-hidden /> : state === 'now' ? <span className="c-breathe size-2 rounded-full bg-gold-bright" /> : <span className="size-1.5 rounded-full bg-faint/60" />}
                  </span>
                  <span className={cx(state === 'next' ? 'text-faint' : 'text-ink', state === 'now' && 'font-medium')}>{t(s.label)}{state === 'now' ? '…' : ''}</span>
                </li>
              );
            })}
          </ol>
        )}

        {status === 'processing' && !stage && (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-[13px] text-muted">{t('The recording is saved; the note is not filled yet.')}</p>
            <Button size="sm" onClick={finish}><RotateCcw className="size-3.5" aria-hidden />{t('Fill the note')}</Button>
          </div>
        )}
        {status === 'failed' && !stage && (
          <div className="space-y-2.5">
            <p className="rounded-2xl bg-caution-soft px-3.5 py-3 text-[13px] leading-relaxed text-caution ring-1 ring-inset ring-caution-line">
              {t('The note could not be filled: {e}', { e: rec?.error || '' })}
            </p>
            <div className="flex justify-center gap-2"><Button size="sm" onClick={finish}><RotateCcw className="size-3.5" aria-hidden />{t('Try again')}</Button></div>
          </div>
        )}
        {error && <p className="c-fade mt-3 rounded-2xl bg-critical-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-critical-ink">{error}</p>}

        {(status === 'review' || status === 'signed') && rec && (
          <div className="flex items-center gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-gold-wash text-gold-ink"><Volume2 className="size-5" aria-hidden /></span>
            <div className="min-w-0 text-[13px]">
              <p className="font-medium text-ink"><span dir="ltr" className="tabular-nums">{clock(saved / 1000)}</span> · {t('{n} lines', { n: segs.length })}{rec.diarized ? ` · ${t('doctor and patient told apart')}` : ''}</p>
              <p className="text-muted">{rec.audio_deleted_at ? t('The audio was deleted after its days; the words stay.') : t('Tap a line to hear it.')}</p>
            </div>
          </div>
        )}
      </div>

      <Transcript live={live !== 'off' || status === 'recording' || !!stage} pieces={pieces} />

      <Dialog open={askDiscard} onClose={() => setAskDiscard(false)} title={t('Start over?')}
        footer={<><Button variant="outline" onClick={() => setAskDiscard(false)}>{t('Keep it')}</Button><Button variant="danger" onClick={discard}>{t('Set it aside')}</Button></>}>
        <p className="text-muted">{t('This recording and what it filled are set aside. What you typed in the form stays.')}</p>
      </Dialog>
    </section>
  );
}

// the words: while listening, each piece as it comes; after, every line with who said it
function Transcript({ live, pieces }: { live: boolean; pieces: { seq: number; ms: number; text: string }[] }) {
  const { t } = useLang();
  const { segments, focus, play, playing, canPlay } = useVisit();
  const box = useRef<HTMLDivElement>(null);
  const focusKey = focus.join(',');
  useEffect(() => {
    if (!focus.length || !box.current) return;
    box.current.querySelector<HTMLElement>(`[data-seg="${focus[0]}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusKey, focus]);
  const lines = useMemo(() => segments, [segments]);
  if (live) {
    if (!pieces.length) return null;
    return (
      <div className="border-t border-rule px-5 py-4">
        <div className="max-h-[260px] space-y-2.5 overflow-y-auto text-[13.5px] leading-relaxed" dir="auto">
          <AnimatePresence initial={false}>
            {pieces.map((p, i) => (
              <motion.p key={p.seq} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }} className="flex gap-2.5">
                <span className="w-9 shrink-0 pt-px text-[11.5px] tabular-nums text-faint" dir="ltr">{clock(pieces.slice(0, i).reduce((n, x) => n + x.ms, 0) / 1000)}</span>
                <bdi className={p.text ? 'text-ink' : 'text-faint'}>{p.text || t('(heard at the end)')}</bdi>
              </motion.p>
            ))}
          </AnimatePresence>
        </div>
      </div>
    );
  }
  if (!lines.length) return null;
  return (
    <div className="border-t border-rule">
      <div ref={box} className="max-h-[min(52dvh,520px)] overflow-y-auto px-3 py-3" dir="auto">
        {lines.map(s => {
          const lit = focus.includes(s.id);
          const doc = s.speaker === 'doctor';
          return (
            <button key={s.id} data-seg={s.id} type="button" disabled={!canPlay} onClick={() => play(s.id)}
              className={cx('group flex w-full gap-2.5 rounded-xl px-2 py-1.5 text-start text-[13.5px] leading-relaxed transition-colors duration-200',
                lit ? 'bg-gold-wash' : 'hover:bg-raised', !canPlay && 'cursor-default')}>
              <span className="w-9 shrink-0 pt-px text-[11.5px] tabular-nums text-faint" dir="ltr">{playing === s.id ? <Volume2 className="c-breathe size-3.5 text-gold-ink" aria-hidden /> : clock(s.start)}</span>
              <span className="min-w-0">
                {s.speaker && <span className={cx('me-1.5 text-[11.5px] font-semibold', doc ? 'text-navy' : 'text-gold-ink')}>{t(doc ? 'Doctor' : s.speaker === 'patient' ? 'Patient' : 'Other')}</span>}
                <bdi className="text-ink">{s.text}</bdi>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
