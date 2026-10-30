'use client';
import { Banknote, Check, ChefHat, Clock, Mic, MonitorPlay, QrCode as QrIcon, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Empty, Modal, Select, Spinner, Textarea, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { askNotificationPermission, chime } from '@/lib/alerts';
import { cx, money, qty, statusLabel } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Order, OrderStatus, QrCheckout } from '@/lib/types';

// The kitchen's screen for one branch: cash orders waiting at the counter
// (the cashier's "paid" sends them in), then new → preparing → ready, from
// WhatsApp and QR alike. Hold the microphone and say it: "123 جاهز",
// "قول لصاحب طلب 123 إن…", "الكفتة خلصت" — the screen shows what it
// understood and does it in 3 seconds unless someone taps cancel.
interface Heard {
  heard: string; action: 'start' | 'ready' | 'collected' | 'note' | 'sold_out' | 'back_in_stock' | 'unknown'; said_order: string | null;
  ambiguous?: boolean; order: { id: number; order_no: string; status: string; table: string | null; items: string[] } | null;
  note: string | null; until: string; items: { id: string; code: string; name: string }[]; error?: string;
}

const NEXT: Record<string, { to: string; label: string }> = {
  placed: { to: 'preparing', label: 'Start' }, accepted: { to: 'preparing', label: 'Start' }, preparing: { to: 'ready', label: 'Ready' }
};

export default function Kitchen() {
  const { tenant, base } = useTenant();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState('');
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [counter, setCounter] = useState<QrCheckout[]>([]);
  const [noteFor, setNoteFor] = useState<Order | null>(null);
  const [note, setNote] = useState('');
  const [heard, setHeard] = useState<Heard | null>(null);
  const [left, setLeft] = useState(0);
  const [recording, setRecording] = useState(false);
  const [thinking, setThinking] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const known = useRef<Set<number>>(new Set());
  const { busy, run } = useAction();
  const toast = useToast();
  const t = useT();

  useEffect(() => {
    sb().from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort').then(({ data }) => {
      const list = (data || []) as Branch[];
      setBranches(list);
      // a link from the QR settings names the branch; otherwise the one this screen used last
      let saved = new URLSearchParams(window.location.search).get('branch') || '';
      if (!saved) try { saved = localStorage.getItem('kitchen-branch-' + tenant.id) || ''; } catch { /* private mode */ }
      setBranch(list.some(b => b.id === saved) ? saved : list[0]?.id || '');
    });
    askNotificationPermission();
  }, [tenant.id]);
  useEffect(() => { if (branch) try { localStorage.setItem('kitchen-branch-' + tenant.id, branch); } catch { /* private mode */ } }, [branch, tenant.id]);

  const load = useCallback(async () => {
    if (!branch) return;
    const since = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
    const [o, c] = await Promise.all([
      sb().from('orders').select('*').eq('tenant_id', tenant.id).eq('branch_id', branch)
        .in('status', ['placed', 'accepted', 'preparing', 'ready']).gte('placed_at', since).order('placed_at'),
      sb().from('qr_checkouts').select('*').eq('tenant_id', tenant.id).eq('branch_id', branch).eq('status', 'awaiting_payment')
        .eq('payment_method', 'cash').gt('expires_at', new Date().toISOString()).order('created_at')
    ]);
    const list = (o.data || []) as Order[];
    // a new order rings (not the ones already on screen when it opened)
    if (orders !== null && list.some(x => x.status === 'placed' && !known.current.has(x.id))) chime();
    known.current = new Set(list.map(x => x.id));
    setOrders(list);
    setCounter((c.data || []) as QrCheckout[]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, branch]);
  useEffect(() => {
    if (!branch) return;
    load();
    const ch = sb().channel('kitchen-' + branch)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'qr_checkouts', filter: `tenant_id=eq.${tenant.id}` }, () => load())
      .subscribe();
    const tick = setInterval(load, 30000);
    return () => { sb().removeChannel(ch); clearInterval(tick); };
  }, [branch, tenant.id, load]);

  const ping = () => fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
  const move = (o: Order, status: string) => run(async () => {
    const { error } = await sb().rpc('set_order_status', { p_order: o.id, p_status: status, p_note: null, p_notify: true, p_eta: null });
    if (error) throw new Error(error.message);
    ping(); await load();
  }, t('{no}: {status}', { no: o.order_no, status: statusLabel(status as OrderStatus) }));
  const paid = (c: QrCheckout) => run(async () => {
    const { data, error } = await sb().rpc('qr_cashier_paid', { p_checkout: c.id });
    if (error) throw new Error(error.message);
    if (!(data as { ok: boolean }).ok) throw new Error(t('This ticket expired — ask the customer to order again'));
    ping(); await load();
  }, t('Paid — it is in the kitchen now'));
  const cancel = (c: QrCheckout) => run(async () => {
    const { error } = await sb().rpc('qr_checkout_cancel', { p_checkout: c.id, p_reason: null });
    if (error) throw new Error(error.message);
    await load();
  });
  const sendNote = (o: Order, text: string) => run(async () => {
    const { data, error } = await sb().rpc('order_note_to_customer', { p_order: o.id, p_text: text });
    if (error) throw new Error(error.message);
    ping(); setNoteFor(null); setNote('');
    return data;
  }, t('Sent to the customer'));

  // ---- the voice button ------------------------------------------------------------------------
  const startRec = async () => {
    if (recording || thinking) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = async () => {
        stream.getTracks().forEach(tr => tr.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        if (blob.size < 2000) return;
        setThinking(true);
        try {
          const b64 = await new Promise<string>(ok => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
          const res = await fetch('/api/kitchen/voice', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tenant_id: tenant.id, branch_id: branch, audio: b64, mime: blob.type }) });
          const j = await res.json() as Heard & { error?: string };
          if (!res.ok) throw new Error(j.error || 'Could not hear it');
          setHeard(j); setLeft(j.action === 'unknown' ? 0 : 3);
        } catch (e) { toast(e instanceof Error ? e.message : String(e), 'critical'); }
        finally { setThinking(false); }
      };
      r.start(); rec.current = r; setRecording(true);
    } catch { toast(t('Allow the microphone for this page'), 'critical'); }
  };
  const stopRec = () => { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); setRecording(false); };

  const doHeard = useCallback(async (h: Heard) => {
    setHeard(null);
    const o = h.order ? (orders || []).find(x => x.id === h.order!.id) : null;
    if (h.action === 'start' && o) return move(o, 'preparing');
    if (h.action === 'ready' && o) return move(o, 'ready');
    if (h.action === 'collected' && o) return move(o, o.delivery_method === 'delivery' ? 'out_for_delivery' : 'picked_up');
    if (h.action === 'note' && o && h.note) return sendNote(o, h.note);
    if ((h.action === 'sold_out' || h.action === 'back_in_stock') && h.items.length) {
      const until = h.action === 'back_in_stock' ? null
        : h.until === 'one_hour' ? new Date(Date.now() + 3600e3).toISOString()
        : h.until === 'two_hours' ? new Date(Date.now() + 7200e3).toISOString()
        : h.until === 'until_back' ? null
        : (() => { const d = new Date(); d.setHours(d.getHours() < 5 ? 5 : 29, 0, 0, 0); return d.toISOString(); })();   // the end of today's service
      return run(async () => {
        for (const i of h.items) {
          const { error } = await sb().rpc('set_item_availability', { p_item: i.id, p_available: h.action === 'back_in_stock', p_branch: branch, p_until: until });
          if (error) throw new Error(error.message);
        }
      }, h.action === 'sold_out' ? t('{items}: sold out at this branch — the agent and the QR menu stop offering it', { items: h.items.map(i => i.name).join('، ') })
                                 : t('{items}: back on the menu', { items: h.items.map(i => i.name).join('، ') }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, branch]);
  // confirms itself after 3 seconds unless cancelled
  useEffect(() => {
    if (!heard || heard.action === 'unknown') return;
    if (left <= 0) { doHeard(heard); return; }
    const id = setTimeout(() => setLeft(x => x - 1), 1000);
    return () => clearTimeout(id);
  }, [heard, left, doHeard]);

  const cols = useMemo(() => {
    const list = orders || [];
    return [
      { key: 'new', title: t('New'), list: list.filter(o => o.status === 'placed' || o.status === 'accepted') },
      { key: 'prep', title: t('Preparing'), list: list.filter(o => o.status === 'preparing') },
      { key: 'ready', title: t('Ready'), list: list.filter(o => o.status === 'ready') }
    ];
  }, [orders, t]);

  if (!branches.length) return <Spinner />;
  const heardLine = (h: Heard) => {
    const items = h.items.map(i => i.name).join('، ');
    switch (h.action) {
      case 'start': return t('Order {no} → preparing', { no: h.order?.order_no || '' });
      case 'ready': return t('Order {no} → ready (the customer is told)', { no: h.order?.order_no || '' });
      case 'collected': return t('Order {no} → collected', { no: h.order?.order_no || '' });
      case 'note': return t('To the customer of {no}: “{note}”', { no: h.order?.order_no || '', note: h.note || '' });
      case 'sold_out': return t('{items} → sold out at this branch', { items });
      case 'back_in_stock': return t('{items} → back on the menu', { items });
      default: return h.said_order && !h.order ? t('No open order {no} at this branch', { no: h.said_order }) : t('Not understood — try again, or tap it on the screen');
    }
  };

  return (
    <div className="-mx-4 -my-6 min-h-[calc(100vh-3.5rem)] bg-navy-deep p-4 text-white lg:-mx-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ChefHat className="size-6 text-gold-bright" />
        <h1 className="text-xl font-bold">{t('Kitchen')}</h1>
        <Select value={branch} onChange={e => setBranch(e.target.value)} className="h-9 w-auto bg-white text-ink">
          {branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar}</option>)}
        </Select>
        <div className="flex-1" />
        <Link href={`${base}/kitchen/tv?branch=${branch}`} target="_blank"><Button size="sm" variant="outline"><MonitorPlay className="size-4" /> {t('Ready screen for customers')}</Button></Link>
        <Link href={`${base}/settings/qr`}><Button size="sm" variant="outline"><QrIcon className="size-4" /> {t('QR codes')}</Button></Link>
        <button onPointerDown={startRec} onPointerUp={stopRec} onPointerLeave={() => recording && stopRec()} disabled={thinking}
          className={cx('flex h-12 select-none items-center gap-2 rounded-full px-6 text-base font-bold shadow-lg touch-none',
                        recording ? 'animate-pulse bg-critical text-white' : 'bg-gold text-navy')}>
          <Mic className="size-5" /> {thinking ? t('Understanding…') : recording ? t('Listening — let go to send') : t('Hold and speak')}
        </button>
      </div>

      {heard && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 text-ink shadow-xl">
          <Mic className="size-5 text-gold-ink" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted" dir="auto">“{heard.heard}”</p>
            <p className="text-lg font-bold" dir="auto">{heardLine(heard)}</p>
          </div>
          {heard.action !== 'unknown' && <Button variant="positive" onClick={() => doHeard(heard)}><Check className="size-4" /> {t('Do it')} ({left})</Button>}
          <Button variant="outline" onClick={() => setHeard(null)}><X className="size-4" /> {t('Cancel')}</Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-4">
        <section className="space-y-3 rounded-2xl bg-white/5 p-3">
          <h2 className="flex items-center gap-2 font-semibold text-gold-bright"><Banknote className="size-5" /> {t('At the counter — waiting to pay')}</h2>
          {counter.length === 0 && <p className="text-sm text-on-navy-muted">{t('No one waiting.')}</p>}
          {counter.map(c => (
            <div key={c.id} className="rounded-xl bg-white p-3 text-ink">
              <div className="flex items-center justify-between">
                <span className="text-4xl font-black">#{c.ticket}</span>
                <b className="text-lg">{money(c.total, tenant.currency_symbol)}</b>
              </div>
              <p className="text-xs text-muted">{c.table_label ? `${t('Table {n}', { n: c.table_label })} · ` : ''}{c.cart.items.length} {t('items')}{c.customer.full_name ? ` · ${c.customer.full_name}` : ''}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="positive" busy={busy} className="flex-1" onClick={() => paid(c)}><Check className="size-4" /> {t('Paid')}</Button>
                <Button size="sm" variant="ghost" onClick={() => cancel(c)}><X className="size-4" /></Button>
              </div>
            </div>
          ))}
        </section>
        {cols.map(col => (
          <section key={col.key} className="space-y-3 rounded-2xl bg-white/5 p-3">
            <h2 className="font-semibold">{col.title} <span className="text-on-navy-muted">({col.list.length})</span></h2>
            {col.list.length === 0 && <Empty title={t('Nothing here')}><span /></Empty>}
            {col.list.map(o => {
              const late = o.ready_by && new Date(o.ready_by).getTime() < Date.now() && o.status !== 'ready';
              const mins = o.ready_by ? Math.round((new Date(o.ready_by).getTime() - Date.now()) / 60000) : null;
              const next = NEXT[o.status];
              return (
                <div key={o.id} className={cx('rounded-xl bg-white p-3 text-ink', late && 'ring-4 ring-critical')}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="whitespace-nowrap text-2xl font-black tracking-tight"><bdi>{o.order_no}</bdi></span>
                    <span className="flex flex-col items-end gap-1">
                      <Badge tone={o.source === 'qr' ? 'gold' : 'navy'}>{o.source === 'qr' ? 'QR' : 'WhatsApp'}</Badge>
                      {mins !== null && o.status !== 'ready' && <span className={cx('flex items-center gap-1 text-xs', late ? 'font-bold text-critical' : 'text-muted')}><Clock className="size-3" /> {mins >= 0 ? `${mins}′` : `+${-mins}′`}</span>}
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-gold-ink">
                    {o.table_label ? t('Table {n}', { n: o.table_label }) : o.delivery_method === 'delivery' ? t('Delivery') : t('Pickup')}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-sm" dir="auto">
                    {o.cart.items.map(i => (
                      <li key={i.line_id}><b>{qty(i.quantity, i.unit)}</b> {i.display_name || i.item_name}{i.notes ? <span className="text-critical"> · {i.notes}</span> : null}</li>
                    ))}
                  </ul>
                  {o.notes && <p className="mt-1 rounded bg-caution-wash px-2 py-1 text-xs text-caution" dir="auto">{o.notes}</p>}
                  <div className="mt-2 flex gap-2">
                    {next && <Button size="sm" variant={next.to === 'ready' ? 'positive' : 'gold'} busy={busy} className="flex-1" onClick={() => move(o, next.to)}>{t(next.label)}</Button>}
                    {o.status === 'ready' && (
                      <Button size="sm" variant="primary" busy={busy} className="flex-1" onClick={() => move(o, o.delivery_method === 'delivery' ? 'out_for_delivery' : 'picked_up')}>
                        {o.delivery_method === 'delivery' ? t('Out for delivery') : o.table_label ? t('Served') : t('Collected')}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => { setNoteFor(o); setNote(''); }} title={t('Tell the customer')}><Send className="size-4" /></Button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <Modal open={!!noteFor} onClose={() => setNoteFor(null)} title={t('Tell the customer of {no}', { no: noteFor?.order_no || '' })}
        footer={<><Button variant="ghost" onClick={() => setNoteFor(null)}>{t('Cancel')}</Button>
                  <Button variant="gold" busy={busy} disabled={!note.trim()} onClick={() => noteFor && sendNote(noteFor, note)}>{t('Send')}</Button></>}>
        <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="الطحينة خلصت، ينفع نحطلك بابا غنوج بدالها؟" />
        <p className="mt-1 text-xs text-muted">{t('It shows on their order page, and on WhatsApp if they chose it.')}</p>
      </Modal>
    </div>
  );
}
