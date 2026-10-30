'use client';
import { Bell, BellRing, CheckCircle2, ChefHat, Clock, CreditCard, Gift, MessageCircle, Receipt, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { kgText } from './kg';

// The customer's waiting page after ordering from a QR code. It asks the
// server every few seconds. Cash: the ticket to show the cashier. Then the
// order number, a countdown, the kitchen's notes — and when it's ready, a
// sound, a vibration, a notification and a flashing screen until they tap.
// A web page can't wake a locked phone, so it also offers WhatsApp: one
// message with the order's code, and "ready" arrives there too.
export interface QrStatus {
  ok: boolean;
  restaurant: { name_ar: string; name_en: string | null; currency_symbol: string; logo_url: string | null; color: string | null; language: string };
  branch: { name_ar: string; name_en: string | null };
  ticket: number; table: string | null; payment_method: 'card' | 'cash'; status: 'awaiting_payment' | 'paid' | 'cancelled' | 'expired';
  expires_at: string; total: number; cancel_reason: string | null;
  items: { name: string; quantity: number; unit: string; line_total: number; gift: boolean }[];
  pay_url: string | null;
  order: { order_no: string; status: string; placed_at: string; ready_by: string | null; ready_at: string | null; eta_text: string | null } | null;
  notes: { text: string; at: string }[];
  whatsapp: { number: string | null; linked: boolean; code: string };
  loyalty: { every: number; title_ar: string; orders: number } | null;
}

const W = {
  ar: {
    ticket: 'رقمك', payCashier: 'ادفع عند الكاشير وقوله رقمك', payCard: 'كمّل الدفع', waitingPay: 'مستنيين الدفع…',
    expired: 'الطلب ده خلص وقته من غير دفع', cancelled: 'الطلب اتلغى', order: 'طلب رقم', placed: 'اتأكد', preparing: 'بيتجهز', ready: 'جاهز',
    readyBig: 'طلبك جاهز ✅', readyPickup: 'اتفضل استلمه من الكاشير', readyTable: 'جاي لترابيزتك', ok: 'تمام',
    left: 'باقي حوالي', soon: 'قرب يجهز', min: 'دقيقة', kitchen: 'من المطبخ', alert: 'نبهني بصوت لما يجهز', alertOn: 'هننبهك بصوت — سيب الصفحة مفتوحة',
    wa: 'ابعتلي على واتساب لما يجهز', waOn: 'هنبعتلك على واتساب كمان', waText: '🔔 نبهني لما طلبي يجهز', total: 'الإجمالي',
    loyalty: (n: number, of: number) => `طلبك رقم ${n} من ${of} للمكافأة 🎁`, payFailed: 'الدفع بالكارت مكملش — تقدر تدفع كاش عند الكاشير وتقوله رقمك',
    done: 'استلمته', table: 'ترابيزة'
  },
  en: {
    ticket: 'Your number', payCashier: 'Pay at the counter and tell them your number', payCard: 'Complete payment', waitingPay: 'Waiting for the payment…',
    expired: 'This order expired without payment', cancelled: 'This order was cancelled', order: 'Order', placed: 'Confirmed', preparing: 'Preparing', ready: 'Ready',
    readyBig: 'Your order is ready ✅', readyPickup: 'Please collect it at the counter', readyTable: 'On its way to your table', ok: 'OK',
    left: 'About', soon: 'Almost ready', min: 'min', kitchen: 'From the kitchen', alert: 'Alert me with a sound when ready', alertOn: 'We will alert you — keep this page open',
    wa: 'Message me on WhatsApp when ready', waOn: 'We will message you on WhatsApp too', waText: '🔔 Tell me when my order is ready', total: 'Total',
    loyalty: (n: number, of: number) => `Order ${n} of ${of} towards your reward 🎁`, payFailed: 'The card payment did not go through — you can pay cash at the counter with your number',
    done: 'Collected', table: 'Table'
  }
};

export function QrWaiting({ token, initial, payFailed }: { token: string; initial: QrStatus; payFailed: boolean }) {
  const [s, setS] = useState<QrStatus>(initial);
  const [now, setNow] = useState(Date.now());
  const [alertOn, setAlertOn] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [ack, setAck] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const lock = useRef<{ release: () => void } | null>(null);
  const seenNotes = useRef(initial.notes.length);
  const lang: 'ar' | 'en' = s.restaurant.language === 'en' ? 'en' : 'ar';
  const w = W[lang];
  const color = s.restaurant.color || '#0B222E';
  const sym = s.restaurant.currency_symbol || 'ج';

  // every few seconds while it matters
  useEffect(() => {
    const done = s.status === 'cancelled' || s.status === 'expired' || ['picked_up', 'delivered', 'rejected', 'cancelled'].includes(s.order?.status || '');
    if (done) return;
    const id = setInterval(async () => {
      const r = await fetch(`/api/q/t/${token}`, { cache: 'no-store' }).then(x => x.json()).catch(() => null);
      if (r?.ok) setS(r);
    }, 4000);
    return () => clearInterval(id);
  }, [token, s.status, s.order?.status]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // the sound: a short chime, again every two seconds while it rings
  const chime = useCallback(() => {
    const ctx = audio.current; if (!ctx) return;
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = [880, 1175, 1568][i];
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.6, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.4);
    });
  }, []);
  const enableAlert = async () => {
    // a tap is what lets a phone play sound and keep the screen on
    try { audio.current = audio.current || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(); await audio.current.resume(); chime(); } catch { /* no sound */ }
    try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* not offered */ }
    try { const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => void }> } }).wakeLock; if (wl) lock.current = await wl.request('screen'); } catch { /* not offered */ }
    setAlertOn(true);
  };

  const ready = s.order?.status === 'ready';
  useEffect(() => {
    if (!ready || ack) return;
    setRinging(true);
    try { navigator.vibrate?.([400, 200, 400, 200, 800]); } catch { /* none */ }
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(w.readyBig, { body: s.table ? w.readyTable : w.readyPickup }); } catch { /* none */ }
    chime();
    const id = setInterval(() => { chime(); try { navigator.vibrate?.([400, 200, 400]); } catch { /* none */ } }, 2000);
    const t0 = document.title; let flip = false;
    const tid = setInterval(() => { document.title = (flip = !flip) ? '🔔 ' + w.readyBig : t0; }, 1000);
    return () => { clearInterval(id); clearInterval(tid); document.title = t0; };
  }, [ready, ack, chime, s.table, w.readyBig, w.readyPickup, w.readyTable]);
  // a new note from the kitchen: one chime
  useEffect(() => { if (s.notes.length > seenNotes.current) { seenNotes.current = s.notes.length; chime(); try { navigator.vibrate?.(300); } catch { /* none */ } } }, [s.notes.length, chime]);
  useEffect(() => () => { try { lock.current?.release(); } catch { /* gone */ } }, []);

  const steps = ['placed', 'preparing', 'ready'];
  const at = s.order ? (s.order.status === 'accepted' ? 'placed' : s.order.status === 'picked_up' ? 'ready' : s.order.status) : null;
  const leftMin = s.order?.ready_by ? Math.ceil((new Date(s.order.ready_by).getTime() - now) / 60000) : null;
  const waLink = s.whatsapp.number ? `https://wa.me/${s.whatsapp.number}?text=${encodeURIComponent(`${w.waText} (${s.whatsapp.code})`)}` : null;

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} className="min-h-screen bg-paper pb-10">
      {ringing && !ack && (
        <button onClick={() => { setAck(true); setRinging(false); }}
          className="fixed inset-0 z-50 flex animate-pulse flex-col items-center justify-center gap-4 p-6 text-center text-white" style={{ background: '#2E7D5B' }}>
          <BellRing className="size-20" />
          <p className="text-4xl font-black">{w.readyBig}</p>
          <p className="text-2xl font-bold">{w.order} <bdi>{s.order?.order_no}</bdi></p>
          <p className="text-lg">{s.table ? `${w.readyTable} (${w.table} ${s.table})` : w.readyPickup}</p>
          <span className="mt-6 rounded-full bg-white px-10 py-3 text-xl font-bold text-[#2E7D5B]">{w.ok}</span>
        </button>
      )}

      <header className="flex items-center gap-3 px-4 py-4 text-white" style={{ background: color }}>
        {s.restaurant.logo_url && <img src={s.restaurant.logo_url} alt="" className="size-11 rounded-full bg-white object-cover" />}
        <div className="min-w-0">
          <p className="truncate font-bold">{(lang === 'en' && s.restaurant.name_en) || s.restaurant.name_ar}</p>
          <p className="truncate text-xs opacity-90">{(lang === 'en' && s.branch.name_en) || s.branch.name_ar}{s.table ? ` · ${w.table} ${s.table}` : ''}</p>
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-4 px-4 pt-5">
        {payFailed && s.status === 'awaiting_payment' && <p className="rounded-xl bg-caution-wash px-3 py-2 text-sm text-caution">{w.payFailed}</p>}

        {/* waiting for the money */}
        {s.status === 'awaiting_payment' && !s.order && (
          <div className="rounded-3xl bg-white p-6 text-center shadow-sm">
            {s.payment_method === 'cash' || payFailed ? (
              <>
                <Receipt className="mx-auto size-10 text-muted" />
                <p className="mt-2 text-sm text-muted">{w.ticket}</p>
                <p className="text-7xl font-black" style={{ color }}>{s.ticket}</p>
                <p className="mt-3 text-lg font-semibold">{w.payCashier}</p>
                <p className="mt-1 text-muted">{w.total}: <b>{s.total}{sym}</b></p>
              </>
            ) : (
              <>
                <CreditCard className="mx-auto size-10 text-muted" />
                <p className="mt-2 text-lg font-semibold">{w.waitingPay}</p>
                {s.pay_url && <a href={s.pay_url} className="mt-4 flex h-12 items-center justify-center rounded-xl font-semibold text-white" style={{ background: color }}>{w.payCard} · {s.total}{sym}</a>}
              </>
            )}
          </div>
        )}
        {(s.status === 'expired' || s.status === 'cancelled') && !s.order && (
          <div className="rounded-3xl bg-white p-6 text-center shadow-sm">
            <XCircle className="mx-auto size-10 text-critical" />
            <p className="mt-2 text-lg font-semibold">{s.status === 'expired' ? w.expired : w.cancelled}</p>
            {s.cancel_reason && <p className="text-sm text-muted">{s.cancel_reason}</p>}
          </div>
        )}

        {/* the order */}
        {s.order && (
          <div className="rounded-3xl bg-white p-6 text-center shadow-sm">
            <p className="text-sm text-muted">{w.order}</p>
            <p className="text-5xl font-black" style={{ color }}><bdi>{s.order.order_no}</bdi></p>
            <div className="mt-5 flex items-center justify-between gap-2">
              {steps.map((st, i) => {
                const done = at ? steps.indexOf(at) >= i : false;
                const Icon = st === 'placed' ? CheckCircle2 : st === 'preparing' ? ChefHat : Bell;
                return (
                  <div key={st} className="flex flex-1 flex-col items-center gap-1">
                    <span className={`flex size-11 items-center justify-center rounded-full ${done ? 'text-white' : 'bg-paper text-muted'}`} style={done ? { background: color } : {}}>
                      <Icon className="size-5" /></span>
                    <span className={`text-xs ${done ? 'font-semibold' : 'text-muted'}`}>{w[st as 'placed' | 'preparing' | 'ready']}</span>
                  </div>
                );
              })}
            </div>
            {s.order.status !== 'ready' && s.order.status !== 'picked_up' && leftMin !== null && (
              <p className="mt-5 flex items-center justify-center gap-2 text-lg font-semibold">
                <Clock className="size-5" /> {leftMin > 1 ? `${w.left} ${leftMin} ${w.min}` : w.soon}
              </p>
            )}
            {s.order.status === 'ready' && <p className="mt-5 text-xl font-bold text-positive">{w.readyBig}</p>}
          </div>
        )}

        {s.notes.length > 0 && (
          <div className="space-y-2 rounded-2xl bg-gold-wash p-4 ring-1 ring-gold-line">
            <p className="text-xs font-semibold text-gold-ink">{w.kitchen}</p>
            {s.notes.map((n, i) => <p key={i} className="text-sm" dir="auto">{n.text}</p>)}
          </div>
        )}

        {/* how they hear it's ready */}
        {s.status !== 'cancelled' && s.status !== 'expired' && s.order?.status !== 'picked_up' && (
          <div className="space-y-2">
            <button onClick={enableAlert} disabled={alertOn}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 text-sm font-semibold disabled:opacity-80" style={{ borderColor: color, color }}>
              {alertOn ? <BellRing className="size-5" /> : <Bell className="size-5" />} {alertOn ? w.alertOn : w.alert}
            </button>
            {waLink && (s.whatsapp.linked
              ? <p className="text-center text-sm text-positive">{w.waOn}</p>
              : <a href={waLink} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] text-sm font-semibold text-white">
                  <MessageCircle className="size-5" /> {w.wa}</a>)}
          </div>
        )}

        {s.loyalty && s.loyalty.every > 1 && (
          <p className="flex items-center justify-center gap-2 rounded-xl bg-white px-3 py-2 text-sm shadow-sm">
            <Gift className="size-4 text-gold" /> {w.loyalty(((s.loyalty.orders - 1) % s.loyalty.every) + 1, s.loyalty.every)}
          </p>
        )}

        <div className="rounded-2xl bg-white p-4 text-sm shadow-sm">
          {s.items.map((i, k) => (
            <p key={k} className="flex justify-between gap-2 py-0.5" dir="auto">
              <span>{i.unit === 'kg' ? kgText(Number(i.quantity), lang) : `${i.quantity}×`} {i.name}</span>
              <span className="text-muted">{i.gift ? '🎁' : `${i.line_total}${sym}`}</span>
            </p>
          ))}
          <p className="mt-2 flex justify-between border-t border-hairline pt-2 font-bold"><span>{w.total}</span><span>{s.total}{sym}</span></p>
        </div>
      </main>
    </div>
  );
}
