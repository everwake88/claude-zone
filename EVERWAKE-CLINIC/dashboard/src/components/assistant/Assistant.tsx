'use client';
import { ArrowUp, Check, Loader2, Mic, SquarePen, Volume2, VolumeX, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { pageOf } from '@/lib/assistant/loop';
import type { Chip } from '@/lib/assistant/tools';
import { VisitRecorder } from '@/lib/scribe/recorder';
import { sb } from '@/lib/supabase/client';
import { Button, useToast } from '../ui';
import { Mark } from '../mark';
import { useTenant } from '../tenant';

const EASE = [0.23, 1, 0.32, 1] as const;
type ToolPart = { type: 'tool'; id: string; label: string; status: 'running' | 'done' | 'failed'; chips: Chip[] };
type ActionPart = { type: 'action'; id: number; label: string; summary: string; preview?: Record<string, unknown>; status: 'proposed' | 'done' | 'failed' | 'dismissed'; said?: string };
type ClientPart = { type: 'client'; label: string };
type Part = ToolPart | ActionPart | ClientPart;
interface Msg { key: string; role: 'user' | 'assistant'; text: string; parts: Part[]; pending?: boolean; error?: string }

const readAloud = { get: () => { try { return localStorage.getItem('ew-assistant-voice') === '1'; } catch { return false; } },
                    set: (v: boolean) => { try { localStorage.setItem('ew-assistant-voice', v ? '1' : '0'); } catch { /* fine */ } } };

// The doctor's assistant: an orb in the corner (⌘J), a sheet that keeps the page in view. It
// looks things up, and anything it would change waits on a card for Confirm.
export function AssistantDock() {
  const { tenant, base, can } = useTenant();
  const { t, lang } = useLang();
  const path = usePathname() || '';
  const page = pageOf(path);
  const reduce = useReducedMotion();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(false);
  const [talking, setTalking] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const mic = useRef<VisitRecorder | null>(null);
  const piece = useRef<Blob | null>(null);
  const ring = useRef<HTMLSpanElement>(null);

  useEffect(() => setVoice(readAloud.get()), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpen(o => !o); } if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { if (open) setTimeout(() => field.current?.focus(), 120); }, [open]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }); }, [msgs, reduce]);

  // the last conversation comes back when the sheet opens
  useEffect(() => {
    if (!open || loaded) return;
    setLoaded(true);
    (async () => {
      const { data: th } = await sb().from('assistant_threads').select('id').eq('tenant_id', tenant.id).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (!th) return;
      const id = (th as { id: number }).id;
      const [{ data: ms }, { data: acts }] = await Promise.all([
        sb().from('assistant_messages').select('id, role, content, parts').eq('thread_id', id).order('id', { ascending: false }).limit(30),
        sb().from('assistant_actions').select('id, status, summary, preview').eq('thread_id', id)
      ]);
      const acted = new Map(((acts || []) as { id: number; status: ActionPart['status']; preview: Record<string, unknown> }[]).map(a => [a.id, a]));
      setThread(id);
      setMsgs(((ms || []) as { id: number; role: 'user' | 'assistant'; content: string; parts: Record<string, unknown>[] }[]).reverse().map(m => ({
        key: `m${m.id}`, role: m.role, text: m.content,
        parts: (m.parts || []).map((p, i): Part => p.type === 'action'
          ? { type: 'action', id: Number(p.action_id), label: String(p.label || ''), summary: String(p.summary || ''), preview: acted.get(Number(p.action_id))?.preview, status: acted.get(Number(p.action_id))?.status || 'proposed' }
          : p.type === 'tool' ? { type: 'tool', id: `${m.id}-${i}`, label: String(p.label || ''), status: p.ok === false ? 'failed' : 'done', chips: (p.chips as Chip[]) || [] }
          : { type: 'client', label: String(p.label || '') })
      })));
    })();
  }, [open, loaded, tenant.id]);

  const patch = (key: string, f: (m: Msg) => Msg) => setMsgs(list => list.map(m => (m.key === key ? f(m) : m)));

  const send = useCallback(async (q: string) => {
    const said = q.trim();
    if (!said || busy) return;
    setText('');
    setBusy(true);
    const key = `a${Date.now()}`;
    setMsgs(l => [...l, { key: `u${Date.now()}`, role: 'user', text: said, parts: [] }, { key, role: 'assistant', text: '', parts: [], pending: true }]);
    let reply = '';
    try {
      const res = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, thread_id: thread, text: said, path, lang }) });
      if (!res.body) throw new Error('NO_ANSWER');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === 'thread') setThread(d.id);
          else if (ev === 'text') { reply += d.delta; patch(key, m => ({ ...m, text: m.text + d.delta })); }
          else if (ev === 'tool') patch(key, m => {
            const others = m.parts.filter(p => !(p.type === 'tool' && p.id === d.id));
            return { ...m, parts: [...others, { type: 'tool', id: d.id, label: d.label, status: d.status, chips: d.chips || [] }] };
          });
          else if (ev === 'action') patch(key, m => ({ ...m, parts: [...m.parts, { type: 'action', id: d.id, label: d.label, summary: d.summary, preview: d.preview, status: 'proposed' }] }));
          else if (ev === 'client') {
            window.dispatchEvent(new CustomEvent('everwake:visit', { detail: d }));
            patch(key, m => ({ ...m, parts: [...m.parts, { type: 'client', label: t(d.type === 'draft_prescription' ? 'On the prescription' : 'Filled in the visit') }] }));
          }
          else if (ev === 'error') throw new Error(d.message);
        }
      }
      patch(key, m => ({ ...m, pending: false }));
      if (voice && reply) speakOut(reply);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      patch(key, x => ({ ...x, pending: false, error: m === 'NEEDS_OPENAI_KEY' ? t('The assistant needs OPENAI_API_KEY on the server.') : m === 'NOT_A_MEMBER' ? t('Sign in again') : t('The assistant could not answer. Try again.') }));
    } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, tenant.id, thread, path, lang, voice, t]);

  const speakOut = async (s: string) => {
    try {
      const r = await fetch('/api/assistant/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: s }) });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch { /* quiet */ }
  };

  const decide = async (msgKey: string, part: ActionPart, decision: 'confirm' | 'dismiss') => {
    patch(msgKey, m => ({ ...m, parts: m.parts.map(p => (p.type === 'action' && p.id === part.id ? { ...p, said: 'busy' } : p)) }));
    const r = await fetch('/api/assistant/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action_id: part.id, decision, lang }) });
    const j = await r.json().catch(() => ({}));
    const status: ActionPart['status'] = j.status === 'done' ? 'done' : j.status === 'dismissed' ? 'dismissed' : 'failed';
    patch(msgKey, m => ({ ...m, parts: m.parts.map(p => (p.type === 'action' && p.id === part.id ? { ...p, status, said: j.summary } : p)) }));
    if (status === 'done') toast(j.summary || t('Done.'));
    if (status === 'failed') toast(j.summary || t('That did not work. Try again.'), 'critical');
  };

  // push-to-talk: hold, talk, let go
  const holdStart = async () => {
    if (busy || talking || !VisitRecorder.supported()) return;
    piece.current = null;
    const r = new VisitRecorder({ chunkMs: 120_000, onPiece: p => { piece.current = p.blob; },
      onLevel: v => { if (ring.current) ring.current.style.transform = `scale(${1 + v * 0.45})`; } });
    try { await r.start(); } catch { toast(t('The microphone is blocked. Allow it in the browser’s address bar, then try again.'), 'critical'); return; }
    mic.current = r;
    setTalking(true);
  };
  const holdEnd = async () => {
    const r = mic.current;
    if (!r) return;
    mic.current = null;
    setTalking(false);
    await r.stop();
    const blob = piece.current;
    if (!blob || blob.size < 1500) return;
    const f = new FormData(); f.append('file', blob, 'talk.webm');
    setBusy(true);
    const res = await fetch('/api/assistant/voice', { method: 'POST', body: f });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (j.text) send(j.text);
    else toast(j.error === 'NEEDS_OPENAI_KEY' ? t('The assistant needs OPENAI_API_KEY on the server.') : t('Nothing was heard.'), 'critical');
  };

  const ideas = page.kind === 'visit' && can.clinical ? [t('Summarise this patient'), t('Exam: hygiene good, mild gingivitis'), t('Who is next after this patient?')]
    : page.kind === 'patient' ? [t('Summarise this patient'), t('When is their next visit?'), t('Book their follow-up next week')]
    : [t('Who is next?'), t('I’m 20 minutes late'), t('How was this week?'), t('Free times tomorrow evening')];
  const lifted = page.kind === 'visit';

  return (
    <>
      {/* the orb */}
      <AnimatePresence>
        {!open && (
          <motion.button key="orb" onClick={() => setOpen(true)} aria-label={t('Ask the assistant (⌘J)')} title={t('Ask the assistant (⌘J)')}
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.12 } }} transition={{ duration: 0.22, ease: EASE }}
            className={cx('no-print press fixed end-5 z-40 grid size-14 place-items-center rounded-full bg-navy shadow-[0_14px_32px_-12px_rgb(11_34_46/.7)] hover:bg-navy-soft',
              lifted ? 'bottom-[96px] max-lg:bottom-[172px]' : 'bottom-6 max-lg:bottom-[96px]')}>
            <span aria-hidden className="c-glow absolute -inset-1 rounded-full bg-gold/25 blur-md" />
            <Mark size={30} className="relative" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* the sheet */}
      <AnimatePresence>
        {open && (
          <motion.section key="sheet" role="dialog" aria-label={t('Assistant')}
            initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.16 } }}
            transition={{ duration: 0.26, ease: EASE }} style={{ transformOrigin: lang === 'ar' ? 'bottom left' : 'bottom right' }}
            className="no-print fixed bottom-4 end-4 z-50 flex h-[min(680px,calc(100dvh-32px))] w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-[24px] border border-border bg-sheet shadow-[0_28px_70px_-28px_rgb(11_34_46/.55)] max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-[8dvh] max-sm:h-auto max-sm:w-auto">
            <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-navy"><Mark size={22} /></span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold leading-5">{t('Assistant')}</h2>
                <p className="truncate text-[12px] text-faint">{page.kind === 'visit' ? t('On this visit') : page.kind === 'patient' ? t('On this patient') : t('Knows your clinic’s day')}</p>
              </div>
              <button onClick={() => { const v = !voice; setVoice(v); readAloud.set(v); }} aria-pressed={voice} title={t('Read replies aloud')} aria-label={t('Read replies aloud')}
                className={cx('press grid size-8 place-items-center rounded-full hover:bg-sunk/70', voice ? 'text-gold-ink' : 'text-faint')}>
                {voice ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
              </button>
              <button onClick={() => { setThread(null); setMsgs([]); }} title={t('New conversation')} aria-label={t('New conversation')} className="press grid size-8 place-items-center rounded-full text-muted hover:bg-sunk/70"><SquarePen className="size-4" aria-hidden /></button>
              <button onClick={() => setOpen(false)} aria-label={t('Close')} className="press -me-1 grid size-8 place-items-center rounded-full text-muted hover:bg-sunk/70"><X className="size-4" aria-hidden /></button>
            </header>

            <div ref={list} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {msgs.length === 0 && (
                <div className="c-fade flex h-full flex-col justify-end gap-4">
                  <div>
                    <p className="text-[17px] font-semibold leading-snug">{t('What do you need?')}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-muted">{t('Ask about the day, a patient or the numbers. Anything that changes something waits for your Confirm.')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ideas.map((s, i) => (
                      <button key={s} onClick={() => send(s)} style={{ animationDelay: `${i * 40}ms` }}
                        className="c-rise press rounded-full bg-raised px-3 py-1.5 text-start text-[13px] ring-1 ring-inset ring-border hover:bg-gold-wash hover:ring-gold-line">{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {msgs.map(m => m.role === 'user' ? (
                <motion.div key={m.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-line rounded-[18px] rounded-ee-md bg-navy px-3.5 py-2 text-[14px] leading-relaxed text-white" dir="auto">{m.text}</p>
                </motion.div>
              ) : (
                <div key={m.key} className="space-y-2">
                  {m.parts.filter((p): p is ToolPart | ClientPart => p.type !== 'action').length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {m.parts.map((p, i) => p.type === 'tool' ? (
                        <span key={p.id} className="c-pop inline-flex flex-wrap items-center gap-1.5">
                          <span className={cx('inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium', p.status === 'failed' ? 'bg-critical-soft text-critical-ink' : 'bg-sunk/70 text-muted')}>
                            {p.status === 'running' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Check className="size-3" aria-hidden />}{p.label}{p.status === 'running' ? '…' : ''}
                          </span>
                          {p.chips.map(c => c.kind === 'patient'
                            ? <Link key={`${c.kind}${c.id}`} href={`${base}/patients/${c.id}`} className="press inline-flex h-6 items-center rounded-full bg-gold-wash px-2 text-[11.5px] font-medium text-gold-ink hover:bg-gold-line/60"><bdi>{c.label}</bdi></Link>
                            : c.kind === 'conversation'
                              ? <Link key={`${c.kind}${c.id}`} href={`${base}/inbox?c=${c.id}`} className="press inline-flex h-6 items-center rounded-full bg-gold-wash px-2 text-[11.5px] font-medium text-gold-ink hover:bg-gold-line/60">{c.label ? <bdi>{c.label}</bdi> : t('Open the chat')}</Link>
                              : <span key={`${c.kind}${c.id}`} className="inline-flex h-6 items-center rounded-full bg-raised px-2 text-[11.5px] text-muted ring-1 ring-inset ring-border"><bdi>{c.label}</bdi></span>)}
                        </span>
                      ) : p.type === 'client' ? (
                        <span key={`c${i}`} className="c-pop inline-flex h-6 items-center gap-1 rounded-full bg-gold-wash px-2 text-[11.5px] font-medium text-gold-ink"><Check className="size-3" aria-hidden />{p.label}</span>
                      ) : null)}
                    </div>
                  )}
                  {(m.text || m.pending) && (
                    <div className="whitespace-pre-line text-[14px] leading-relaxed text-ink" dir="auto">
                      {m.text}
                      {m.pending && <span className="ms-0.5 inline-flex gap-0.5 align-middle" aria-label={t('Thinking')}>{[0, 1, 2].map(i => <span key={i} className="c-breathe size-1.5 rounded-full bg-gold" style={{ animationDelay: `${i * 160}ms` }} />)}</span>}
                    </div>
                  )}
                  {m.error && <p className="rounded-xl bg-critical-soft px-3 py-2 text-[13px] text-critical-ink">{m.error}</p>}
                  {m.parts.map(p => p.type === 'action' ? <ActionCard key={`act${p.id}`} part={p} onDecide={d => decide(m.key, p, d)} /> : null)}
                </div>
              ))}
            </div>

            <form onSubmit={e => { e.preventDefault(); send(text); }} className="flex items-end gap-2 border-t border-rule px-3 py-3">
              <button type="button" onPointerDown={holdStart} onPointerUp={holdEnd} onPointerLeave={() => talking && holdEnd()}
                aria-label={t('Hold to talk')} title={t('Hold to talk')}
                className={cx('press relative grid size-10 shrink-0 place-items-center rounded-full transition-colors', talking ? 'bg-navy text-gold-bright' : 'text-muted ring-1 ring-inset ring-control hover:bg-raised')}>
                {talking && <span ref={ring} aria-hidden className="absolute inset-0 rounded-full bg-gold/30 transition-transform duration-100" />}
                <Mic className="relative size-[18px]" aria-hidden />
              </button>
              <textarea ref={field} value={text} onChange={e => setText(e.target.value)} rows={1} dir="auto"
                placeholder={talking ? t('Listening… let go to send') : t('Ask, or hold the mic and talk')} aria-label={t('Your message')}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }}
                className="max-h-32 min-h-10 flex-1 resize-none rounded-[20px] border border-control bg-sheet px-3.5 py-2.5 text-[14px] leading-snug placeholder:text-faint focus:border-navy focus:outline-none focus:ring-4 focus:ring-gold/20"
                style={{ fieldSizing: 'content' } as React.CSSProperties} />
              <button type="submit" disabled={!text.trim() || busy} aria-label={t('Send')}
                className="press grid size-10 shrink-0 place-items-center rounded-full bg-navy text-white transition-opacity hover:bg-navy-soft disabled:opacity-35">
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUp className="size-[18px]" aria-hidden />}
              </button>
            </form>
          </motion.section>
        )}
      </AnimatePresence>
    </>
  );
}

// a change waiting for the member: what it will do, the details, Confirm or Not now
function ActionCard({ part, onDecide }: { part: ActionPart; onDecide: (d: 'confirm' | 'dismiss') => void }) {
  const { t } = useLang();
  const pv = part.preview || {};
  const items = Array.isArray(pv.items) ? (pv.items as Record<string, unknown>[]) : [];
  const lines = Array.isArray(pv.lines) ? (pv.lines as string[]) : [];
  const teeth = Array.isArray(pv.teeth) ? (pv.teeth as Record<string, unknown>[]) : [];
  const busy = part.said === 'busy';
  return (
    <div className="c-rise rounded-2xl bg-raised p-3.5 ring-1 ring-inset ring-border">
      <p className="text-[14px] font-medium leading-snug" dir="auto" title={part.label}><bdi>{part.summary}</bdi></p>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px]">
          {items.slice(0, 4).map((i, k) => <li key={k} className="flex justify-between gap-3"><bdi className="truncate">{String(i.patient || '')}</bdi><span className="shrink-0 tabular-nums text-muted" dir="ltr">{String(i.from)} → <b className="font-semibold text-caution">{String(i.to)}</b></span></li>)}
          {items.length > 4 && <li className="text-[12px] text-faint">{t('and {n} more', { n: items.length - 4 })}</li>}
        </ul>
      )}
      {lines.length > 1 && <ul className="mt-2 space-y-0.5 text-[13px] text-muted" dir="auto">{lines.slice(0, 5).map((l, k) => <li key={k}><bdi>{l}</bdi></li>)}</ul>}
      {typeof pv.text === 'string' && <p className="mt-2 whitespace-pre-line rounded-xl bg-sheet px-3 py-2 text-[13px] ring-1 ring-inset ring-border" dir="auto">{pv.text}</p>}
      {teeth.length > 0 && <p className="mt-2 text-[13px] text-muted">{teeth.map(x => `${x.tooth}: ${t(String(x.condition))}`).join(' · ')}</p>}
      {part.status === 'proposed' ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" busy={busy} onClick={() => onDecide('confirm')}>{t('Confirm')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('dismiss')}>{t('Not now')}</Button>
        </div>
      ) : (
        <p className={cx('mt-2.5 flex items-center gap-1.5 text-[13px] font-medium', part.status === 'done' ? 'text-positive-ink' : part.status === 'failed' ? 'text-critical-ink' : 'text-faint')}>
          {part.status === 'done' && <Check className="size-3.5" aria-hidden />}
          {part.status === 'done' ? (part.said && part.said !== 'busy' ? part.said : t('Done.')) : part.status === 'failed' ? (part.said || t('That did not work. Try again.')) : t('Not done')}
        </p>
      )}
    </div>
  );
}
