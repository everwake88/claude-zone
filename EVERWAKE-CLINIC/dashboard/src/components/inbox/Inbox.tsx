'use client';
import { ArrowLeft, Bot, CalendarPlus, Check, CircleHelp, FileText, Hand, Image as ImageIcon, Mic, Search, Send, Siren, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clock, cx, dayLabel, phone as fmtPhone, timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import type { ApptCard } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { STATUS_LABEL, STATUS_TONE } from '../appointment/ApptDrawer';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Empty, Input, Pill, Segmented, Skeleton, Textarea, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';

interface Conv { id: number; wa_id: string; mode: 'agent' | 'human'; needs_attention: boolean; attention_reason: string | null; urgency: string | null;
  questions_open: number; unread_count: number; last_message_at: string | null; last_message_preview: string | null; name: string | null; phone: string | null;
  patients: { id: number; full_name: string; relation: string }[] | null; next: { id: number; starts_at: string } | null }
interface Msg { id: number; direction: 'inbound' | 'outbound'; sender: 'patient' | 'agent' | 'staff' | 'system'; kind: string; body: string | null;
  media_url: string | null; status: string; created_at: string; meta: Record<string, unknown> }
interface Question { id: number; question: string; status: string; answer_kind: string | null; answer: string | null; answered_by_name: string | null; asked_at: string }
interface Thread { conversation: Conv & { human_reason: string | null; language: string | null }; messages: Msg[]; questions: Question[];
  patients: { id: number; full_name: string; relation: string; file_no: string; age: string | null; age_en: string | null }[]; appointments: ApptCard[] }

// WhatsApp, as the assistant handles it: the chats that need someone on top (an emergency, a question
// for the doctor), every message, and the buttons to take a chat over and hand it back.
export function Inbox() {
  const { tenant } = useTenant();
  const { t } = useLang();
  const params = useSearchParams();
  const router = useRouter();
  const [filter, setFilter] = useState<'attention' | 'all' | 'human'>('all');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const sel = Number(params.get('c')) || null;
  useEffect(() => { const timer = setTimeout(() => setTerm(q.trim()), 200); return () => clearTimeout(timer); }, [q]);
  const { data: list, refresh } = useCached<Conv[]>(`inbox:${tenant.id}:${filter}:${term}`, async () => {
    const { data, error } = await sb().rpc('inbox_list', { p_tenant: tenant.id, p_filter: filter, p_q: term || null, p_limit: 80 });
    if (error) throw new Error(error.message);
    return data as Conv[];
  });
  useLive(['conversations', 'team_questions'], () => refresh());
  const pick = (id: number | null) => router.replace(id ? `?c=${id}` : '?', { scroll: false });

  return (
    <div className="card c-rise flex h-[calc(100dvh-200px)] min-h-[520px] overflow-hidden lg:h-[calc(100dvh-110px)]">
      {/* the chats */}
      <aside className={cx('flex w-full shrink-0 flex-col border-e border-rule md:w-[340px]', sel && 'max-md:hidden')}>
        <div className="space-y-2.5 border-b border-rule p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Name or number')} className="ps-9" aria-label={t('Search chats')} />
          </div>
          <Segmented label="inbox-filter" size="sm" value={filter} onChange={setFilter}
            options={[{ value: 'all', label: t('All') }, { value: 'attention', label: t('Needs you') }, { value: 'human', label: t('Taken over') }]} />
        </div>
        <ul className="flex-1 divide-y divide-rule overflow-y-auto">
          {!list ? Array.from({ length: 7 }).map((_, i) => <li key={i} className="flex gap-3 p-3"><Skeleton className="size-9 rounded-full" /><span className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-3 w-48" /></span></li>)
            : list.length === 0 ? <li className="p-4 text-[13px] text-muted">{filter === 'attention' ? t('Nothing needs you. The assistant has it.') : t('No chats yet.')}</li>
            : list.map(c => {
                const on = c.id === sel;
                return (
                  <li key={c.id}>
                    <button onClick={() => pick(c.id)} aria-current={on ? 'true' : undefined}
                      className={cx('relative flex w-full gap-3 px-3 py-3 text-start transition-colors', on ? 'bg-accent-soft' : 'hover:bg-raised')}>
                      {c.urgency === 'emergency' && <span className="absolute inset-y-0 start-0 w-[3px] bg-critical" aria-hidden />}
                      <Avatar name={c.name || c.wa_id} size={36} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cx('truncate text-[13.5px]', c.unread_count ? 'font-semibold' : 'font-medium')}><bdi>{c.name || fmtPhone(c.wa_id)}</bdi></span>
                          <span className="ms-auto shrink-0 text-[11px] text-faint">{timeAgo(c.last_message_at)}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          {c.urgency === 'emergency' ? <Pill tone="critical"><Siren className="size-3" aria-hidden />{t('Emergency')}</Pill>
                            : c.questions_open > 0 ? <Pill tone="caution"><CircleHelp className="size-3" aria-hidden />{t('Question for you')}</Pill>
                            : c.mode === 'human' ? <Pill tone="accent"><Hand className="size-3" aria-hidden />{t('You')}</Pill> : null}
                          <span className="truncate text-[12.5px] text-muted"><bdi>{c.last_message_preview}</bdi></span>
                          {c.unread_count > 0 && <span className="ms-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-white">{c.unread_count}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
        </ul>
      </aside>
      {/* the chat */}
      <section className={cx('min-w-0 flex-1', !sel && 'max-md:hidden')}>
        {sel ? <ChatView id={sel} onBack={() => pick(null)} onChanged={refresh} />
          : <div className="flex h-full items-center justify-center p-8 text-center text-[13.5px] text-muted"><p className="max-w-xs">{t('Pick a chat. The assistant answers every patient; you step in when one needs you.')}</p></div>}
      </section>
    </div>
  );
}

function ChatView({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const { tenant, base } = useTenant();
  const { t } = useLang();
  const shell = useShell();
  const toast = useToast();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const { data: th, refresh } = useCached<Thread>(`thread:${id}`, async () => {
    const { data, error } = await sb().rpc('inbox_thread', { p_conversation: id, p_limit: 150 });
    if (error) throw new Error(error.message);
    return data as Thread;
  });
  useLive(['messages', 'conversations', 'team_questions'], (e) => { if (Number(e.row.conversation_id ?? e.row.id) === id || e.table === 'team_questions') refresh(); }, 250);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [th?.messages.length, id]);

  const call = useCallback(async (fn: string, args: Record<string, unknown>, done?: string) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc(fn, args);
      if (error) throw new Error(error.message);
      return data ?? true;
    }, done);
    if (r) { refresh(); onChanged(); }
    return r;
  }, [run, refresh, onChanged]);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const r = await call('send_staff_message', { p_conversation: id, p_body: body, p_kind: 'text' });
    if (r) { setText(''); ping(); }
  };
  const answer = async (q: Question, kind: 'yes' | 'no' | 'text', ans?: string) => {
    const res = await fetch(`/api/team-question/${q.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, answer: ans }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { toast(t(j.error || 'That did not work. Try again.'), 'critical'); return; }
    toast(j.woke ? t('Answered. The assistant is telling the patient now.') : t('Answered. The assistant tells the patient with their next message.'));
    refresh(); onChanged();
  };

  if (!th) return <div className="space-y-3 p-5"><Skeleton className="h-12" /><Skeleton className="h-64" /></div>;
  const c = th.conversation;
  const human = c.mode === 'human';
  const tz = tenant.timezone;
  let lastDay = '';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-rule px-3 py-2.5 lg:px-5">
        <button onClick={onBack} className="press -ms-1 rounded-md p-1.5 text-muted hover:bg-raised md:hidden" aria-label={t('Back')}><ArrowLeft className="size-5 rtl:rotate-180" /></button>
        <Avatar name={c.name || c.wa_id} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold"><bdi>{c.name || fmtPhone(c.wa_id)}</bdi></p>
          <p className="truncate text-xs text-muted"><bdi dir="ltr">{fmtPhone(c.phone || c.wa_id)}</bdi>
            {th.patients.length > 0 && <> · {th.patients.map((p, i) => <span key={p.id}>{i ? '، ' : ''}<Link href={`${base}/patients/${p.id}`} className="text-gold-ink hover:underline"><bdi>{p.full_name}</bdi></Link></span>)}</>}
          </p>
        </div>
        {human
          ? <Button size="sm" variant="outline" busy={busy} onClick={() => call('hand_back', { p_conversation: id }, t('The assistant has the chat again.'))}><Bot className="size-4" aria-hidden />{t('Hand back')}</Button>
          : <Button size="sm" variant="outline" busy={busy} onClick={() => call('take_over', { p_conversation: id, p_reason: null }, t('You have the chat. The assistant stays quiet until you hand it back.'))}><Hand className="size-4" aria-hidden />{t('Take over')}</Button>}
        {th.patients[0] && <Button size="sm" className="max-sm:hidden" onClick={() => shell.newBooking({ patientId: th.patients[0].id, patientName: th.patients[0].full_name })}><CalendarPlus className="size-4" aria-hidden />{t('Book')}</Button>}
      </header>

      {(c.urgency || c.needs_attention) && (
        <div className={cx('flex items-center gap-3 px-4 py-2 text-[13px]', c.urgency === 'emergency' ? 'bg-critical-soft text-critical-ink' : 'bg-caution-soft text-caution')}>
          {c.urgency === 'emergency' ? <Siren className="size-4 shrink-0" aria-hidden /> : <CircleHelp className="size-4 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1"><bdi>{c.attention_reason || (c.urgency === 'emergency' ? t('Possible emergency') : t('Needs someone from the team'))}</bdi></span>
          <button onClick={() => call('resolve_attention', { p_conversation: id }, t('Marked as handled.'))} className="press shrink-0 rounded-lg px-2 py-1 text-xs font-medium ring-1 ring-inset ring-current/30 hover:bg-white/50">{t('Handled')}</button>
        </div>
      )}
      {th.appointments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b border-rule px-4 py-2 text-[12.5px]">
          {th.appointments.map(a => (
            <span key={a.id} className="inline-flex shrink-0 items-center gap-2 rounded-full bg-raised px-2.5 py-1 ring-1 ring-inset ring-border">
              <bdi>{a.patient}</bdi> · {dayLabel(a.est_at || a.starts_at, tz, { weekday: 'short', day: 'numeric', month: 'short' })} {clock(a.est_at || a.starts_at, tz)}
              <Pill tone={STATUS_TONE[a.status]}>{t(STATUS_LABEL[a.status])}</Pill>
            </span>
          ))}
        </div>
      )}

      <div className="flex-1 space-y-1.5 overflow-y-auto bg-raised/50 px-3 py-4 lg:px-6">
        {th.messages.map((m, i) => {
          const day = dayLabel(m.created_at, tz, { weekday: 'long', day: 'numeric', month: 'long' });
          const sep = day !== lastDay; lastDay = day;
          const mine = m.direction === 'outbound';
          return (
            <div key={m.id}>
              {sep && <p className="py-2 text-center text-[11.5px] text-faint">{day}</p>}
              <motion.div initial={i > th.messages.length - 3 ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cx('max-w-[82%] rounded-2xl px-3 py-2 text-[13.5px] leading-relaxed shadow-[0_1px_1px_rgb(15_23_41/.06)]',
                  mine ? (m.sender === 'staff' ? 'rounded-ee-md bg-accent text-white' : 'rounded-ee-md bg-sheet ring-1 ring-inset ring-border') : 'rounded-es-md bg-sheet ring-1 ring-inset ring-border')}>
                  {m.kind !== 'text' && (
                    <p className={cx('mb-1 flex items-center gap-1.5 text-xs', mine && m.sender === 'staff' ? 'text-white/80' : 'text-muted')}>
                      {m.kind === 'audio' ? <Mic className="size-3.5" aria-hidden /> : m.kind === 'image' ? <ImageIcon className="size-3.5" aria-hidden /> : <FileText className="size-3.5" aria-hidden />}
                      {t(m.kind === 'audio' ? 'Voice note' : m.kind === 'image' ? 'Photo' : m.kind === 'location' ? 'Location' : 'File')}
                    </p>
                  )}
                  {m.body && <p className="bubble" dir="auto">{m.body}</p>}
                  <p className={cx('mt-0.5 flex items-center justify-end gap-1 text-[10.5px]', mine && m.sender === 'staff' ? 'text-white/70' : 'text-faint')}>
                    {mine && <span>{m.sender === 'agent' ? t('Assistant') : m.sender === 'staff' ? t('Team') : t('Automatic')}</span>}
                    <span>{clock(m.created_at, tz)}</span>
                    {mine && m.status === 'failed' && <span className="font-semibold text-critical">{t('not sent')}</span>}
                  </p>
                </div>
              </motion.div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      {/* the assistant's questions for the doctor */}
      <AnimatePresence initial={false}>
        {th.questions.filter(q => q.status === 'open').map(q => <QuestionCard key={q.id} q={q} onAnswer={answer} />)}
      </AnimatePresence>

      <footer className="border-t border-rule p-3">
        {human ? (
          <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); send(); }}>
            <Textarea rows={1} value={text} onChange={e => setText(e.target.value)} placeholder={t('Write to the patient…')} className="max-h-40 min-h-9 flex-1 resize-none"
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <Button type="submit" busy={busy} disabled={!text.trim()} aria-label={t('Send')}><Send className="size-4 rtl:-scale-x-100" aria-hidden /></Button>
          </form>
        ) : (
          <p className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
            <span className="inline-flex items-center gap-1.5"><Bot className="size-4 text-accent" aria-hidden />{t('The assistant is answering this patient.')}</span>
            <button onClick={() => call('take_over', { p_conversation: id, p_reason: null })} className="font-medium text-gold-ink hover:underline">{t('Take over to write yourself')}</button>
          </p>
        )}
      </footer>
    </div>
  );
}

function QuestionCard({ q, onAnswer }: { q: Question; onAnswer: (q: Question, kind: 'yes' | 'no' | 'text', ans?: string) => Promise<void> }) {
  const { t } = useLang();
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (kind: 'yes' | 'no' | 'text', ans?: string) => { setBusy(true); await onAnswer(q, kind, ans); setBusy(false); };
  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }} transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
      className="mx-3 mb-2 rounded-xl bg-caution-soft p-3 ring-1 ring-inset ring-caution-line">
      <p className="flex items-start gap-2 text-[13.5px]"><CircleHelp className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
        <span><span className="block text-xs font-medium text-caution">{t('The assistant asks')} · {timeAgo(q.asked_at)}</span><bdi className="text-ink">{q.question}</bdi></span></p>
      {typing ? (
        <form className="mt-2.5 flex gap-2" onSubmit={e => { e.preventDefault(); if (text.trim()) go('text', text.trim()); }}>
          <Input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={t('Your answer; the assistant passes it on in its own words')} className="flex-1 bg-sheet" />
          <Button size="sm" variant="ghost" onClick={() => setTyping(false)} aria-label={t('Cancel')}><X className="size-4" /></Button>
          <Button size="sm" type="submit" busy={busy}>{t('Send')}</Button>
        </form>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" variant="positive" busy={busy} onClick={() => go('yes')}><Check className="size-3.5" aria-hidden />{t('Yes')}</Button>
          <Button size="sm" variant="outline" busy={busy} onClick={() => go('no')} className="bg-sheet">{t('No')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setTyping(true)}>{t('Write an answer')}</Button>
        </div>
      )}
    </motion.div>
  );
}
