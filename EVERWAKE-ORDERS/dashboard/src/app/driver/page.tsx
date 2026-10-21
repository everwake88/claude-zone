'use client';
import { Banknote, Check, LocateFixed, LogOut, MapPin, MessageCircle, Navigation, Phone, RefreshCw, Send, Store } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import { clock, cx, money, statusLabel } from '@/lib/format';
import { LangSwitch, useT } from '@/lib/i18n';
import type { OrderStatus } from '@/lib/types';

const DriverMap = dynamic(() => import('@/components/driver/DriverMap'), { ssr: false, loading: () => <div className="h-56 animate-pulse bg-paper" /> });

type P = [number, number];
interface DOrder {
  id: number; order_no: string; status: OrderStatus; placed_at: string;
  customer_name: string | null; customer_phone: string | null;
  address_text: string | null; location: { lat?: number; lng?: number; maps_url?: string } | null; notes: string | null;
  total: number; delivery_fee: number | null; payment_method: string | null; km_left: number | null; eta_min: number | null;
  branch: { name: string | null; address: string | null; phone: string | null; lat: number | null; lng: number | null; maps_url: string | null };
  items: { name: string; quantity: number; unit: string; choices: { selected?: { name?: string }[] }[]; notes: string | null }[];
}
interface Home {
  driver: { id: string; name: string; phone: string };
  restaurant: { name_ar: string; name_en: string; currency: string; logo_url: string | null; color: string | null };
  orders: DOrder[]; today: { delivered: number; cash: number };
}
interface Msg { id: number; from: string; kind: string; text: string | null; at: string; status: string }

// a number a phone can call, and one WhatsApp opens (Egypt: 01… → 201…)
const intl = (p: string) => { const d = p.replace(/\D/g, ''); return d.length === 11 && d.startsWith('0') ? '2' + d : d; };
const local = (p: string) => { const d = p.replace(/\D/g, ''); return d.startsWith('20') && d.length === 12 ? '0' + d.slice(2) : d; };
const point = (lat?: number | null, lng?: number | null): P | null => (lat != null && lng != null ? [Number(lat), Number(lng)] : null);
// Google Maps: turn-by-turn on the phone's own app
const directions = (to: P | null, text?: string | null) =>
  `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(to ? to.join(',') : text || '')}`;
const meters = (a: P, b: P) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos(((a[0] + b[0]) / 2) * r), y = (b[0] - a[0]) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
};

// The driver's phone: the orders given to them, the way there, the customer
// a tap away, and their position going to the restaurant while they deliver.
export default function DriverApp() {
  const t = useT();
  const router = useRouter();
  const [home, setHome] = useState<Home | null>(null);
  const [me, setMe] = useState<P | null>(null);
  const [gps, setGps] = useState<'off' | 'on' | 'denied' | 'unsupported'>('off');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef<{ at: number; p: P | null }>({ at: 0, p: null });
  const watch = useRef<number | null>(null);

  const call = useCallback(async (url: string, body?: unknown) => {
    const res = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 401) { router.replace('/driver/login'); throw new Error('signed out'); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Something went wrong');
    return data;
  }, [router]);

  const load = useCallback(async () => {
    try { setHome(await call('/api/driver/home')); setError(null); } catch (e) { if ((e as Error).message !== 'signed out') setError((e as Error).message); }
  }, [call]);
  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  // the position: sent every 15 s, or sooner after 60 m, while there are orders
  const active = (home?.orders.length || 0) > 0;
  const onTheWay = home?.orders.some(o => o.status === 'out_for_delivery') || false;
  const startGps = useCallback(() => {
    if (!('geolocation' in navigator)) { setGps('unsupported'); return; }
    if (watch.current != null) return;
    watch.current = navigator.geolocation.watchPosition(pos => {
      const p: P = [pos.coords.latitude, pos.coords.longitude];
      setGps('on'); setMe(p);
      const last = sent.current;
      if (Date.now() - last.at < 15000 && last.p && meters(last.p, p) < 60) return;
      sent.current = { at: Date.now(), p };
      call('/api/driver/ping', { lat: p[0], lng: p[1], accuracy: pos.coords.accuracy })
        .then((r: { orders: { order_id: number; km: number; min: number }[] }) => setHome(h => h && {
          ...h, orders: h.orders.map(o => { const x = r.orders.find(y => y.order_id === o.id); return x ? { ...o, km_left: x.km, eta_min: x.min } : o; })
        }))
        .catch(() => { /* the next fix tries again */ });
    }, e => { if (e.code === e.PERMISSION_DENIED) setGps('denied'); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }, [call]);
  useEffect(() => {
    if (active) startGps();
    else if (watch.current != null) { navigator.geolocation.clearWatch(watch.current); watch.current = null; setGps('off'); }
  }, [active, startGps]);
  useEffect(() => () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); }, []);

  // the screen stays on while delivering, so the position keeps going
  useEffect(() => {
    if (!onTheWay || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const get = () => navigator.wakeLock.request('screen').then(l => { lock = l; }).catch(() => { /* not allowed now */ });
    get();
    const vis = () => { if (document.visibilityState === 'visible') get(); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release().catch(() => {}); };
  }, [onTheWay]);

  const act = async (o: DOrder, action: 'pick_up' | 'delivered') => {
    setBusy(`${o.id}:${action}`);
    try { await call('/api/driver/action', { order: o.id, action }); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const logout = async () => { await fetch('/api/driver/logout', { method: 'POST' }); router.replace('/driver/login'); };

  if (!home) return <div className="flex min-h-screen items-center justify-center bg-paper">{error ? <p className="p-6 text-critical">{t(error)}</p> : <Spinner />}</div>;
  const brand = home.restaurant.color || '#0B222E';
  const sym = home.restaurant.currency;

  return (
    <div className="min-h-screen bg-paper pb-10">
      <header className="sticky top-0 z-20 text-white shadow" style={{ background: brand }}>
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          {home.restaurant.logo_url && <img src={home.restaurant.logo_url} alt="" className="size-10 rounded-full bg-white object-contain p-0.5" />}
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{home.restaurant.name_ar || home.restaurant.name_en}</p>
            <p className="truncate text-xs opacity-85">{t('Driver: {name}', { name: home.driver.name })}</p>
          </div>
          <button onClick={load} className="rounded-full p-2 hover:bg-white/15" aria-label={t('Refresh')}><RefreshCw className="size-5" /></button>
          <button onClick={logout} className="rounded-full p-2 hover:bg-white/15" aria-label={t('Sign out')}><LogOut className="size-5" /></button>
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-4 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-white p-3 shadow-sm"><p className="text-xs text-muted">{t('Delivered today')}</p><p className="text-2xl font-bold">{home.today.delivered}</p></div>
          <div className="rounded-xl bg-white p-3 shadow-sm"><p className="text-xs text-muted">{t('Cash collected today')}</p><p className="text-2xl font-bold">{money(home.today.cash, sym)}</p></div>
        </div>

        {active && (
          <div className={cx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm', gps === 'on' ? 'bg-positive-wash text-positive' : 'bg-gold-wash text-gold-ink')}>
            <LocateFixed className="size-4 shrink-0" />
            <span className="flex-1">
              {gps === 'on' ? t('Location on — customers are told when you are close. Keep this page open while you drive.')
                : gps === 'denied' ? t('Location is blocked. Allow it for this site in your browser settings so customers know when you are close.')
                : gps === 'unsupported' ? t('This phone cannot share its location.')
                : t('Turn on location so customers know when you are close.')}
            </span>
            {gps !== 'on' && gps !== 'unsupported' && <Button size="sm" onClick={startGps}>{t('Turn on')}</Button>}
          </div>
        )}
        {error && <p className="rounded-xl bg-critical-wash p-3 text-sm text-critical">{t(error)}</p>}

        {home.orders.length === 0 && (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm">
            <p className="text-lg font-semibold">{t('No orders with you right now')}</p>
            <p className="mt-1 text-sm text-muted">{t('New orders appear here, and you get a WhatsApp message.')}</p>
          </div>
        )}

        {home.orders.map(o => <OrderCard key={o.id} o={o} me={me} sym={sym} busy={busy} act={act} call={call} />)}
        <div className="flex justify-center pt-2"><LangSwitch /></div>
      </main>
    </div>
  );
}

function OrderCard({ o, me, sym, busy, act, call }: {
  o: DOrder; me: P | null; sym: string; busy: string | null;
  act: (o: DOrder, a: 'pick_up' | 'delivered') => void; call: (url: string, body?: unknown) => Promise<unknown>;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [chat, setChat] = useState(false);
  const going = o.status === 'out_for_delivery';
  const to = point(o.location?.lat, o.location?.lng);
  const from = point(o.branch.lat, o.branch.lng);
  const cash = !o.payment_method || /cash|كاش/i.test(o.payment_method);
  const phone = o.customer_phone;

  return (
    <article className={cx('overflow-hidden rounded-2xl bg-white shadow-sm ring-1', going ? 'ring-positive' : 'ring-hairline')}>
      <div className="flex items-center justify-between px-4 pt-3">
        <p className="font-semibold" dir="ltr">{o.order_no}</p>
        <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-semibold', going ? 'bg-positive-wash text-positive' : 'bg-gold-wash text-gold-ink')}>
          {statusLabel(o.status)}
        </span>
      </div>

      <div className="mt-2"><DriverMap me={me} to={to} from={going ? null : from} /></div>

      <div className="space-y-3 p-4">
        {going && o.eta_min != null && (
          <p className="text-center text-lg font-bold text-positive">{t('{km} km · about {min} min', { km: o.km_left ?? '—', min: o.eta_min })}</p>
        )}

        {/* before pick-up: the branch */}
        {!going && (
          <div className="rounded-xl bg-paper p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-muted"><Store className="size-3.5" /> {t('Pick up from')}</p>
            <p className="font-semibold">{o.branch.name}</p>
            {o.branch.address && <p className="text-sm text-muted">{o.branch.address}</p>}
            <div className="mt-2 flex gap-2">
              <a href={o.branch.maps_url || directions(from, o.branch.address)} target="_blank" rel="noreferrer" className="btn-soft"><Navigation className="size-4" /> {t('Directions')}</a>
              {o.branch.phone && <a href={`tel:${local(o.branch.phone)}`} className="btn-soft"><Phone className="size-4" /> {t('Call the branch')}</a>}
            </div>
          </div>
        )}

        {/* the customer */}
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted"><MapPin className="size-3.5" /> {t('Deliver to')}</p>
          <p className="font-semibold">{o.customer_name || t('Customer')}</p>
          <p className="text-sm">{o.address_text || (to ? t('Location pin only') : '—')}</p>
          {o.notes && <p className="mt-1 rounded-lg bg-gold-wash px-2 py-1 text-sm text-gold-ink">{o.notes}</p>}
          <div className="mt-2 grid grid-cols-3 gap-2">
            <a href={directions(to, o.address_text)} target="_blank" rel="noreferrer" className="btn-soft justify-center"><Navigation className="size-4" /> {t('Directions')}</a>
            {phone
              ? <a href={`tel:${local(phone)}`} className="btn-soft justify-center"><Phone className="size-4" /> {t('Call')}</a>
              : <span className="btn-soft justify-center opacity-40"><Phone className="size-4" /> {t('Call')}</span>}
            <button onClick={() => setChat(c => !c)} className={cx('btn-soft justify-center', chat && 'ring-2 ring-gold')}><MessageCircle className="size-4" /> {t('Chat')}</button>
          </div>
          {phone && <p className="mt-1 text-center text-xs text-muted" dir="ltr">{local(phone)} · <a className="underline" href={`https://wa.me/${intl(phone)}`} target="_blank" rel="noreferrer">WhatsApp</a></p>}
        </div>

        {chat && <Chat order={o.id} call={call} />}

        {/* what is in the bag, and what to collect */}
        <details className="rounded-xl bg-paper p-3 text-sm">
          <summary className="cursor-pointer font-semibold">{t('{n} items', { n: o.items.length })}</summary>
          <ul className="mt-2 space-y-1">
            {o.items.map((i, k) => (
              <li key={k}>×{Number(i.quantity)} {i.name}
                {i.choices?.length > 0 && <span className="text-muted"> ({i.choices.map(c => (c.selected || []).map(s => s.name).join('+')).join('، ')})</span>}
                {i.notes && <span className="text-muted"> — {i.notes}</span>}</li>
            ))}
          </ul>
        </details>
        <div className="flex items-center gap-2 rounded-xl bg-navy p-3 text-white">
          <Banknote className="size-5" />
          <span className="flex-1 text-sm">{cash ? t('Collect in cash') : t('Already paid ({method})', { method: o.payment_method || '' })}</span>
          <span className="text-xl font-bold">{cash ? money(o.total, sym) : '0'}</span>
        </div>

        {/* the one big button */}
        {!going && (
          <Button variant="gold" className="h-12 w-full text-base" busy={busy === `${o.id}:pick_up`} onClick={() => act(o, 'pick_up')}
            disabled={o.status === 'placed'}>
            {o.status === 'placed' ? t('Waiting for the restaurant to confirm') : t('I have the order — start delivery')}
          </Button>
        )}
        {going && (confirm
          ? <div className="space-y-2">
              <p className="text-center text-sm">{cash ? t('Delivered and collected {amount}?', { amount: money(o.total, sym) }) : t('Delivered?')}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="ghost" className="h-12" onClick={() => setConfirm(false)}>{t('Not yet')}</Button>
                <Button variant="gold" className="h-12 text-base" busy={busy === `${o.id}:delivered`} onClick={() => act(o, 'delivered')}><Check className="size-5" /> {t('Yes, delivered')}</Button>
              </div>
            </div>
          : <Button variant="gold" className="h-12 w-full text-base" onClick={() => setConfirm(true)}><Check className="size-5" /> {t('Delivered')}</Button>)}
      </div>
    </article>
  );
}

const QUICK = ['I am downstairs', 'I have arrived, can you come down?', 'I cannot find the address, can you describe it?', 'I am on my way, a few minutes late'];

// the chat with the customer, through the restaurant's WhatsApp number
function Chat({ order, call }: { order: number; call: (url: string, body?: unknown) => Promise<unknown> }) {
  const t = useT();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => { call(`/api/driver/chat?order=${order}`).then(m => setMsgs(m as Msg[])).catch(() => {}); }, [call, order]);
  useEffect(() => { load(); const id = setInterval(load, 8000); return () => clearInterval(id); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs?.length]);
  const send = async (body: string) => {
    if (!body.trim()) return;
    setSending(true);
    try { await call('/api/driver/chat', { order, text: body }); setText(''); load(); } finally { setSending(false); }
  };
  return (
    <div className="rounded-xl border border-hairline">
      <div className="max-h-64 space-y-1.5 overflow-y-auto p-3 text-sm">
        {msgs === null && <Spinner />}
        {msgs?.length === 0 && <p className="text-center text-muted">{t('No messages yet')}</p>}
        {msgs?.map(m => (
          <div key={m.id} className={cx('flex', m.from === 'customer' ? 'justify-start' : 'justify-end')}>
            <p className={cx('max-w-[85%] rounded-2xl px-3 py-1.5',
              m.from === 'customer' ? 'bg-paper' : m.from === 'driver' ? 'bg-positive-wash' : 'bg-white text-xs text-muted ring-1 ring-hairline')}>
              {m.from !== 'customer' && m.from !== 'driver' && <span className="block text-[10px] font-semibold uppercase">{m.from === 'agent' ? t('Agent') : t('Restaurant')}</span>}
              {m.text || `[${m.kind}]`}
              <span className="block text-end text-[10px] text-muted">{clock(m.at)}</span>
            </p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-hairline p-2">
        {QUICK.map(q => <button key={q} disabled={sending} onClick={() => send(t(q))} className="rounded-full bg-paper px-2.5 py-1 text-xs hover:bg-gold-wash">{t(q)}</button>)}
      </div>
      <form onSubmit={e => { e.preventDefault(); send(text); }} className="flex gap-2 border-t border-hairline p-2">
        <input value={text} onChange={e => setText(e.target.value)} dir="auto" placeholder={t('Message the customer…')}
          className="h-10 min-w-0 flex-1 rounded-lg border border-hairline px-3 text-sm" />
        <Button type="submit" busy={sending} aria-label={t('Send')}><Send className="size-4 rtl:rotate-180" /></Button>
      </form>
      <p className="px-3 pb-2 text-[11px] text-muted">{t('Sent from the restaurant’s WhatsApp number, with your name.')}</p>
    </div>
  );
}
