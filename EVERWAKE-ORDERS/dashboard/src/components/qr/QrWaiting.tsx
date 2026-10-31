'use client';
import { Bell, BellRing, Check, ChefHat, CreditCard, Gift, MessageCircle, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { lalezar, readex } from '@/lib/fonts';
import { kgText } from './kg';
import { brandVars } from './QrMenu';

// The customer's waiting page after ordering from a QR code. It asks the
// server every few seconds. Cash: the ticket to show the cashier. Then the
// order number, a countdown ring, the kitchen's notes — and when it's ready,
// a sound, a vibration, a notification and a full screen until they tap.
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
    ticket: 'رقمك عند الكاشير', payCashier: 'ادفع للكاشير وقوله الرقم ده', payCard: 'كمّل الدفع', waitingPay: 'مستنيين الدفع',
    validFor: 'الرقم شغال لمدة', expired: 'الطلب ده خلص وقته من غير دفع', cancelled: 'الطلب اتلغى', order: 'طلب رقم',
    placed: 'اتأكد', preparing: 'بيتجهز', ready: 'جاهز', readyBig: 'طلبك جاهز', readyPickup: 'اتفضل استلمه من الكاشير', readyTable: 'جاي لترابيزتك دلوقتي', ok: 'تمام',
    min: 'دقيقة', soon: 'قرب يجهز', left: 'باقي', kitchen: 'من المطبخ', alert: 'نبهني بصوت لما يجهز', alertOn: 'هنرن أول ما يجهز — سيب الصفحة مفتوحة',
    wa: 'ابعتلي على واتساب لما يجهز', waOn: 'هيوصلك على واتساب كمان', waText: '🔔 نبهني لما طلبي يجهز', total: 'الإجمالي',
    loyalty: (n: number, of: number) => n === of ? 'الطلب ده عليه المكافأة' : `فاضلك ${of - n} ${of - n === 1 ? 'طلب' : 'طلبات'} على المكافأة`,
    payFailed: 'الدفع بالكارت مكملش — تقدر تدفع كاش عند الكاشير وتقوله رقمك', table: 'ترابيزة', gift: 'هدية', collected: 'بالهنا والشفا'
  },
  en: {
    ticket: 'Your number at the counter', payCashier: 'Pay at the counter and tell them this number', payCard: 'Complete payment', waitingPay: 'Waiting for the payment',
    validFor: 'This number works for', expired: 'This order expired without payment', cancelled: 'This order was cancelled', order: 'Order',
    placed: 'Confirmed', preparing: 'Preparing', ready: 'Ready', readyBig: 'Your order is ready', readyPickup: 'Collect it at the counter', readyTable: 'On its way to your table', ok: 'OK',
    min: 'min', soon: 'Almost ready', left: 'About', kitchen: 'From the kitchen', alert: 'Ring me when it is ready', alertOn: 'We will ring — keep this page open',
    wa: 'Message me on WhatsApp when ready', waOn: 'WhatsApp will tell you too', waText: '🔔 Tell me when my order is ready', total: 'Total',
    loyalty: (n: number, of: number) => n === of ? 'This order earns the reward' : `${of - n} more ${of - n === 1 ? 'order' : 'orders'} to your reward`,
    payFailed: 'The card payment did not go through — you can pay cash at the counter with your number', table: 'Table', gift: 'Free', collected: 'Enjoy your meal'
  }
};
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

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

  const steps = ['placed', 'preparing', 'ready'] as const;
  const at = s.order ? (s.order.status === 'accepted' ? 'placed' : s.order.status === 'picked_up' ? 'ready' : s.order.status) : null;
  const atIdx = at ? steps.indexOf(at as typeof steps[number]) : -1;
  const placed = s.order ? new Date(s.order.placed_at).getTime() : 0;
  const due = s.order?.ready_by ? new Date(s.order.ready_by).getTime() : 0;
  const leftMin = due ? Math.ceil((due - now) / 60000) : null;
  const frac = ready || s.order?.status === 'picked_up' ? 1 : due && due > placed ? Math.min(0.97, Math.max(0.03, (now - placed) / (due - placed))) : 0.05;
  const waLink = s.whatsapp.number ? `https://wa.me/${s.whatsapp.number}?text=${encodeURIComponent(`${w.waText} (${s.whatsapp.code})`)}` : null;
  const live = s.status !== 'cancelled' && s.status !== 'expired' && s.order?.status !== 'picked_up';
  const R = 96, C = 2 * Math.PI * R;

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={brandVars(s.restaurant.color)}
         className={`qr-root ${lalezar.variable} ${readex.variable} min-h-screen pb-12`}>
      {ringing && !ack && (
        <button onClick={() => { setAck(true); setRinging(false); }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-[#1F7A52] p-6 text-center text-white">
          <span className="relative mb-6 flex size-32 items-center justify-center">
            <span className="qr-ripple absolute inset-0 rounded-full bg-white/40" />
            <span className="qr-ripple absolute inset-0 rounded-full bg-white/30 [animation-delay:.6s]" />
            <span className="relative flex size-32 items-center justify-center rounded-full bg-white text-[#1F7A52]"><BellRing className="qr-breathe size-16" /></span>
          </span>
          <p className="board text-[56px]">{w.readyBig}</p>
          <p className="board text-[40px] opacity-90"><bdi>{s.order?.order_no}</bdi></p>
          <p className="text-xl">{s.table ? `${w.readyTable} · ${w.table} ${s.table}` : w.readyPickup}</p>
          <span className="mt-8 flex h-16 min-w-48 items-center justify-center rounded-full bg-white px-10 text-xl font-semibold text-[#1F7A52]">{w.ok}</span>
        </button>
      )}

      <div className="mx-auto max-w-md">
        <header className="flex items-center gap-3 bg-[var(--brand)] px-5 pb-14 pt-5 text-[var(--brand-on)]">
          {s.restaurant.logo_url && <img src={s.restaurant.logo_url} alt="" className="size-12 rounded-xl bg-white object-cover" />}
          <div className="min-w-0 flex-1">
            <p className="board truncate text-[28px]">{(lang === 'en' && s.restaurant.name_en) || s.restaurant.name_ar}</p>
            <p className="truncate text-sm opacity-85">{(lang === 'en' && s.branch.name_en) || s.branch.name_ar}</p>
          </div>
          {s.table && <span className="rounded-full bg-black/15 px-3 py-1.5 text-sm font-medium">{w.table} {s.table}</span>}
        </header>

        <main className="relative z-[1] -mt-10 space-y-4 px-4">
          {payFailed && s.status === 'awaiting_payment' && <p className="rounded-2xl bg-[#FBF0DD] px-4 py-3 text-sm font-medium text-[#8A5A12]">{w.payFailed}</p>}

          {/* waiting for the money: the ticket to show the cashier */}
          {s.status === 'awaiting_payment' && !s.order && (
            s.payment_method === 'cash' || payFailed ? (
              <div className="ticket qr-rise rounded-3xl bg-white px-6 pb-6 pt-7 text-center shadow-[0_14px_36px_rgba(29,28,26,.14)]">
                <p className="text-sm font-medium text-[#6E6A64]">{w.ticket}</p>
                <p className="board mt-1 text-[132px] leading-none text-[var(--brand-deep)]">{s.ticket}</p>
                <p className="mt-3 text-lg font-semibold">{w.payCashier}</p>
                <div className="my-5 border-t-2 border-dashed border-[#E2E1DC]" />
                <div className="flex items-baseline justify-between">
                  <span className="text-[#6E6A64]">{w.total}</span>
                  <span className="board text-[30px]">{s.total}<span className="ms-1 font-[family-name:var(--font-qr)] text-sm">{sym}</span></span>
                </div>
                <p className="mt-2 text-start text-sm text-[#6E6A64]">{w.validFor} <bdi suppressHydrationWarning className="font-semibold tabular-nums">{mmss(new Date(s.expires_at).getTime() - now)}</bdi></p>
              </div>
            ) : (
              <div className="qr-rise rounded-3xl bg-white p-6 text-center shadow-[0_14px_36px_rgba(29,28,26,.14)]">
                <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-[var(--brand-wash)] text-[var(--brand-deep)]"><CreditCard className="qr-breathe size-7" /></span>
                <p className="mt-3 text-lg font-semibold">{w.waitingPay}</p>
                {s.pay_url && (
                  <a href={s.pay_url} className="mt-5 flex h-14 items-center justify-between rounded-[18px] bg-[var(--brand)] px-5 font-semibold text-[var(--brand-on)]">
                    <span>{w.payCard}</span><span className="board text-2xl">{s.total}{sym}</span>
                  </a>
                )}
              </div>
            )
          )}
          {(s.status === 'expired' || s.status === 'cancelled') && !s.order && (
            <div className="rounded-3xl bg-white p-6 text-center shadow-[0_14px_36px_rgba(29,28,26,.14)]">
              <XCircle className="mx-auto size-12 text-[#B4232A]" />
              <p className="mt-3 text-lg font-semibold">{s.status === 'expired' ? w.expired : w.cancelled}</p>
              {s.cancel_reason && <p className="mt-1 text-sm text-[#6E6A64]">{s.cancel_reason}</p>}
            </div>
          )}

          {/* the order: a ring that fills towards the promised time */}
          {s.order && (
            <div className="qr-rise rounded-3xl bg-white px-6 pb-6 pt-6 text-center shadow-[0_14px_36px_rgba(29,28,26,.14)]">
              <p className="text-sm text-[#6E6A64]">{w.order} <bdi className="board text-[22px] text-[#1D1C1A]">{s.order.order_no}</bdi></p>
              <div className="relative mx-auto mt-3 size-56">
                <svg viewBox="0 0 220 220" className="size-full -rotate-90" aria-hidden>
                  <circle cx="110" cy="110" r={R} fill="none" stroke="#ECEBE7" strokeWidth="14" />
                  <circle suppressHydrationWarning cx="110" cy="110" r={R} fill="none" stroke={ready ? '#1F7A52' : 'var(--brand)'} strokeWidth="14" strokeLinecap="round"
                          strokeDasharray={C} strokeDashoffset={C * (1 - frac)} style={{ transition: 'stroke-dashoffset 1s linear, stroke .4s' }} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  {ready || s.order.status === 'picked_up' ? (
                    <><Check className="size-14 text-[#1F7A52]" strokeWidth={3} /><span className="board mt-1 text-[30px] text-[#1F7A52]">{s.order.status === 'picked_up' ? w.collected : w.ready}</span></>
                  ) : leftMin !== null && leftMin > 1 ? (
                    <><span className="text-sm text-[#6E6A64]">{w.left}</span><span suppressHydrationWarning className="board text-[76px] leading-none">{leftMin}</span><span className="text-sm text-[#6E6A64]">{w.min}</span></>
                  ) : (
                    <span className="board px-6 text-[34px]">{w.soon}</span>
                  )}
                </div>
              </div>
              {/* the three steps, the current one breathing */}
              <ol className="relative mt-5 flex justify-between">
                <span className="absolute inset-x-8 top-5 h-1 rounded-full bg-[#ECEBE7]" aria-hidden />
                <span className="absolute start-8 top-5 h-1 rounded-full bg-[var(--brand)] transition-all duration-700" aria-hidden
                      style={{ width: `calc((100% - 4rem) * ${Math.max(0, atIdx) / 2})` }} />
                {steps.map((st, i) => {
                  const done = atIdx >= i, current = atIdx === i && !ready;
                  const Icon = st === 'placed' ? Check : st === 'preparing' ? ChefHat : Bell;
                  return (
                    <li key={st} className="relative flex w-16 flex-col items-center gap-1.5" aria-current={atIdx === i ? 'step' : undefined}>
                      <span className={`flex size-11 items-center justify-center rounded-full border-4 border-white
                        ${done ? 'bg-[var(--brand)] text-[var(--brand-on)]' : 'bg-[#ECEBE7] text-[#9A968F]'} ${current ? 'qr-breathe' : ''}`}>
                        <Icon className="size-5" />
                      </span>
                      <span className={`text-sm ${done ? 'font-semibold' : 'text-[#6E6A64]'}`}>{w[st]}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {/* the kitchen talking to them */}
          {s.notes.length > 0 && (
            <div className="space-y-2">
              {s.notes.map((n, i) => (
                <div key={i} className="qr-rise flex items-end gap-2">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#1D1C1A] text-white"><ChefHat className="size-5" /></span>
                  <div className="rounded-2xl rounded-es-md bg-white px-4 py-3 shadow-[0_1px_0_#E2E1DC]">
                    <p className="text-xs font-medium text-[#6E6A64]">{w.kitchen}</p>
                    <p className="mt-0.5" dir="auto">{n.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* how they hear it's ready */}
          {live && (
            <div className="space-y-2.5">
              <button onClick={enableAlert} disabled={alertOn}
                className={`flex h-14 w-full items-center justify-center gap-2 rounded-[18px] font-semibold transition-colors duration-200
                  ${alertOn ? 'bg-[var(--brand-wash)] text-[var(--brand-deep)]' : 'qr-flash bg-[var(--brand)] text-[var(--brand-on)]'}`}>
                {alertOn ? <BellRing className="size-5" /> : <Bell className="size-5" />} {alertOn ? w.alertOn : w.alert}
              </button>
              {waLink && (s.whatsapp.linked
                ? <p className="flex items-center justify-center gap-2 text-sm font-medium text-[#1F7A52]"><MessageCircle className="size-4" /> {w.waOn}</p>
                : <a href={waLink} className="flex h-14 w-full items-center justify-center gap-2 rounded-[18px] bg-[#25D366] font-semibold text-[#0B3B1F]">
                    <MessageCircle className="size-5" /> {w.wa}</a>)}
            </div>
          )}

          {/* the loyalty card: a stamp for each order */}
          {s.loyalty && s.loyalty.every > 1 && s.loyalty.every <= 12 && (() => {
            const n = ((Math.max(1, s.loyalty.orders) - 1) % s.loyalty.every) + 1;
            return (
              <div className="rounded-3xl bg-white p-5">
                <p className="font-semibold">{s.loyalty.title_ar}</p>
                <p className="mt-0.5 text-sm text-[#6E6A64]">{w.loyalty(n, s.loyalty.every)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Array.from({ length: s.loyalty.every }, (_, i) => {
                    const last = i === s.loyalty!.every - 1, got = i < n;
                    return (
                      <span key={i} className={`flex size-9 items-center justify-center rounded-full border-2 ${got ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-on)]' : 'border-dashed border-[#CFCDC7] text-[#9A968F]'}
                        ${i === n - 1 ? 'qr-pop' : ''}`}>
                        {last ? <Gift className="size-4" /> : got ? <Check className="size-4" strokeWidth={3} /> : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* the receipt */}
          <div className="torn rounded-b-3xl bg-white px-5 pb-5 pt-6">
            <ul className="space-y-2">
              {s.items.map((i, k) => (
                <li key={k} className="flex items-start justify-between gap-3" dir="auto">
                  <span className="flex gap-2">
                    <span className="board min-w-8 text-xl text-[var(--brand-deep)]">{i.unit === 'kg' ? '' : `${i.quantity}×`}</span>
                    <span>{i.unit === 'kg' ? `${kgText(Number(i.quantity), lang)} ` : ''}{i.name}</span>
                  </span>
                  <span className="shrink-0 text-[#6E6A64]">{i.gift ? <span className="flex items-center gap-1 text-[#1F7A52]"><Gift className="size-4" /> {w.gift}</span> : `${i.line_total}${sym}`}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-baseline justify-between border-t-2 border-dashed border-[#E2E1DC] pt-3">
              <span className="font-semibold">{w.total}</span>
              <span className="board text-[28px]">{s.total}<span className="ms-1 font-[family-name:var(--font-qr)] text-sm">{sym}</span></span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
