'use client';
import { Banknote, Bike, Check, ChefHat, Maximize2, Mic, Minimize2, MonitorPlay, QrCode as QrIcon, Send, ShoppingBag, UtensilsCrossed, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Spinner, Textarea, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { askNotificationPermission, chime } from '@/lib/alerts';
import { cx, money, qty, statusLabel } from '@/lib/format';
import { lalezar } from '@/lib/fonts';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Order, OrderStatus, QrCheckout } from '@/lib/types';

// The kitchen's screen for one branch: cash orders waiting at the counter
// (the cashier's "paid" sends them in), then new → preparing → ready, from
// WhatsApp and QR alike. Hold the microphone and say it: "123 جاهز",
// "قول لصاحب طلب 123 إن…", "الكفتة خلصت" — the screen shows what it
// understood and does it in 3 seconds unless someone taps cancel.
//
// Each order is a paper ticket on a dark rail. A bar under its number fills
// towards the promised time (green, then amber, then red when late); a new
// one drops in and glows for a moment; the clock and the "live" dot show the
// screen is listening.
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
  const loaded = useRef(false);
  const arrived = useRef(new Map<number, number>());
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const [level, setLevel] = useState(0);
  const [now, setNow] = useState(Date.now());
  const { busy, run } = useAction();
  const toast = useToast();
  const { t, lang } = useLang();
  const root = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);

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
    // a new order rings and glows (not the ones already on screen when it opened)
    const fresh = list.filter(x => !known.current.has(x.id));
    if (loaded.current) {
      fresh.forEach(x => arrived.current.set(x.id, Date.now()));
      if (fresh.some(x => x.status === 'placed' || x.status === 'accepted')) chime();
    }
    loaded.current = true;
    known.current = new Set(list.map(x => x.id));
    setOrders(list);
    setCounter((c.data || []) as QrCheckout[]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, branch]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(id); }, []);
  // full screen: the kitchen covers everything; the browser's own full screen where it has one
  // (a phone without it still gets the cover), and Esc or the button brings the dashboard back
  useEffect(() => {
    const left = () => { if (!document.fullscreenElement) setFull(false); };
    document.addEventListener('fullscreenchange', left);
    return () => document.removeEventListener('fullscreenchange', left);
  }, []);
  const toggleFull = async () => {
    if (full) { setFull(false); if (document.fullscreenElement) await document.exitFullscreen().catch(() => null); return; }
    setFull(true);
    await root.current?.requestFullscreen?.().catch(() => null);
  };
  useEffect(() => {
    if (!branch) return;
    loaded.current = false; known.current = new Set();
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
      // the button's ring follows the voice, so the cook sees it is hearing them
      try {
        const ctx = new AudioContext(), an = ctx.createAnalyser();
        an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let sum = 0; for (const v of buf) sum += (v - 128) * (v - 128);
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) / 40));
          if (meter.current) meter.current.raf = requestAnimationFrame(tick);
        };
        meter.current = { ctx, raf: requestAnimationFrame(tick) };
      } catch { /* no meter */ }
      r.start(); rec.current = r; setRecording(true);
    } catch { toast(t('Allow the microphone for this page'), 'critical'); }
  };
  const stopRec = () => {
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
    if (meter.current) { cancelAnimationFrame(meter.current.raf); meter.current.ctx.close().catch(() => null); meter.current = null; }
    setLevel(0); setRecording(false);
  };

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

  const inKitchen = (orders || []).filter(o => o.status !== 'ready');
  const timeParts = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US',
    { timeZone: tenant.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(now));
  const part = (k: string) => timeParts.find(p => p.type === k)?.value || '';
  const oldest = inKitchen.reduce((m, o) => Math.max(m, Math.round((now - new Date(o.placed_at || now).getTime()) / 60000)), 0);
  const COL = {
    counter: { color: '#F2B544', icon: Banknote, empty: t('No one waiting.'), sub: t('Waiting to pay') },
    new: { color: '#F2C46D', icon: QrIcon, empty: t('No new orders'), sub: '' },
    prep: { color: '#6FA8DC', icon: ChefHat, empty: t('Nothing on the fire'), sub: '' },
    ready: { color: '#45C486', icon: Check, empty: t('Nothing waiting to go out'), sub: '' }
  } as const;
  // a plain function, not a component: the tickets inside keep their place between renders
  const column = (k: keyof typeof COL, title: string, count: number, children: React.ReactNode) => {
    const c = COL[k];
    return (
      <section key={k} className="flex min-h-[62vh] flex-col rounded-[22px] bg-white/[.045] p-3" style={{ boxShadow: `inset 0 3px 0 ${c.color}` }}>
        <header className="mb-3 flex items-center justify-between gap-2 px-1 pt-1">
          <h2 className="flex min-w-0 items-center gap-2 text-[17px] font-semibold">
            <c.icon className="size-5 shrink-0" style={{ color: c.color }} aria-hidden />
            <span className="truncate">{title}</span>
            {c.sub && <span className="truncate text-sm font-normal text-white/50">{c.sub}</span>}
          </h2>
          <span key={count} className="board qr-pop text-[34px] tabular-nums" style={{ color: c.color }}>{count}</span>
        </header>
        {count === 0
          ? <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-white/10 py-10 text-white/35">
              <c.icon className="size-8" aria-hidden /><span className="text-sm">{c.empty}</span>
            </div>
          : <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">{children}</div>}
      </section>
    );
  };

  return (
    <div ref={root} className={cx('bg-[#0E1418] p-4 text-white lg:p-5', lalezar.variable,
                                  full ? 'fixed inset-0 z-50 overflow-y-auto' : 'min-h-[calc(100dvh-3.5rem)]')}>
      {/* the rail's head: which branch, the time, that it is live, and the voice button */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-white/[.07]"><ChefHat className="size-6 text-[#F2C46D]" aria-hidden /></span>
          <div>
            <label className="inline-flex items-center gap-2">
              <span className="sr-only">{t('Branch')}</span>
              <select value={branch} onChange={e => setBranch(e.target.value)}
                className="board cursor-pointer appearance-none bg-transparent text-[28px] text-white outline-none focus-visible:underline">
                {branches.map(b => <option key={b.id} value={b.id} className="text-base text-ink">{(lang === 'ar' ? b.name_ar : b.name_en) || b.name_ar}</option>)}
              </select>
              {branches.length > 1 && <span className="pointer-events-none text-white/50" aria-hidden>▾</span>}
            </label>
            <p className="flex items-center gap-2 text-sm text-white/60">
              <span className="kds-live size-2 rounded-full bg-[#45C486]" aria-hidden /> {t('Live')}
              {inKitchen.length > 0 && <span className="ms-2">{t('{n} in the kitchen', { n: inKitchen.length })}</span>}
              {oldest > 0 && <span className={cx('ms-2', oldest > 25 && 'font-semibold text-[#FF8A8D]')}>{t('Oldest {m} min', { m: oldest })}</span>}
            </p>
          </div>
        </div>
        <span className="flex items-baseline gap-1.5 text-white/90" aria-label={t('Time')}>
          <span className="board text-[40px] tabular-nums" dir="ltr">{part('hour')}:{part('minute')}</span>
          <span className="text-lg font-semibold text-white/60">{part('dayPeriod')}</span>
        </span>
        <div className="flex-1" />
        <Link href={`${base}/kitchen/tv?branch=${branch}`} target="_blank"
          className="flex h-11 items-center gap-2 rounded-full bg-white/[.07] px-4 text-sm text-white/80 hover:bg-white/[.12]"><MonitorPlay className="size-4" /> {t('Ready screen for customers')}</Link>
        <Link href={`${base}/settings/qr`} className="flex h-11 items-center gap-2 rounded-full bg-white/[.07] px-4 text-sm text-white/80 hover:bg-white/[.12]"><QrIcon className="size-4" /> {t('QR codes')}</Link>
        <button onClick={toggleFull} aria-pressed={full}
          className="flex h-11 items-center gap-2 rounded-full bg-white/[.07] px-4 text-sm text-white/80 hover:bg-white/[.12]">
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />} {full ? t('Exit full screen') : t('Full screen')}
        </button>
        <button onPointerDown={startRec} onPointerUp={stopRec} onPointerLeave={() => recording && stopRec()} disabled={thinking}
          className={cx('flex h-16 select-none items-center gap-3 rounded-full pe-6 ps-2.5 text-lg font-bold touch-none transition-colors duration-200',
                        recording ? 'bg-[#E5484D] text-white' : thinking ? 'bg-white/15 text-white' : 'bg-[#F2C46D] text-[#1A1306] shadow-[0_10px_30px_-10px_#F2C46D]')}>
          <span className="relative flex size-11 items-center justify-center rounded-full bg-black/15">
            <span className="absolute inset-0 rounded-full bg-white/50" aria-hidden
                  style={{ transform: `scale(${1 + level * 0.9})`, opacity: recording ? 0.55 : 0, transition: 'transform 80ms linear, opacity .2s' }} />
            <Mic className={cx('relative size-6', thinking && 'qr-breathe')} />
          </span>
          {thinking ? t('Understanding…') : recording ? t('Listening — let go to send') : t('Hold and speak')}
        </button>
      </div>

      {/* what it heard: does itself in 3 seconds unless cancelled */}
      {heard && (
        <div className="qr-rise mb-4 flex flex-wrap items-center gap-4 rounded-[22px] bg-[#FBFAF7] p-4 text-[#1D1C1A] shadow-2xl">
          {heard.action !== 'unknown'
            ? <span key={left} className="board qr-pop flex size-14 items-center justify-center rounded-full bg-[#45C486] text-[32px] text-white">{left}</span>
            : <span className="flex size-14 items-center justify-center rounded-full bg-[#ECEBE7]"><Mic className="size-6" /></span>}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[#6E6A64]" dir="auto">“{heard.heard}”</p>
            <p className="text-xl font-bold" dir="auto">{heardLine(heard)}</p>
          </div>
          {heard.action !== 'unknown' && <Button variant="positive" className="h-12 px-5 text-base" onClick={() => doHeard(heard)}><Check className="size-5" /> {t('Do it')}</Button>}
          <Button variant="outline" className="h-12 px-5 text-base" onClick={() => setHeard(null)}><X className="size-5" /> {t('Cancel')}</Button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {column('counter', t('At the counter'), counter.length, counter.map(c => (
            <div key={c.id} className="ticket kds-in rounded-2xl bg-[#FBFAF7] p-4 text-[#1D1C1A]">
              <div className="flex items-start justify-between gap-2">
                <span className="board text-[48px] leading-none text-[#B7791F]">#{c.ticket}</span>
                <span className="board text-[26px]">{money(c.total, tenant.currency_symbol)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-sm">
                {c.table_label && <span className="rounded-full bg-[#1D1C1A] px-2.5 py-0.5 font-semibold text-white">{t('Table {n}', { n: c.table_label })}</span>}
                <span className="rounded-full bg-[#ECEBE7] px-2.5 py-0.5">{c.cart.items.length} {t('items')}</span>
                {c.customer.full_name && <span className="rounded-full bg-[#ECEBE7] px-2.5 py-0.5" dir="auto">{c.customer.full_name}</span>}
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="positive" busy={busy} className="h-12 flex-1 text-base" onClick={() => paid(c)}><Check className="size-5" /> {t('Paid')}</Button>
                <Button variant="ghost" className="h-12 w-12 px-0" onClick={() => cancel(c)} aria-label={t('Cancel')}><X className="size-5" /></Button>
              </div>
            </div>
          )))}
        {cols.map(col => column(col.key as 'new' | 'prep' | 'ready', col.title, col.list.length, col.list.map(o => {
              const placed = new Date(o.placed_at || now).getTime();
              const due = o.ready_by ? new Date(o.ready_by).getTime() : 0;
              const isLate = !!due && due < now && o.status !== 'ready';
              const mins = due ? Math.round((due - now) / 60000) : null;
              const frac = due && due > placed ? Math.min(1, Math.max(0.02, (now - placed) / (due - placed))) : 0;
              const bar = isLate ? '#E5484D' : frac > 0.7 ? '#E9A23B' : '#2E9E6A';
              const glow = now - (arrived.current.get(o.id) || 0) < 20000;
              const next = NEXT[o.status];
              const Service = o.table_label ? UtensilsCrossed : o.delivery_method === 'delivery' ? Bike : ShoppingBag;
              return (
                <div key={o.id} className={cx('kds-in rounded-2xl', isLate && 'kds-late', glow && !isLate && 'ring-new')}>
                  <article className="torn rounded-b-2xl bg-[#FBFAF7] px-4 pb-4 pt-5 text-[#1D1C1A]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="board whitespace-nowrap text-[34px] leading-none"><bdi>{o.order_no}</bdi></span>
                      {o.status === 'ready'
                        ? <Check className="size-7 text-[#2E9E6A]" strokeWidth={3} aria-label={t('Ready')} />
                        : mins !== null && <span className={cx('board text-[28px] leading-none tabular-nums', isLate ? 'text-[#D13438]' : 'text-[#1D1C1A]')}>{mins >= 0 ? `${mins}′` : `+${-mins}′`}</span>}
                    </div>
                    {o.status !== 'ready' && due > 0 && (
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-black/[.08]" aria-hidden>
                        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${frac * 100}%`, background: bar }} />
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-1.5 text-sm">
                      <span className={cx('flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold', o.table_label ? 'bg-[#1D1C1A] text-white' : 'bg-[#ECEBE7]')}>
                        <Service className="size-3.5" aria-hidden />
                        {o.table_label ? t('Table {n}', { n: o.table_label }) : o.delivery_method === 'delivery' ? t('Delivery') : t('Pickup')}
                      </span>
                      <span className="rounded-full bg-[#ECEBE7] px-2.5 py-0.5 text-[#6E6A64]">{o.source === 'qr' ? 'QR' : 'WhatsApp'}</span>
                    </div>
                    <ul className="mt-3 space-y-2" dir="auto">
                      {o.cart.items.map(i => (
                        <li key={i.line_id} className="flex items-start gap-2.5">
                          <span className="board flex h-8 min-w-10 shrink-0 items-center justify-center rounded-lg bg-[#ECEBE7] px-1.5 text-[19px]">
                            {i.unit === 'kg' ? qty(i.quantity, i.unit) : i.quantity}
                          </span>
                          <span className="pt-1 leading-snug">
                            <span className="font-semibold">{i.display_name || i.item_name}</span>
                            {i.notes && <span className="block text-sm font-medium text-[#D13438]">{i.notes}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {o.notes && <p className="mt-3 border-s-4 border-[#E9A23B] bg-[#FFF3CF] px-3 py-2 text-sm font-medium text-[#6B4A00]" dir="auto">{o.notes}</p>}
                    <div className="mt-4 flex gap-2">
                      {next && (
                        <Button variant={next.to === 'ready' ? 'positive' : 'gold'} busy={busy} className="h-12 flex-1 text-base" onClick={() => move(o, next.to)}>
                          {next.to === 'ready' ? <Check className="size-5" /> : <ChefHat className="size-5" />} {t(next.label)}
                        </Button>
                      )}
                      {o.status === 'ready' && (
                        <Button variant="primary" busy={busy} className="h-12 flex-1 text-base" onClick={() => move(o, o.delivery_method === 'delivery' ? 'out_for_delivery' : 'picked_up')}>
                          {o.delivery_method === 'delivery' ? t('Out for delivery') : o.table_label ? t('Served') : t('Collected')}
                        </Button>
                      )}
                      <Button variant="outline" className="h-12 w-12 px-0" onClick={() => { setNoteFor(o); setNote(''); }} title={t('Tell the customer')} aria-label={t('Tell the customer')}><Send className="size-5" /></Button>
                    </div>
                  </article>
                </div>
              );
            })))}
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
