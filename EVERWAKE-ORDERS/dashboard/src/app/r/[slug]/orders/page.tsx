'use client';
import { Banknote, Bike, Check, ChefHat, Clock, Copy, CreditCard, MapPin, MessageCircle, Package, Phone, Send, Store, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Drawer, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useAction, useToast } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { clock, cx, dateTime, displayName, money, qty, statusLabel, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Driver, Order, OrderEvent, OrderStatus, Payment, PaymentStatus } from '@/lib/types';

// paying online: what the card on the board says
const PAY_BADGE: Record<PaymentStatus, { label: string; tone: 'positive' | 'caution' | 'critical' | 'neutral' } | null> = {
  none: null, pending: { label: 'Waiting for payment', tone: 'caution' }, paid: { label: 'Paid online', tone: 'positive' },
  expired: { label: 'Not paid', tone: 'critical' }, refunded: { label: 'Refunded', tone: 'neutral' }
};
const PAY_EVENT: Record<string, string> = {
  payment_link: 'Payment link sent', payment_paid: 'Paid', payment_expired: 'Payment link expired unpaid',
  payment_refunded: 'Refunded', payment_cash: 'Switched to cash'
};

const COLUMNS: { key: string; title: string; statuses: OrderStatus[] }[] = [
  { key: 'new', title: 'New', statuses: ['placed'] },
  { key: 'kitchen', title: 'In the kitchen', statuses: ['accepted', 'preparing'] },
  { key: 'out', title: 'Ready / on the way', statuses: ['ready', 'out_for_delivery'] },
  { key: 'done', title: 'Done today', statuses: ['delivered', 'picked_up', 'rejected', 'cancelled'] }
];

// what each order can do next, and what the customer hears (Settings → Messages)
function nextSteps(o: Order): { status: OrderStatus; label: string; variant: 'primary' | 'positive' | 'gold' }[] {
  const pickup = o.delivery_method === 'pickup';
  switch (o.status) {
    case 'placed': return [{ status: 'accepted', label: 'Accept', variant: 'positive' }];
    case 'accepted': return [{ status: 'preparing', label: 'Preparing', variant: 'primary' },
                             pickup ? { status: 'ready', label: 'Ready for pickup', variant: 'gold' } : { status: 'out_for_delivery', label: 'Out for delivery', variant: 'gold' }];
    case 'preparing': return [pickup ? { status: 'ready', label: 'Ready for pickup', variant: 'gold' } : { status: 'out_for_delivery', label: 'Out for delivery', variant: 'gold' }];
    case 'ready': return [{ status: 'picked_up', label: 'Picked up', variant: 'positive' }];
    case 'out_for_delivery': return [{ status: 'delivered', label: 'Delivered', variant: 'positive' }];
    default: return [];
  }
}

export default function OrdersBoard() {
  const { tenant, base } = useTenant();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [branch, setBranch] = useState('');
  const [open, setOpen] = useState<Order | null>(null);
  const [accepting, setAccepting] = useState<Order | null>(null);
  const [rejecting, setRejecting] = useState<{ order: Order; status: 'rejected' | 'cancelled' } | null>(null);
  const [eta, setEta] = useState('');
  const [reason, setReason] = useState('');
  const [, tick] = useState(0);
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    const db = sb();
    const since = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
    const { data } = await db.from('orders').select('*').eq('tenant_id', tenant.id).neq('status', 'draft')
      .or(`status.in.(placed,accepted,preparing,ready,out_for_delivery),placed_at.gte.${since}`)
      .order('placed_at', { ascending: true }).limit(300);
    setOrders((data || []) as Order[]);
  }, [tenant.id]);

  useEffect(() => {
    load();
    sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort').then(({ data }) => setBranches((data || []) as Branch[]));
    sb().from('drivers').select('id,tenant_id,name,phone,branch_ids,is_active').eq('tenant_id', tenant.id).eq('is_active', true).order('name')
      .then(({ data }) => setDrivers((data || []) as Driver[]));
    const ch = sb().channel('board-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, () => load())
      .subscribe();
    const t = setInterval(() => tick(x => x + 1), 30000);
    return () => { sb().removeChannel(ch); clearInterval(t); };
  }, [tenant.id, load]);

  const move = async (o: Order, status: OrderStatus, note?: string, etaText?: string) => {
    await run(async () => {
      const { error } = await sb().rpc('set_order_status', { p_order: o.id, p_status: status, p_note: note || null, p_notify: true, p_eta: etaText || null });
      if (error) throw new Error(error.message);
      await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
      await load();
    }, t('{no}: {status} — the customer was told on WhatsApp', { no: o.order_no, status: statusLabel(status) }));
  };

  // give the order to one of the restaurant's drivers; they get it on WhatsApp and in their app
  const assign = (o: Order, driverId: string) => run(async () => {
    const { error } = await sb().rpc('assign_driver', { p_order: o.id, p_driver: driverId || null, p_base: window.location.origin });
    if (error) throw new Error(error.message);
    await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
    await load();
  }, driverId ? t('{no}: given to {name}', { no: o.order_no, name: drivers.find(d => d.id === driverId)?.name || '' }) : undefined);

  const branchName = useMemo(() => Object.fromEntries(branches.map(b => [b.id, b.name_en || b.name_ar])), [branches]);
  const shown = (orders || []).filter(o => !branch || o.branch_id === branch);
  if (!orders) return <Spinner />;

  return (
    <div>
      <PageHeader title={t('Orders')} subtitle={t('Live. New orders ring and flash; every step you take is sent to the customer on WhatsApp.')}
        actions={branches.length > 1 && (
          <Select value={branch} onChange={e => setBranch(e.target.value)} className="w-48">
            <option value="">{t('All branches')}</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar}</option>)}
          </Select>
        )} />
      <PageGuide id="orders" steps={[
          t('A new order rings and lands in the first column. Tap it to see everything the customer asked for.'),
          t('Press Accept, or Reject with a reason. Every step you press is sent to the customer on WhatsApp.'),
          t('Move it on: Preparing, then Ready for pickup or Out for delivery, then done. For delivery, choose the driver in the order.'),
          t('Paying online: the order shows Paid, Waiting for payment or Not paid. From the order you can send a new link, switch to cash or mark it paid.')
        ]} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map(col => {
          const list = shown.filter(o => col.statuses.includes(o.status));
          return (
            <section key={col.key} className="flex min-h-[200px] flex-col rounded-xl bg-paper-sunk/60 p-2">
              <header className="flex items-center justify-between px-2 py-1.5">
                <h2 className="text-sm font-semibold">{t(col.title)}</h2>
                <Badge tone={col.key === 'new' && list.length ? 'gold' : 'neutral'}>{list.length}</Badge>
              </header>
              <div className="flex flex-col gap-2">
                {list.map(o => (
                  <article key={o.id} className={cx('cursor-pointer rounded-xl border bg-white p-3 shadow-sm transition hover:border-gold',
                    o.status === 'placed' ? 'border-gold ring-new' : 'border-hairline')} onClick={() => setOpen(o)}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">{o.order_no}</p>
                        <p className="text-xs text-muted">{clock(o.placed_at, tenant.timezone)} · {timeAgo(o.placed_at)}{o.branch_id && branches.length > 1 ? ` · ${branchName[o.branch_id]}` : ''}</p>
                      </div>
                      <Badge tone={o.delivery_method === 'pickup' ? 'navy' : 'gold'}>
                        {o.delivery_method === 'pickup' ? <><Store className="size-3" /> {t('Pickup')}</> : <><Bike className="size-3" /> {t('Delivery')}</>}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm font-medium" dir="auto">{displayName(o.customer as never)}</p>
                    <ul className="mt-1 space-y-0.5 text-sm text-muted" dir="auto">
                      {o.cart.items.slice(0, 4).map(i => <li key={i.line_id}>{i.display_name || i.item_name} {qty(i.quantity, i.unit)}{i.gift ? ' 🎁' : ''}</li>)}
                      {o.cart.items.length > 4 && <li>{t('+{n} more', { n: o.cart.items.length - 4 })}</li>}
                    </ul>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 font-semibold">{money(o.total, tenant.currency_symbol)}
                        {PAY_BADGE[o.payment_status] && <Badge tone={PAY_BADGE[o.payment_status]!.tone}><CreditCard className="size-3" /> {t(PAY_BADGE[o.payment_status]!.label)}</Badge>}</span>
                      {o.status === 'rejected' || o.status === 'cancelled' ? <Badge tone="critical">{statusLabel(o.status)}</Badge>
                        : col.key === 'done' ? <Badge tone="positive">{statusLabel(o.status)}</Badge>
                        : col.key !== 'new' ? <Badge>{statusLabel(o.status)}</Badge> : null}
                    </div>
                    {o.delivery_method !== 'pickup' && drivers.length > 0 && ['placed', 'accepted', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) && (
                      <div className="mt-2 flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        <Bike className="size-4 shrink-0 text-muted" />
                        <Select value={o.driver_id || ''} disabled={busy} onChange={e => assign(o, e.target.value)} className="h-8 py-0 text-xs">
                          <option value="">{t('No driver yet')}</option>
                          {drivers.filter(d => !d.branch_ids.length || !o.branch_id || d.branch_ids.includes(o.branch_id)).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </Select>
                      </div>
                    )}
                    {o.status === 'out_for_delivery' && o.delivery_eta_min != null && o.delivery_track_at && Date.now() - new Date(o.delivery_track_at).getTime() < 10 * 60000 && (
                      <p className="mt-1 text-xs font-medium text-positive">{t('{km} km · about {min} min', { km: o.delivery_km_left ?? '—', min: o.delivery_eta_min })}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5" onClick={e => e.stopPropagation()}>
                      {nextSteps(o).map(s => (
                        <Button key={s.status} size="sm" variant={s.variant} disabled={busy}
                          onClick={() => s.status === 'accepted' ? (setEta(''), setAccepting(o)) : move(o, s.status)}>{t(s.label)}</Button>
                      ))}
                      {o.status === 'placed' && <Button size="sm" variant="outline" onClick={() => { setReason(''); setRejecting({ order: o, status: 'rejected' }); }}>{t('Reject')}</Button>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <OrderDrawer order={open ? orders.find(o => o.id === open.id) || open : null} onClose={() => setOpen(null)} base={base} branchName={branchName}
        onCancel={(o) => { setReason(''); setRejecting({ order: o, status: 'cancelled' }); }} onChanged={load} />

      <Modal open={!!accepting} onClose={() => setAccepting(null)} title={t('Accept {no}', { no: accepting?.order_no })}
        footer={<><Button variant="outline" onClick={() => setAccepting(null)}>{t('Back')}</Button>
          <Button variant="positive" busy={busy} onClick={async () => { if (accepting) await move(accepting, 'accepted', undefined, eta); setAccepting(null); }}>{t('Accept and tell the customer')}</Button></>}>
        <Field label={t('How long until it reaches them? (optional)')} hint={t('Goes into the WhatsApp message, e.g. “45 minutes”.')}>
          <Input value={eta} onChange={e => setEta(e.target.value)} placeholder="45 دقيقة" />
        </Field>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {['20 دقيقة', '30 دقيقة', '45 دقيقة', 'ساعة'].map(x => <Button key={x} size="sm" variant="outline" onClick={() => setEta(x)}>{x}</Button>)}
        </div>
      </Modal>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title={rejecting?.status === 'rejected' ? t('Reject {no}', { no: rejecting?.order.order_no }) : t('Cancel {no}', { no: rejecting?.order.order_no })}
        footer={<><Button variant="outline" onClick={() => setRejecting(null)}>{t('Back')}</Button>
          <Button variant="danger" busy={busy} onClick={async () => { if (rejecting) await move(rejecting.order, rejecting.status, reason); setRejecting(null); }}>
            {rejecting?.status === 'rejected' ? t('Reject and tell the customer') : t('Cancel and tell the customer')}</Button></>}>
        <Field label={t('Reason (the customer sees it)')}><Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="الفرع زحمة جداً دلوقتي" /></Field>
      </Modal>
    </div>
  );
}

function OrderDrawer({ order, onClose, base, branchName, onCancel, onChanged }:
  { order: Order | null; onClose: () => void; base: string; branchName: Record<string, string>; onCancel: (o: Order) => void; onChanged: () => Promise<void> }) {
  const { tenant } = useTenant();
  const t = useT();
  const toast = useToast();
  const { busy, run } = useAction();
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [linkFor, setLinkFor] = useState<string | null>(null);     // the amount for a new link, while the box is open
  const loadMore = useCallback(async (id: number) => {
    const [e, p] = await Promise.all([
      sb().from('order_events').select('*').eq('order_id', id).order('created_at'),
      sb().from('payments').select('id,tenant_id,order_id,provider,ref,amount,currency,status,link_url,method,card_brand,card_last4,attempts,last_error,expires_at,reminded_at,paid_at,created_by,is_live,created_at')
        .eq('order_id', id).order('created_at', { ascending: false })
    ]);
    setEvents((e.data || []) as OrderEvent[]);
    setPayments((p.data || []) as Payment[]);
  }, []);
  useEffect(() => { if (order) { loadMore(order.id); setLinkFor(null); } }, [order?.id, order?.payment_status, loadMore]);   // eslint-disable-line react-hooks/exhaustive-deps

  // a new payment link from the team, sent to the customer on WhatsApp
  const sendLink = () => run(async () => {
    if (!order) return;
    const res = await fetch('/api/pay/link', { method: 'POST', headers: { 'content-type': 'application/json' },
                                                body: JSON.stringify({ order_id: order.id, amount: linkFor || null }) });
    const r = await res.json() as { ok: boolean; status?: string; reason?: string; error?: string; fact?: string };
    if (!r.ok) {
      if (r.status === 'NOT_CONNECTED') throw new Error(t('Paymob is not connected — Settings → Online payments.'));
      if (r.status === 'TOTAL_NOT_FINAL') throw new Error(t('The total is not final ({reason}). Type the amount to charge.', { reason: r.reason || '' }));
      throw new Error(r.error || r.fact || r.status || 'error');
    }
    setLinkFor(null);
    await onChanged(); await loadMore(order.id);
  }, t('Payment link sent to the customer on WhatsApp'));
  const setPayment = (action: 'cash' | 'mark_paid') => run(async () => {
    if (!order) return;
    const { error } = await sb().rpc('set_order_payment', { p_order: order.id, p_action: action, p_notify: true });
    if (error) throw new Error(error.message);
    if (action === 'cash') await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
    await onChanged(); await loadMore(order.id);
  }, action === 'cash' ? t('Switched to cash — the customer was told') : t('Marked as paid'));
  if (!order) return null;
  const c = (order.customer || {}) as Record<string, string>;
  const sym = tenant.currency_symbol;
  const active = !['delivered', 'picked_up', 'rejected', 'cancelled'].includes(order.status);
  return (
    <Drawer open={!!order} onClose={onClose} title={t('Order {no}', { no: order.order_no })}
      footer={<>
        {active && <Button variant="outline" onClick={() => { onClose(); onCancel(order); }}><X className="size-4" /> {t('Cancel order')}</Button>}
        {order.conversation_id && <Link href={`${base}/inbox?c=${order.conversation_id}`}><Button variant="primary"><MessageCircle className="size-4" /> {t('Open the chat')}</Button></Link>}
      </>}>
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge tone="gold">{statusLabel(order.status)}</Badge>
          <Badge>{order.delivery_method === 'pickup' ? t('Pickup') : t('Delivery')}</Badge>
          {order.branch_id && <Badge><Store className="size-3" /> {branchName[order.branch_id]}</Badge>}
          <Badge><Clock className="size-3" /> {dateTime(order.placed_at, tenant.timezone)}</Badge>
          {order.eta_text && <Badge>{t('ETA {eta}', { eta: order.eta_text })}</Badge>}
        </div>

        <section>
          <p className="label-caps mb-2">{t('Customer')}</p>
          <p className="font-medium" dir="auto">{c.full_name || '—'}</p>
          <p className="flex items-center gap-1.5 text-muted"><Phone className="size-3.5" /> {c.phone ? '+' + c.phone : t('hidden by WhatsApp — reply from the chat')}{c.alt_phone ? ` / ${c.alt_phone}` : ''}</p>
          {order.delivery_method !== 'pickup' && (
            <p className="mt-1 flex items-start gap-1.5" dir="auto"><MapPin className="mt-0.5 size-3.5 shrink-0" /> {order.address_text}</p>
          )}
          {order.location?.maps_url && <a href={order.location.maps_url} target="_blank" rel="noreferrer" className="text-gold-ink underline">{t('Open the map pin')}</a>}
          <p className="mt-1 text-muted">{t('Payment: {method}', { method: order.payment_method ? t(order.payment_method) : '—' })}</p>
          {(order.payment_method === 'online' || order.payment_status !== 'none' || payments.length > 0) && (
            <div className="mt-2 space-y-2 rounded-lg border border-hairline p-3">
              <p className="flex flex-wrap items-center gap-2">
                <CreditCard className="size-4 text-gold-ink" />
                {PAY_BADGE[order.payment_status] ? <Badge tone={PAY_BADGE[order.payment_status]!.tone}>{t(PAY_BADGE[order.payment_status]!.label)}</Badge> : <Badge>{t('No payment link yet')}</Badge>}
                {order.payment_status === 'paid' && order.paid_amount != null && <span className="font-medium">{money(order.paid_amount, sym)}</span>}
              </p>
              {payments.slice(0, 3).map(p => (
                <div key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>{money(p.amount, sym)} · {t(p.status)} · {timeAgo(p.created_at)}</span>
                  {p.card_last4 && <span dir="ltr">{p.card_brand} •••• {p.card_last4}</span>}
                  {p.status === 'pending' && p.attempts > 0 && <span className="text-critical">{t('{n} declined tries', { n: p.attempts })}{p.last_error ? ` — ${p.last_error}` : ''}</span>}
                  {!p.is_live && <Badge>{t('Test mode')}</Badge>}
                  {p.status === 'pending' && p.link_url && (
                    <button className="inline-flex items-center gap-1 text-gold-ink hover:underline"
                      onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/p/${p.ref}`); toast(t('Copied')); }}>
                      <Copy className="size-3" /> {t('Copy the link')}</button>
                  )}
                </div>
              ))}
              {active && order.payment_status !== 'paid' && (linkFor === null
                ? <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="gold" disabled={busy} onClick={() => setLinkFor('')}><Send className="size-3.5 rtl:rotate-180" /> {payments.length ? t('Send a new payment link') : t('Send a payment link')}</Button>
                    {order.payment_method !== 'cash' && <Button size="sm" variant="outline" disabled={busy} onClick={() => setPayment('cash')}><Banknote className="size-3.5" /> {t('Switch to cash')}</Button>}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPayment('mark_paid')}>{t('Mark as paid')}</Button>
                  </div>
                : <div className="flex flex-wrap items-end gap-2">
                    <Field label={t('Amount ({currency})', { currency: tenant.currency })} hint={t('Empty = the order total.')}>
                      <Input type="number" min={1} value={linkFor} onChange={e => setLinkFor(e.target.value)} placeholder={String(order.total)} className="w-32" />
                    </Field>
                    <Button size="sm" variant="gold" busy={busy} onClick={sendLink}>{t('Send')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setLinkFor(null)}>{t('Cancel')}</Button>
                  </div>)}
            </div>
          )}
          {order.notes && <p className="mt-1 rounded-lg bg-gold-wash p-2" dir="auto">{t('Note: {note}', { note: order.notes })}</p>}
        </section>

        <section>
          <p className="label-caps mb-2">{t('Items')}</p>
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {order.cart.items.map(i => (
              <li key={i.line_id} className="flex justify-between gap-3 px-3 py-2">
                <div dir="auto">
                  <p className="font-medium">{i.display_name || i.item_name} <span className="text-muted">{qty(i.quantity, i.unit)}</span></p>
                  {i.choices?.length > 0 && <p className="text-xs text-muted">{i.choices.map(ch => ch.selected.map(s => s.name).join(' + ')).join(' · ')}</p>}
                  {i.notes && <p className="text-xs text-caution">{i.notes}</p>}
                </div>
                <span className="whitespace-nowrap">{i.gift ? t('free') : money(i.line_total, sym)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1">
            <div className="flex justify-between"><dt className="text-muted">{t('Subtotal')}</dt><dd>{money(order.subtotal, sym)}</dd></div>
            {order.applied_offers?.filter(a => a.amount > 0).map(a => (
              <div key={a.title} className="flex justify-between text-positive"><dt dir="auto">{a.title}</dt><dd>−{money(a.amount, sym)}</dd></div>
            ))}
            {order.vat != null && <div className="flex justify-between"><dt className="text-muted">{t('VAT')}</dt><dd>{money(order.vat, sym)}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted">{t('Delivery')}</dt><dd>{order.delivery_fee == null ? t('branch confirms') : money(order.delivery_fee, sym)}</dd></div>
            <div className="flex justify-between border-t border-hairline pt-1 text-base font-semibold"><dt>{t('Total')}</dt><dd>{money(order.total, sym)}</dd></div>
          </dl>
        </section>

        <section>
          <p className="label-caps mb-2">{t('History')}</p>
          <ol className="space-y-1.5">
            {events.map(e => (
              <li key={e.id} className="flex items-center gap-2">
                {PAY_EVENT[e.status] ? <CreditCard className={cx('size-4', e.status === 'payment_expired' ? 'text-critical' : 'text-gold-ink')} />
                  : e.status === 'placed' ? <Package className="size-4 text-gold" /> : e.status === 'rejected' || e.status === 'cancelled' ? <X className="size-4 text-critical" /> : e.status === 'accepted' || e.status === 'preparing' ? <ChefHat className="size-4" /> : <Check className="size-4 text-positive" />}
                <span>{PAY_EVENT[e.status] ? t(PAY_EVENT[e.status]) : statusLabel(e.status as OrderStatus)}</span>
                <span className="text-muted">{clock(e.created_at, tenant.timezone)} · {e.by_role === 'agent' ? t('by the agent') : t(e.by_role)}{e.notified ? ' · ' + t('customer told') : ''}</span>
                {e.note && <span className="text-muted" dir="auto">— {e.note}</span>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Drawer>
  );
}
