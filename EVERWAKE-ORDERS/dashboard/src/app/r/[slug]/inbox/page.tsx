'use client';
import {
  AlertTriangle, ArrowLeft, Ban, Bot, Check, CheckCheck, Clock, Hand, ImagePlus, MapPin, Search, Send, ShieldAlert, User
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Empty, Spinner, Tabs, Textarea, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { clock, cx, dateTime, day, displayName, money, phoneLabel, qty, statusLabel, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Address, Conversation, Customer, Message, Order } from '@/lib/types';

type Filter = 'all' | 'attention' | 'human' | 'unread';

function InboxInner() {
  const { tenant } = useTenant();
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) || 'all');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Conversation[] | null>(null);
  const selectedId = Number(params.get('c')) || null;

  const loadList = useCallback(async () => {
    let query = sb().from('conversations')
      .select('*, customers(display_name, full_name, phone, phone_hidden, orders_count, is_blocked)')
      .eq('tenant_id', tenant.id).not('last_message_at', 'is', null)
      .order('last_message_at', { ascending: false }).limit(200);
    if (filter === 'attention') query = query.eq('needs_attention', true);
    if (filter === 'human') query = query.eq('mode', 'human');
    if (filter === 'unread') query = query.gt('unread_count', 0);
    const { data } = await query;
    setList((data || []) as Conversation[]);
  }, [tenant.id, filter]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(loadList, 400); };
    const ch = sb().channel('inbox-list-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'conversations', filter: `tenant_id=eq.${tenant.id}` }, soon)
      .subscribe();
    return () => { sb().removeChannel(ch); if (t) clearTimeout(t); };
  }, [tenant.id, loadList]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return list || [];
    return (list || []).filter(c => [c.wa_id, c.customers?.full_name, c.customers?.display_name, c.customers?.phone, c.last_message_preview]
      .some(v => (v || '').toLowerCase().includes(s)));
  }, [list, q]);

  const select = (id: number | null) => {
    const u = new URLSearchParams(params.toString());
    if (id) u.set('c', String(id)); else u.delete('c');
    router.replace(`?${u.toString()}`, { scroll: false });
  };

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-3.5rem)] lg:-mx-6">
      {/* the list */}
      <aside className={cx('flex w-full flex-col border-e border-hairline bg-white md:w-80 md:shrink-0', selectedId && 'hidden md:flex')}>
        <div className="space-y-2 border-b border-hairline p-3">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Name, number or message')}
              className="h-9 w-full rounded-lg border border-hairline ps-9 pe-3 text-sm focus:outline-none focus:ring-2 focus:ring-gold/50" />
          </div>
          <Tabs size="sm" value={filter} onChange={setFilter} tabs={[
            { value: 'all', label: t('All') }, { value: 'attention', label: t('Needs you') }, { value: 'human', label: t('Taken over') }, { value: 'unread', label: t('Unread') }]} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {!list ? <Spinner /> : shown.length === 0 ? <p className="p-6 text-center text-sm text-muted">{t('No conversations here.')}</p> : shown.map(c => (
            <button key={c.id} onClick={() => select(c.id)}
              className={cx('flex w-full flex-col gap-0.5 border-b border-hairline px-4 py-3 text-start hover:bg-paper', selectedId === c.id && 'bg-gold-wash')}>
              <span className="flex items-center gap-2">
                <span className="flex-1 truncate font-medium" dir="auto">{displayName(c.customers, '+' + c.wa_id)}</span>
                <span className="text-xs text-muted">{timeAgo(c.last_message_at)}</span>
              </span>
              <span className="truncate text-sm text-muted" dir="auto">{c.last_message_preview}</span>
              <span className="flex flex-wrap gap-1">
                {c.needs_attention && <Badge tone="critical"><AlertTriangle className="size-3" /> {t('needs you')}</Badge>}
                {c.mode === 'human' && <Badge tone="gold"><Hand className="size-3" /> {t('taken over')}</Badge>}
                {c.unread_count > 0 && <Badge tone="navy">{t('{n} new', { n: c.unread_count })}</Badge>}
                {(c.customers?.orders_count || 0) > 0 && <Badge>{t('{n} orders', { n: c.customers?.orders_count })}</Badge>}
              </span>
            </button>
          ))}
        </div>
      </aside>

      {selectedId ? <Thread key={selectedId} id={selectedId} onBack={() => select(null)} onChanged={loadList} />
        : <div className="hidden flex-1 items-center justify-center md:flex"><Empty title={t('Pick a conversation')}>{t("Every WhatsApp chat is here, live — the agent's replies, your team's, and the customer's.")}</Empty></div>}
    </div>
  );
}

function Thread({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const { tenant } = useTenant();
  const toast = useToast();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [draft, setDraft] = useState<Order | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [showSide, setShowSide] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    const db = sb();
    const { data: c } = await db.from('conversations').select('*').eq('id', id).single();
    if (!c) return;
    const cv = c as Conversation;
    setConv(cv);
    const [m, cu, d, o, a] = await Promise.all([
      db.from('messages').select('*').eq('tenant_id', tenant.id).eq('wa_id', cv.wa_id).order('created_at', { ascending: false }).limit(150),
      cv.customer_id ? db.from('customers').select('*').eq('id', cv.customer_id).single() : Promise.resolve({ data: null }),
      db.from('orders').select('*').eq('tenant_id', tenant.id).eq('wa_id', cv.wa_id).eq('status', 'draft').maybeSingle(),
      db.from('orders').select('*').eq('tenant_id', tenant.id).eq('wa_id', cv.wa_id).neq('status', 'draft').order('placed_at', { ascending: false }).limit(5),
      cv.customer_id ? db.from('customer_addresses').select('*').eq('customer_id', cv.customer_id).order('last_used_at', { ascending: false }).limit(3) : Promise.resolve({ data: [] })
    ]);
    setMessages(((m.data || []) as Message[]).reverse());
    setCustomer(cu.data as Customer | null);
    setNotes((cu.data as Customer | null)?.staff_notes || '');
    setDraft(d.data as Order | null);
    setOrders((o.data || []) as Order[]);
    setAddresses((a.data || []) as Address[]);
  }, [id, tenant.id]);

  useEffect(() => {
    load();
    sb().rpc('mark_read', { p_conversation: id }).then(() => onChanged());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (!conv) return;
    const ch = sb().channel('thread-' + id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'messages', filter: `tenant_id=eq.${tenant.id}` }, (p) => {
        const row = (p.new || p.old) as Message;
        if (row?.wa_id === conv.wa_id) load();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'everwake', table: 'conversations', filter: `id=eq.${id}` }, (p) => setConv(c => ({ ...(c as Conversation), ...(p.new as Conversation) })))
      .subscribe();
    return () => { sb().removeChannel(ch); };
  }, [conv?.wa_id, id, tenant.id, load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  if (!conv) return <div className="flex-1"><Spinner /></div>;
  const human = conv.mode === 'human';
  const name = displayName(customer, '+' + conv.wa_id);
  const sym = tenant.currency_symbol;

  const rpc = (fn: string, args: Record<string, unknown>, done?: string) => run(async () => {
    const { error } = await sb().rpc(fn, args);
    if (error) throw new Error(error.message);
    await load(); onChanged();
  }, done);

  const send = async (mediaUrl?: string, mime?: string) => {
    const body = text.trim();
    if (!body && !mediaUrl) return;
    await run(async () => {
      const { error } = await sb().rpc('send_staff_message', {
        p_conversation: id, p_body: body || null, p_kind: mediaUrl ? (mime?.startsWith('image/') ? 'image' : 'document') : 'text',
        p_media_url: mediaUrl || null, p_media_mime: mime || null, p_file_name: null });
      if (error) throw new Error(error.message);
      setText('');
      fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
      await load(); onChanged();
    });
  };

  const attach = async (f: File) => {
    const ext = f.name.split('.').pop() || 'jpg';
    const path = `${tenant.id}/chat/${crypto.randomUUID()}.${ext}`;
    const up = await sb().storage.from('media').upload(path, f, { contentType: f.type, upsert: false });
    if (up.error) { toast(up.error.message, 'critical'); return; }
    const url = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
    await send(url, f.type);
  };

  const pending = conv.state?.ledger?.pending_items || [];
  const details = conv.state?.customer || {};

  return (
    <div className="flex min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col bg-paper">
        <header className="flex flex-wrap items-center gap-2 border-b border-hairline bg-white px-4 py-2.5">
          <button onClick={onBack} className="rounded-lg p-1 hover:bg-paper md:hidden" aria-label={t('Back')}><ArrowLeft className="size-5 rtl:rotate-180" /></button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" dir="auto">{name}</p>
            <p className="text-xs text-muted">{phoneLabel(conv.wa_id, customer?.phone, customer?.phone_hidden)}</p>
          </div>
          {human ? (
            <>
              <Badge tone="gold"><Hand className="size-3" /> {t('You have this chat')}</Badge>
              <Button size="sm" variant="primary" busy={busy} onClick={() => rpc('hand_back', { p_conversation: id }, t('Handed back — the agent answers the next message and knows what you said.'))}>
                <Bot className="size-4" /> {t('Hand back to the agent')}
              </Button>
            </>
          ) : (
            <>
              <Badge tone="positive"><Bot className="size-3" /> {t('The agent is answering')}</Badge>
              <Button size="sm" variant="gold" busy={busy} onClick={() => rpc('take_over', { p_conversation: id, p_reason: null }, t('You have the chat. The agent stays quiet until you hand it back.'))}>
                <Hand className="size-4" /> {t('Take over')}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowSide(s => !s)} className="hidden xl:inline-flex"><User className="size-4" /></Button>
        </header>

        {conv.needs_attention && (
          <div className="flex items-center gap-2 border-b border-critical/20 bg-critical-wash px-4 py-2 text-sm text-critical">
            <ShieldAlert className="size-4" />
            <span className="flex-1" dir="auto">{t('The agent asked for a person: {reason}', { reason: conv.attention_reason || t('see the chat') })}</span>
            <Button size="sm" variant="outline" onClick={() => rpc('resolve_attention', { p_conversation: id }, t('Marked as handled'))}>{t('Handled')}</Button>
          </div>
        )}

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {messages.map((m, i) => {
            const mine = m.direction === 'outbound';
            const newDay = i === 0 || new Date(messages[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
            const loc = (m.meta?.location || null) as { maps_url?: string } | null;
            return (
              <div key={m.id}>
                {newDay && <p className="my-3 text-center text-xs text-muted">{day(m.created_at, tenant.timezone)}</p>}
                <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
                  <div className={cx('max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm',
                    !mine && 'rounded-es-md bg-white',
                    mine && m.sender === 'agent' && 'rounded-ee-md bg-navy text-white',
                    mine && m.sender === 'staff' && 'rounded-ee-md bg-gold-wash text-ink ring-1 ring-gold-line',
                    mine && m.sender === 'driver' && 'rounded-ee-md bg-positive-wash text-ink ring-1 ring-positive/30',
                    mine && m.sender === 'system' && 'rounded-ee-md bg-paper-sunk text-muted italic')}>
                    {mine && <p className={cx('mb-0.5 text-[11px] font-semibold uppercase tracking-wide', m.sender === 'agent' ? 'text-gold-bright' : 'text-gold-ink')}>
                      {m.sender === 'agent' ? t('Agent') : m.sender === 'staff' ? ((m.meta?.via === 'phone') ? t('Team (phone)') : t('Team')) : m.sender === 'driver' ? t('Driver') : t('Automatic')}
                    </p>}
                    {m.media_url && (m.kind === 'image'
                      ? <img src={m.media_url} alt="" className="mb-1 max-h-64 rounded-lg" />
                      : <a href={m.media_url} target="_blank" rel="noreferrer" className="underline">{t('Open the file')}</a>)}
                    {loc?.maps_url && <a href={loc.maps_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline"><MapPin className="size-3.5" /> {t('Location pin')}</a>}
                    {m.body && <p className="bubble" dir="auto">{m.body}</p>}
                    <p className={cx('mt-0.5 flex items-center justify-end gap-1 text-[11px]', mine && m.sender === 'agent' ? 'text-on-navy-muted' : 'text-muted')}>
                      {clock(m.created_at, tenant.timezone)}
                      {mine && (m.status === 'queued' || m.status === 'sending' ? <Clock className="size-3" />
                        : m.status === 'failed' ? <span className="text-critical" title={m.error || ''}>{t('failed')}</span>
                        : m.status === 'read' ? <CheckCheck className="size-3" /> : <Check className="size-3" />)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottom} />
        </div>

        <footer className="border-t border-hairline bg-white p-3">
          {customer?.is_blocked ? <p className="text-center text-sm text-critical">{t('This customer is blocked. Unblock them in the side panel to reply.')}</p> : (
            <>
              {!human && <p className="mb-1.5 text-xs text-muted">{t('Sending a message takes this chat over — the agent stays quiet until you hand it back.')}</p>}
              <div className="flex items-end gap-2">
                <input ref={file} type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) attach(f); e.target.value = ''; }} />
                <Button variant="ghost" onClick={() => file.current?.click()} aria-label={t('Send a photo')}><ImagePlus className="size-5" /></Button>
                <Textarea rows={1} value={text} onChange={e => setText(e.target.value)} placeholder={t('Write to the customer…')} className="min-h-10 flex-1 resize-none"
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
                <Button variant="gold" busy={busy} onClick={() => send()} aria-label={t('Send')}><Send className="size-4" /></Button>
              </div>
            </>
          )}
        </footer>
      </section>

      {showSide && (
        <aside className="hidden w-80 shrink-0 space-y-3 overflow-y-auto border-s border-hairline bg-white p-3 xl:block">
          <Card title={t('Customer')}>
            <div className="space-y-1 text-sm">
              <p className="font-medium" dir="auto">{name}</p>
              <p className="text-muted">{phoneLabel(conv.wa_id, customer?.phone, customer?.phone_hidden)}</p>
              <p className="text-muted">{t('{n} orders · {spent} spent', { n: customer?.orders_count || 0, spent: money(customer?.total_spent || 0, sym) })}</p>
              {customer?.food_prefs && <p className="text-muted" dir="auto">{t('Avoids: {prefs}', { prefs: customer.food_prefs })}</p>}
              <Textarea className="mt-2" rows={2} placeholder={t('Notes for your team (the customer never sees them)')} value={notes}
                onChange={e => setNotes(e.target.value)}
                onBlur={() => customer && notes !== (customer.staff_notes || '') && run(async () => {
                  const { error } = await sb().from('customers').update({ staff_notes: notes }).eq('id', customer.id);
                  if (error) throw new Error(error.message);
                }, t('Note saved'))} />
              {customer && (
                <Button size="sm" variant="ghost" className="mt-1 text-critical" onClick={() => run(async () => {
                  const { error } = await sb().from('customers').update({ is_blocked: !customer.is_blocked }).eq('id', customer.id);
                  if (error) throw new Error(error.message);
                  await load();
                }, customer.is_blocked ? t('Unblocked') : t('Blocked — the agent ignores them now'))}>
                  <Ban className="size-4" /> {customer.is_blocked ? t('Unblock') : t('Block')}
                </Button>
              )}
            </div>
          </Card>

          <Card title={t('What the agent knows')}>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-muted">{t('Branch')}</dt><dd dir="auto">{conv.state?.branch?.name_ar || '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">{t('Delivery area')}</dt><dd dir="auto">{conv.state?.zone?.name || (conv.state?.location?.in_delivery_area === false ? t('outside the zones') : '—')}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted">{t('Order type')}</dt><dd>{details.delivery_method ? t(details.delivery_method) : '—'}</dd></div>
              {details.full_name && <div className="flex justify-between gap-2"><dt className="text-muted">{t('Name')}</dt><dd dir="auto">{details.full_name}</dd></div>}
              {(details.address_area || details.address_street) && <div><dt className="text-muted">{t('Address')}</dt><dd dir="auto">{[details.address_street, details.address_area, details.address_building && 'عمارة ' + details.address_building, details.address_floor && 'دور ' + details.address_floor, details.address_apartment && 'شقة ' + details.address_apartment].filter(Boolean).join('، ')}</dd></div>}
              {pending.length > 0 && <div><dt className="text-muted">{t('Waiting on a choice')}</dt><dd dir="auto">{pending.map(p => p.name).join('، ')}</dd></div>}
              {(conv.state?.memory_notes || []).length > 0 && <div><dt className="text-muted">{t('Notes')}</dt><dd className="text-xs">{conv.state?.memory_notes?.slice(-3).join(' · ')}</dd></div>}
            </dl>
          </Card>

          <Card title={t('Current cart')}>
            {!draft || !draft.cart.items.length ? <p className="text-sm text-muted">{t('Empty.')}</p> : (
              <div className="space-y-1 text-sm">
                {draft.cart.items.map(i => (
                  <p key={i.line_id} className="flex justify-between gap-2" dir="auto"><span>{i.display_name || i.item_name} {qty(i.quantity, i.unit)}</span><span>{i.gift ? t('free') : money(i.line_total, sym)}</span></p>
                ))}
                <p className="flex justify-between border-t border-hairline pt-1 font-semibold"><span>{t('Total')}</span><span>{money(draft.total, sym)}</span></p>
              </div>
            )}
          </Card>

          <Card title={t('Previous orders')}>
            {orders.length === 0 ? <p className="text-sm text-muted">{t('None yet.')}</p> : (
              <ul className="space-y-2 text-sm">
                {orders.map(o => (
                  <li key={o.id}>
                    <p className="flex justify-between"><strong>{o.order_no}</strong><span>{money(o.total, sym)}</span></p>
                    <p className="text-xs text-muted">{dateTime(o.placed_at, tenant.timezone)} · {statusLabel(o.status)}</p>
                  </li>
                ))}
              </ul>
            )}
            {addresses.length > 0 && <>
              <p className="label-caps mb-1 mt-3">{t('Saved addresses')}</p>
              {addresses.map(a => <p key={a.id} className="text-xs text-muted" dir="auto">{a.address_text}</p>)}
            </>}
          </Card>
        </aside>
      )}
    </div>
  );
}

export default function InboxPage() {
  return <Suspense fallback={<Spinner />}><InboxInner /></Suspense>;
}
