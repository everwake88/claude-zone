'use client';
import { Banknote, Check, Clock, CreditCard, Gift, Languages, Minus, Plus, ShoppingBag, Star, Ticket, Trash2, UtensilsCrossed, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { lalezar, readex } from '@/lib/fonts';
import { inkOf, mix, onColor } from '@/lib/menu-art';
import { kgText } from './kg';

// The branch's menu on the customer's phone, from a QR code on the counter
// or a table. They pick dishes and choices, then pay by card or cash at the
// counter. Prices here are a preview: the server prices the cart again.
//
// The look is the order ticket: the restaurant's own colour, its name and
// prices in menu-board lettering, a ticket stub saying where they sit and
// when it will be ready, and a receipt for the cart. Motion only answers
// the customer: a dish flies into the cart, the total counts up, a missing
// choice shakes.
export interface QrOption { name: string; name_en?: string | null; price: number | null; extra_charge?: boolean }
export interface QrLevel { level: number; label_ar: string; label_en?: string | null; required: boolean; min: number | null; max: number | null; options: QrOption[] }
export interface QrItem {
  code: string; name: string; name_en: string | null; desc: string | null; price: number | null; unit: string;
  qty_step: number | null; min_qty: number | null; signature: boolean; available: boolean; photo: string | null; levels: QrLevel[];
}
export interface QrMenuData {
  ok: boolean; error?: string;
  restaurant: { name_ar: string; name_en: string | null; currency_symbol: string; language: string; logo_url: string | null; color: string | null };
  branch: { id: string; code: string; name_ar: string; name_en: string | null; state: string; busy_reason: string | null; hours_text_ar: string | null;
            prep_minutes: number; vat_percent: number | null; price_note_ar: string | null };
  table: string | null;
  pay: { card: boolean; cash: boolean };
  categories: { id: string | null; name_ar: string | null; name_en: string | null; items: QrItem[] }[];
  offers: { title_ar: string; title_en: string | null; description_ar: string | null; every_nth_order: number | null }[];
  pairs: Record<string, string[]>;
}
interface Line { key: string; code: string; quantity: number; choices: { level: number; selected: string[] }[]; notes: string }
interface Quote {
  ok: boolean; error?: string; detail?: string; subtotal: number; discount_total: number; vat: number | null; total: number;
  offers: { id: string; title: string; amount: number }[]; gifts: { name: string; quantity: number; unit: string }[];
}

// Arabic counts the way they are said: صنف واحد، صنفين، 3 أصناف، 11 صنف
const arCount = (n: number) => n === 1 ? 'صنف واحد' : n === 2 ? 'صنفين' : n <= 10 ? `${n} أصناف` : `${n} صنف`;
const W = {
  ar: {
    table: 'ترابيزة', bringIt: 'هنجيبهولك لحد الترابيزة', counter: 'استلام من الكاشير', counterSub: 'هننادي رقمك أول ما يجهز',
    ready: (m: number) => `جاهز في حوالي ${m} دقيقة`, closed: 'الفرع مقفول دلوقتي', busy: 'الفرع عليه ضغط ومش واخد طلبات جديدة دلوقتي',
    soldOut: 'خلص', favourites: 'أشهر أكلاتنا', items: (n: number) => arCount(n), every: (n: number) => `كل ${n} طلبات`,
    add: 'ضيف للطلب', choose: (l: string) => `اختار ${l}`, required: 'لازم تختار', optional: 'اختياري', upTo: (n: number) => `لحد ${n}`,
    notes: 'ملاحظة للمطبخ', notesHint: 'من غير بصل، حار زيادة…', yourOrder: 'طلبك', see: 'شوف طلبك', count: (n: number) => arCount(n),
    name: 'اسمك', phone: 'رقم موبايلك', optionalField: 'اختياري', phoneHint: 'عشان الإيصال ونقاط المكافآت', pay: 'هتدفع إزاي؟', payFirst: 'اختار طريقة الدفع الأول',
    card: 'كارت أو محفظة', cardSub: 'ادفع دلوقتي من موبايلك', cash: 'كاش', cashSub: 'ادفع للكاشير وقوله رقمك',
    place: 'ابعت الطلب', total: 'الإجمالي', vat: (p: number) => `الأسعار من غير ضريبة ${p}%`, empty: 'لسه مفيش حاجة في طلبك',
    subtotal: 'الأصناف', vatLine: 'ضريبة', gift: 'هدية', goesWith: 'بيتطلب معاه غالباً', addIt: 'ضيفه', perKg: 'الكيلو', sending: 'بنبعت طلبك…',
    langSwitch: 'English', close: 'اقفل', remove: 'شيله من الطلب', fav: 'من أشهر أكلاتنا', less: 'أقل', more: 'زوّد',
    errors: { SOLD_OUT: 'صنف خلص من شوية: ', CHOICE_MISSING: 'محتاج تختار: ', BRANCH_CLOSED: 'الفرع مقفول دلوقتي', BRANCH_BUSY: 'الفرع مش واخد طلبات دلوقتي',
              NOT_ON_MENU: 'صنف مش متاح دلوقتي', DINE_IN_ONLY: 'الصنف ده للأكل في المكان بس: ', default: 'الطلب موصلش، جرّب تاني' } as Record<string, string>
  },
  en: {
    table: 'Table', bringIt: 'We bring it to your table', counter: 'Pick up at the counter', counterSub: 'We call your number when it is ready',
    ready: (m: number) => `Ready in about ${m} min`, closed: 'The branch is closed right now', busy: 'The branch is too busy for new orders right now',
    soldOut: 'Sold out', favourites: 'House favourites', items: (n: number) => `${n} dishes`, every: (n: number) => `Every ${n} orders`,
    add: 'Add to order', choose: (l: string) => `Choose ${l}`, required: 'Required', optional: 'Optional', upTo: (n: number) => `Up to ${n}`,
    notes: 'Note for the kitchen', notesHint: 'No onions, extra spicy…', yourOrder: 'Your order', see: 'View order', count: (n: number) => n === 1 ? '1 item' : `${n} items`,
    name: 'Your name', phone: 'Your mobile', optionalField: 'optional', phoneHint: 'For the receipt and reward points', pay: 'How will you pay?', payFirst: 'Choose how to pay first',
    card: 'Card or wallet', cardSub: 'Pay now on your phone', cash: 'Cash', cashSub: 'Pay at the counter with your number',
    place: 'Send order', total: 'Total', vat: (p: number) => `Prices exclude ${p}% VAT`, empty: 'Nothing in your order yet',
    subtotal: 'Items', vatLine: 'VAT', gift: 'Free', goesWith: 'Often ordered with it', addIt: 'Add', perKg: 'kg', sending: 'Sending your order…',
    langSwitch: 'عربي', close: 'Close', remove: 'Remove from order', fav: 'A house favourite', less: 'Fewer', more: 'More',
    errors: { SOLD_OUT: 'Just sold out: ', CHOICE_MISSING: 'Please choose: ', BRANCH_CLOSED: 'The branch is closed right now', BRANCH_BUSY: 'The branch is not taking orders right now',
              NOT_ON_MENU: 'A dish is not available right now', DINE_IN_ONLY: 'Only served at a table: ', default: 'The order did not go through. Try again.' } as Record<string, string>
  }
};
type Words = typeof W.ar;
const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US');
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* not offered */ } };
// what the customer can choose here (a choice priced only at the branch is left out)
const levelsOf = (i: QrItem) => i.levels.map(l => ({ ...l, options: l.options.filter(o => !o.extra_charge) })).filter(l => l.options.length);
// a dish with nothing to choose goes straight into the order
const isSimple = (i: QrItem) => i.unit !== 'kg' && levelsOf(i).length === 0;

// a number that counts to its new value instead of jumping
function useTween(value: number, ms = 450) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const a = from.current, b = value;
    if (a === b) return;
    if (reduced()) { from.current = b; setV(b); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), x = a + (b - a) * (1 - Math.pow(1 - k, 3));
      from.current = x; setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return Math.abs(v - value) < 0.005 ? value : Math.round(v);
}

export function brandVars(color: string | null): CSSProperties {
  const brand = color || '#0B222E';
  return { '--brand': brand, '--brand-on': onColor(brand), '--brand-wash': mix(brand, '#FFFFFF', 0.9), '--brand-deep': inkOf(brand) } as CSSProperties;
}

export function QrMenu({ data, code }: { data: QrMenuData; code: string }) {
  const [lang, setLang] = useState<'ar' | 'en'>(data.restaurant.language === 'en' ? 'en' : 'ar');
  const w = W[lang];
  const sym = data.restaurant.currency_symbol || 'ج';
  const items = useMemo(() => new Map(data.categories.flatMap(c => c.items).map(i => [i.code, i])), [data]);
  const [lines, setLines] = useState<Line[]>([]);
  const [open, setOpen] = useState<QrItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [suggest, setSuggest] = useState<QrItem | null>(null);
  const [cat, setCat] = useState(0);
  const cartRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const chipRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const closed = ['closed', 'not_accepting'].includes(data.branch.state);
  const busy = data.branch.state === 'busy';
  const nameOf = (i: { name: string; name_en: string | null }) => (lang === 'en' && i.name_en) || i.name;

  // the cart survives a refresh (this phone only)
  useEffect(() => { try { const s = localStorage.getItem('qr-cart-' + code); if (s) setLines(JSON.parse(s)); } catch { /* private mode */ } }, [code]);
  useEffect(() => { try { localStorage.setItem('qr-cart-' + code, JSON.stringify(lines)); } catch { /* private mode */ } }, [lines, code]);
  // a sheet open: the page behind stays still
  useEffect(() => {
    document.body.style.overflow = open || cartOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open, cartOpen]);
  // the suggestion steps aside by itself
  useEffect(() => { if (!suggest) return; const t = setTimeout(() => setSuggest(null), 9000); return () => clearTimeout(t); }, [suggest]);

  // the category the customer is reading lights up, and its tab slides into view
  useEffect(() => {
    const els = data.categories.map((_, i) => document.getElementById(`cat-${i}`)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(entries => {
      const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setCat(Number(top.target.id.slice(4)));
    }, { rootMargin: '-120px 0px -60% 0px' });
    els.forEach(e => io.observe(e));
    return () => io.disconnect();
  }, [data.categories]);
  useEffect(() => {
    const nav = navRef.current, chip = chipRefs.current[cat];
    if (!nav || !chip) return;
    const n = nav.getBoundingClientRect(), c = chip.getBoundingClientRect();
    nav.scrollBy({ left: c.left + c.width / 2 - (n.left + n.width / 2), behavior: reduced() ? 'auto' : 'smooth' });
  }, [cat]);

  const linePrice = useCallback((l: Line) => {
    const i = items.get(l.code); if (!i) return 0;
    const adds = l.choices.reduce((s, c) => s + c.selected.reduce((x, n) => x + Number(i.levels.find(v => v.level === c.level)?.options.find(o => o.name === n)?.price || 0), 0), 0);
    return (Number(i.price || 0) + adds) * l.quantity;
  }, [items]);
  const count = lines.reduce((s, l) => s + (items.get(l.code)?.unit === 'kg' ? 1 : l.quantity), 0);
  const total = lines.reduce((s, l) => s + linePrice(l), 0);
  const shownTotal = useTween(total);
  const inCart = (c: string) => lines.filter(l => l.code === c).reduce((s, l) => s + (items.get(c)?.unit === 'kg' ? 1 : l.quantity), 0);
  const plainLine = (c: string) => lines.find(l => l.code === c && !l.choices.length && !l.notes);

  // the dish flies from where it was tapped into the order bar, which answers with a bump
  const fly = (from: Element | null, photo: string | null) => {
    const bar = cartRef.current;
    const land = () => {
      bar?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 340, easing: 'ease-out' });
      bubbleRef.current?.animate([{ transform: 'scale(.5)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    };
    if (!from || reduced()) { land(); return; }
    const a = from.getBoundingClientRect();
    const b = bubbleRef.current && lines.length ? bubbleRef.current.getBoundingClientRect() : { left: innerWidth / 2 - 20, top: innerHeight - 56, width: 40, height: 40 };
    const dot = document.createElement('div');
    const size = 46;
    Object.assign(dot.style, {
      position: 'fixed', left: `${a.left + a.width / 2 - size / 2}px`, top: `${a.top + a.height / 2 - size / 2}px`, width: `${size}px`, height: `${size}px`,
      borderRadius: '50%', zIndex: '60', pointerEvents: 'none', boxShadow: '0 8px 20px rgba(0,0,0,.25)', border: '3px solid #fff',
      background: photo ? `center / cover url("${photo}")` : 'var(--brand)'
    });
    (document.querySelector('.qr-root') || document.body).appendChild(dot);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    dot.animate([
      { transform: 'translate(0,0) scale(1)' },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 90}px) scale(.85)`, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(.3)`, opacity: 0.7 }
    ], { duration: 640, easing: 'cubic-bezier(.45,0,.55,1)' }).onfinish = () => { dot.remove(); land(); };
  };

  const suggestAfter = (c: string) => {
    const next = (data.pairs[c] || []).map(x => items.get(x)).find(x => x && x.available && x.code !== c && !lines.some(y => y.code === x.code));
    setSuggest(next || null);
  };
  const addLine = (l: Line, from: Element | null) => {
    const i = items.get(l.code);
    setLines(ls => {
      const same = !l.choices.length && !l.notes && ls.find(x => x.code === l.code && !x.choices.length && !x.notes);
      return same ? ls.map(x => x === same ? { ...x, quantity: Math.round((x.quantity + l.quantity) * 100) / 100 } : x) : [...ls, l];
    });
    buzz();
    fly(from, i?.photo || null);
    suggestAfter(l.code);
  };
  const quickAdd = (i: QrItem, from: Element | null) => addLine({ key: crypto.randomUUID(), code: i.code, quantity: 1, choices: [], notes: '' }, from);
  const quickLess = (i: QrItem) => {
    buzz(8);
    setLines(ls => {
      const p = ls.find(x => x.code === i.code && !x.choices.length && !x.notes);
      if (!p) return ls;
      return p.quantity <= 1 ? ls.filter(x => x !== p) : ls.map(x => x === p ? { ...x, quantity: x.quantity - 1 } : x);
    });
  };
  const tapAdd = (i: QrItem, el: Element) => { if (isSimple(i)) quickAdd(i, el); else setOpen(i); };

  const favourites = data.categories.flatMap(c => c.items).filter(i => i.signature && i.available);
  const allCount = items.size;
  const priceTag = (i: QrItem, size = 'text-[22px]') => i.price == null ? null : (
    <span className="flex items-baseline gap-1">
      <span className={`board ${size}`}>{fmt(i.price)}</span>
      <span className="text-sm font-medium">{sym}</span>
      {i.unit === 'kg' && <span className="text-xs text-[#6E6A64]">/ {w.perKg}</span>}
    </span>
  );

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={brandVars(data.restaurant.color)}
         className={`qr-root ${lalezar.variable} ${readex.variable} min-h-screen pb-32`}>
      <div className="mx-auto max-w-lg">
        {/* the restaurant, and the stub: where they sit and when it will be ready */}
        <header className="bg-[var(--brand)] px-5 pb-16 pt-5 text-[var(--brand-on)]">
          <div className="flex items-center justify-between">
            {data.restaurant.logo_url
              ? <img src={data.restaurant.logo_url} alt="" className="size-14 rounded-2xl bg-white object-cover shadow-[0_6px_16px_rgba(0,0,0,.18)]" />
              : <span />}
            <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
              className="flex h-10 items-center gap-1.5 rounded-full bg-black/15 px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">
              <Languages className="size-4" aria-hidden /> {w.langSwitch}
            </button>
          </div>
          <h1 className="board mt-5 text-[44px]">{(lang === 'en' && data.restaurant.name_en) || data.restaurant.name_ar}</h1>
          <p className="mt-1 text-[15px] opacity-85">{(lang === 'en' && data.branch.name_en) || data.branch.name_ar}</p>
        </header>

        <div className="relative z-[1] -mt-11 px-4">
          <div className="ticket flex items-stretch rounded-2xl bg-white shadow-[0_10px_30px_rgba(29,28,26,.12)]">
            <div className="flex w-28 shrink-0 flex-col items-center justify-center px-3 py-4 text-[var(--brand-deep)]">
              {data.table
                ? <><span className="text-xs font-medium text-[#6E6A64]">{w.table}</span><span className="board text-[52px]">{data.table}</span></>
                : <ShoppingBag className="size-10" aria-hidden />}
            </div>
            <div className="my-3 border-s-2 border-dashed border-[#E2E1DC]" />
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-4 py-4">
              {closed || busy ? (
                <>
                  <p className="font-semibold text-[#B4232A]">{closed ? w.closed : w.busy}</p>
                  {closed && data.branch.hours_text_ar && <p className="text-sm text-[#6E6A64]">{data.branch.hours_text_ar}</p>}
                </>
              ) : (
                <>
                  <p className="font-semibold">{data.table ? w.bringIt : w.counter}</p>
                  <p className="flex items-center gap-1.5 text-sm text-[#6E6A64]"><Clock className="size-4 shrink-0" aria-hidden /> {w.ready(data.branch.prep_minutes || 15)}</p>
                  <p className="flex items-center gap-2 text-sm text-[#6E6A64]">
                    {data.pay.cash && <span className="flex items-center gap-1"><Banknote className="size-4" aria-hidden /> {w.cash}</span>}
                    {data.pay.card && <span className="flex items-center gap-1"><CreditCard className="size-4" aria-hidden /> {w.card}</span>}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* offers, as coupons */}
        {data.offers.length > 0 && (
          <div className="no-bar mt-5 flex snap-x gap-3 overflow-x-auto px-4">
            {data.offers.map((o, i) => (
              <div key={i} className="flex w-[78%] max-w-72 shrink-0 snap-start gap-3 rounded-2xl border-2 border-dashed border-[var(--brand)] bg-[var(--brand-wash)] p-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-[var(--brand-on)]">
                  {o.every_nth_order ? <Gift className="size-5" aria-hidden /> : <Ticket className="size-5" aria-hidden />}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold leading-snug text-[var(--brand-deep)]">{(lang === 'en' && o.title_en) || o.title_ar}</span>
                  {(o.description_ar || o.every_nth_order) && (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-[#6E6A64]">{o.every_nth_order ? w.every(o.every_nth_order) : o.description_ar}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* the categories: the one being read is filled */}
        <nav ref={navRef} aria-label="Menu" className="no-bar sticky top-0 z-10 mt-4 flex gap-2 overflow-x-auto bg-[#F1F2EF]/[.97] px-4 py-3 backdrop-blur-md">
          {data.categories.map((c, i) => (
            <a key={i} ref={el => { chipRefs.current[i] = el; }} href={`#cat-${i}`} aria-current={cat === i ? 'true' : undefined}
               onClick={e => { e.preventDefault(); setCat(i); document.getElementById(`cat-${i}`)?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth' }); }}
               className={`flex h-10 shrink-0 items-center rounded-full px-4 text-[15px] font-medium transition-colors duration-200
                 ${cat === i ? 'bg-[#1D1C1A] text-white' : 'bg-white text-[#1D1C1A] shadow-[0_1px_0_#E2E1DC]'}`}>
              {(lang === 'en' && c.name_en) || c.name_ar || '—'}
            </a>
          ))}
        </nav>

        <main className="px-4">
          {favourites.length >= 2 && allCount > 6 && (
            <section className="pt-3">
              <h2 className="board text-[28px]">{w.favourites}</h2>
              <div className="no-bar -mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-1">
                {favourites.map(i => (
                  <div key={i.code} role="button" tabIndex={0} onClick={() => setOpen(i)} onKeyDown={e => e.key === 'Enter' && setOpen(i)}
                    className="relative h-64 w-52 shrink-0 snap-start overflow-hidden rounded-[22px] bg-[var(--brand-deep)] text-white transition-transform duration-150 active:scale-[.98]">
                    {i.photo
                      ? <img src={i.photo} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                      : <span className="board absolute inset-0 flex items-center justify-center text-[96px] text-white/20">{nameOf(i).slice(0, 1)}</span>}
                    <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                    <span className="absolute inset-x-0 bottom-0 p-3.5">
                      <span className="board block text-[24px] drop-shadow">{nameOf(i)}</span>
                      <span className="mt-1.5 flex items-center justify-between">
                        {priceTag(i, 'text-[22px]')}
                        <AddControl item={i} w={w} qty={plainLine(i.code)?.quantity || 0} simple={isSimple(i)} inCart={inCart(i.code)}
                          onAdd={el => tapAdd(i, el)} onLess={() => quickLess(i)} light />
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.categories.map((c, ci) => (
            <section key={ci} id={`cat-${ci}`} className="scroll-mt-16 pt-7">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="board text-[30px]">{(lang === 'en' && c.name_en) || c.name_ar}</h2>
                <span className="text-sm text-[#6E6A64]">{w.items(c.items.length)}</span>
              </div>
              <div className="mt-3 space-y-3">
                {c.items.map(i => (
                  <div key={i.code} role="button" tabIndex={i.available ? 0 : -1} aria-disabled={!i.available}
                    onClick={() => i.available && setOpen(i)} onKeyDown={e => e.key === 'Enter' && i.available && setOpen(i)}
                    className={`flex gap-3.5 rounded-[22px] bg-white p-3 shadow-[0_1px_0_#E2E1DC] transition-transform duration-150
                      ${i.available ? 'cursor-pointer active:scale-[.985]' : 'opacity-60'}`}>
                    <span className="relative size-[104px] shrink-0">
                      {i.photo
                        ? <img src={i.photo} alt="" loading="lazy" className={`size-full rounded-2xl object-cover ${i.available ? '' : 'grayscale'}`} />
                        : <span className="board flex size-full items-center justify-center rounded-2xl bg-[var(--brand-wash)] text-[46px] text-[var(--brand-deep)]">{nameOf(i).slice(0, 1)}</span>}
                      {!i.available && <span className="absolute inset-x-2 bottom-2 rounded-full bg-[#1D1C1A] py-0.5 text-center text-xs font-semibold text-white">{w.soldOut}</span>}
                      {inCart(i.code) > 0 && !isSimple(i) && (
                        <span key={inCart(i.code)} className="qr-pop absolute -end-1.5 -top-1.5 flex size-7 items-center justify-center rounded-full border-2 border-white bg-[var(--brand)] text-xs font-bold text-[var(--brand-on)]">
                          {inCart(i.code)}
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-start gap-1.5 text-[16.5px] font-semibold leading-snug">
                        {nameOf(i)}
                        {i.signature && <Star className="mt-1 size-3.5 shrink-0 fill-[var(--brand)] text-[var(--brand)]" aria-label={w.fav} />}
                      </span>
                      {i.desc && <span className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-[#6E6A64]">{i.desc}</span>}
                      <span className="mt-auto flex items-end justify-between pt-2">
                        {priceTag(i)}
                        {i.available && <AddControl item={i} w={w} qty={plainLine(i.code)?.quantity || 0} simple={isSimple(i)} inCart={inCart(i.code)}
                                          onAdd={el => tapAdd(i, el)} onLess={() => quickLess(i)} />}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {data.branch.vat_percent != null && <p className="pt-8 text-center text-xs text-[#6E6A64]">{w.vat(data.branch.vat_percent)}</p>}
        </main>
      </div>

      {/* the order bar: what is in it and what it costs, always within thumb reach */}
      <div inert={!lines.length || cartOpen}
           className={`fixed inset-x-0 bottom-0 z-20 mx-auto max-w-lg px-3 pb-[max(12px,env(safe-area-inset-bottom))] transition-transform duration-300
                       ${lines.length && !cartOpen ? 'translate-y-0' : 'pointer-events-none translate-y-[140%]'}`}>
        {suggest && !open && (
          <div className="qr-rise mb-2 flex items-center gap-3 rounded-2xl bg-white p-2.5 shadow-[0_10px_30px_rgba(29,28,26,.18)]">
            {suggest.photo
              ? <img src={suggest.photo} alt="" className="size-12 rounded-xl object-cover" />
              : <span className="board flex size-12 items-center justify-center rounded-xl bg-[var(--brand-wash)] text-2xl text-[var(--brand-deep)]">{nameOf(suggest).slice(0, 1)}</span>}
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-[#6E6A64]">{w.goesWith}</span>
              <span className="block truncate font-semibold">{nameOf(suggest)}</span>
            </span>
            <button onClick={e => { const s = suggest; setSuggest(null); if (isSimple(s)) quickAdd(s, e.currentTarget); else setOpen(s); }}
              className="h-10 rounded-full bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--brand-on)]">
              {w.addIt} {suggest.price != null && <>· {fmt(suggest.price)}{sym}</>}
            </button>
            <button onClick={() => setSuggest(null)} aria-label={w.close} className="flex size-10 items-center justify-center text-[#6E6A64]"><X className="size-4" /></button>
          </div>
        )}
        <button ref={cartRef} onClick={() => { setCartOpen(true); setSuggest(null); }}
          className="flex h-16 w-full items-center gap-3 rounded-[20px] bg-[var(--brand)] px-3 text-[var(--brand-on)] shadow-[0_12px_28px_-8px_var(--brand)]">
          <span ref={bubbleRef} className="board flex size-10 items-center justify-center rounded-full bg-[var(--brand-on)] text-xl text-[var(--brand)]">{count}</span>
          <span className="flex-1 text-start">
            <span className="block font-semibold leading-tight">{w.see}</span>
            <span className="block text-xs opacity-80">{w.count(count)}</span>
          </span>
          <span className="board text-[26px]">{fmt(shownTotal)}<span className="ms-1 font-[family-name:var(--font-qr)] text-sm">{sym}</span></span>
        </button>
      </div>

      {open && <ItemSheet item={open} w={w} lang={lang} sym={sym} onClose={() => setOpen(null)}
                          onAdd={(l, el) => { setOpen(null); addLine(l, el); }} />}
      {cartOpen && (
        <CartSheet data={data} code={code} w={w} lang={lang} lines={lines} setLines={setLines} items={items} linePrice={linePrice}
                   total={total} sym={sym} blocked={closed || busy} onClose={() => setCartOpen(false)} />
      )}
    </div>
  );
}

// "+" on a dish; for a dish with nothing to choose it becomes − 2 + in place
function AddControl({ item, w, qty, simple, inCart, onAdd, onLess, light }: {
  item: QrItem; w: Words; qty: number; simple: boolean; inCart: number; onAdd: (el: Element) => void; onLess: () => void; light?: boolean;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (simple && qty > 0) {
    return (
      <span onClick={stop} className="flex h-10 items-center rounded-full bg-[var(--brand)] text-[var(--brand-on)]">
        <button onClick={onLess} aria-label={w.less} className="flex size-10 items-center justify-center"><Minus className="size-4" /></button>
        <span key={qty} className="board qr-pop min-w-5 text-center text-xl">{qty}</span>
        <button onClick={e => onAdd(e.currentTarget)} aria-label={w.more} className="flex size-10 items-center justify-center"><Plus className="size-4" /></button>
      </span>
    );
  }
  return (
    <button onClick={e => { stop(e); onAdd(e.currentTarget); }} aria-label={`+ ${item.name}`}
      className={`flex size-10 shrink-0 items-center justify-center rounded-full transition-transform duration-150 active:scale-90
        ${light ? 'bg-white text-[#1D1C1A]' : 'bg-[var(--brand)] text-[var(--brand-on)]'} ${inCart && !simple ? 'ring-2 ring-[var(--brand)] ring-offset-2' : ''}`}>
      <Plus className="size-5" />
    </button>
  );
}

function Sheet({ children, onClose, footer, label }: { children: ReactNode; onClose: () => void; footer?: ReactNode; label: string }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={label}>
      <div className="qr-backdrop absolute inset-0 bg-[#1D1C1A]/55" onClick={onClose} />
      <div className="qr-sheet relative flex max-h-[94vh] w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] bg-[#F1F2EF]">
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && <div className="border-t border-[#E2E1DC] bg-white px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>
  );
}

function ItemSheet({ item, w, lang, sym, onClose, onAdd }:
  { item: QrItem; w: Words; lang: 'ar' | 'en'; sym: string; onClose: () => void; onAdd: (l: Line, from: Element | null) => void }) {
  const kg = item.unit === 'kg';
  const step = kg ? Number(item.qty_step || 0.25) : 1;
  const least = kg ? Math.max(step, Number(item.min_qty || step)) : 1;
  const [q, setQ] = useState(kg ? Math.max(Number(item.min_qty || 0.5), step) : 1);
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [notes, setNotes] = useState('');
  const levelRefs = useRef<Record<number, HTMLFieldSetElement | null>>({});
  const levels = levelsOf(item);
  const label = (l: { label_ar: string; label_en?: string | null }) => (lang === 'en' && l.label_en) || l.label_ar;
  const missing = levels.filter(l => l.required && (sel[l.level] || []).length < Math.max(1, Number(l.min || 1)));
  const adds = levels.reduce((s, l) => s + (sel[l.level] || []).reduce((x, n) => x + Number(l.options.find(o => o.name === n)?.price || 0), 0), 0);
  const price = useTween((Number(item.price || 0) + adds) * q, 300);
  const single = (l: QrLevel) => l.max === 1 || (l.required && (l.max || 1) === 1);
  const toggle = (l: QrLevel, name: string) => { buzz(6); setSel(s => {
    const cur = s[l.level] || [];
    if (single(l)) return { ...s, [l.level]: [name] };
    if (cur.includes(name)) return { ...s, [l.level]: cur.filter(x => x !== name) };
    if (l.max && cur.length >= l.max) return s;
    return { ...s, [l.level]: [...cur, name] };
  }); };
  // a choice still missing: take them to it and nudge it
  const submit = (el: Element) => {
    if (missing.length) {
      const f = levelRefs.current[missing[0].level];
      f?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
      if (f && !reduced()) f.animate([{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'none' }], { duration: 400 });
      buzz(30);
      return;
    }
    onAdd({ key: crypto.randomUUID(), code: item.code, quantity: q, notes: notes.trim(),
            choices: Object.entries(sel).filter(([, v]) => v.length).map(([k, v]) => ({ level: Number(k), selected: v })) }, el);
  };
  const name = (lang === 'en' && item.name_en) || item.name;

  return (
    <Sheet onClose={onClose} label={name} footer={
      <div className="flex items-center gap-3">
        <div className="flex h-14 items-center rounded-full bg-[#F1F2EF]">
          <button onClick={() => { buzz(6); setQ(x => Math.max(least, Math.round((x - step) * 100) / 100)); }} aria-label={w.less} className="flex size-12 items-center justify-center"><Minus className="size-5" /></button>
          <span className={`${kg ? 'min-w-20 text-base font-semibold' : 'board min-w-8 text-2xl'} text-center`}>{kg ? kgText(q, lang) : q}</span>
          <button onClick={() => { buzz(6); setQ(x => Math.min(50, Math.round((x + step) * 100) / 100)); }} aria-label={w.more} className="flex size-12 items-center justify-center"><Plus className="size-5" /></button>
        </div>
        <button onClick={e => submit(e.currentTarget)}
          className={`flex h-14 flex-1 items-center justify-between gap-2 rounded-[18px] px-5 font-semibold transition-colors duration-200
            ${missing.length ? 'bg-[#1D1C1A]/10 text-[#1D1C1A]' : 'bg-[var(--brand)] text-[var(--brand-on)]'}`}>
          <span className="truncate">{missing.length ? w.choose(label(missing[0])) : w.add}</span>
          <span className="board shrink-0 text-2xl">{fmt(price)}<span className="ms-1 font-[family-name:var(--font-qr)] text-sm">{sym}</span></span>
        </button>
      </div>
    }>
      <div className="relative">
        {item.photo
          ? <img src={item.photo} alt="" className="h-64 w-full object-cover" />
          : <div className="board flex h-40 items-center justify-center bg-[var(--brand-wash)] text-[96px] text-[var(--brand-deep)]">{name.slice(0, 1)}</div>}
        <button onClick={onClose} aria-label={w.close} className="absolute end-3 top-4 flex size-11 items-center justify-center rounded-full bg-white/95 shadow"><X className="size-5" /></button>
      </div>
      <div className="space-y-5 px-5 pb-6 pt-5">
        <div>
          <h3 className="board text-[34px]">{name}</h3>
          {item.desc && <p className="mt-2 leading-relaxed text-[#6E6A64]">{item.desc}</p>}
          {item.price != null && (
            <p className="mt-2 flex items-baseline gap-1 text-[var(--brand-deep)]">
              <span className="board text-2xl">{fmt(item.price)}</span><span className="text-sm">{sym}</span>
              {kg && <span className="text-sm text-[#6E6A64]">/ {w.perKg}</span>}
            </p>
          )}
        </div>
        {levels.map(l => {
          const multi = !single(l);
          return (
            <fieldset key={l.level} ref={el => { levelRefs.current[l.level] = el; }} className="rounded-[20px] bg-white p-4">
              <legend className="sr-only">{label(l)}</legend>
              <div className="mb-3 flex items-center justify-between gap-2" aria-hidden>
                <span className="text-[17px] font-semibold">{label(l)}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${l.required ? 'bg-[var(--brand-wash)] text-[var(--brand-deep)]' : 'bg-[#F1F2EF] text-[#6E6A64]'}`}>
                  {l.required ? w.required : l.max && l.max > 1 ? w.upTo(l.max) : w.optional}
                </span>
              </div>
              <div className="space-y-2">
                {l.options.map(o => {
                  const on = (sel[l.level] || []).includes(o.name);
                  return (
                    <button key={o.name} role={multi ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => toggle(l, o.name)}
                      className={`flex min-h-12 w-full items-center gap-3 rounded-2xl border-2 px-3.5 py-2.5 text-start transition-colors duration-150
                        ${on ? 'border-[var(--brand)] bg-[var(--brand-wash)]' : 'border-[#ECEBE7] bg-white'}`}>
                      <span className={`flex size-6 shrink-0 items-center justify-center border-2 transition-colors duration-150 ${multi ? 'rounded-md' : 'rounded-full'}
                        ${on ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-on)]' : 'border-[#CFCDC7]'}`}>
                        {on && <Check className="qr-pop size-4" strokeWidth={3} />}
                      </span>
                      <span className="flex-1">{(lang === 'en' && o.name_en) || o.name}</span>
                      {!!o.price && <span className="text-sm font-medium text-[#6E6A64]">+{fmt(o.price)}{sym}</span>}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{w.notes} <span className="font-normal text-[#6E6A64]">({w.optional})</span></span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={w.notesHint} dir="auto" rows={2}
                    className="w-full rounded-2xl border-2 border-[#ECEBE7] bg-white px-3.5 py-2.5 text-[15px] outline-none focus:border-[var(--brand)]" />
        </label>
      </div>
    </Sheet>
  );
}

function CartSheet({ data, code, w, lang, lines, setLines, items, linePrice, total, sym, blocked, onClose }: {
  data: QrMenuData; code: string; w: Words; lang: 'ar' | 'en'; lines: Line[]; setLines: (f: (l: Line[]) => Line[]) => void; items: Map<string, QrItem>;
  linePrice: (l: Line) => number; total: number; sym: string; blocked: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState<'card' | 'cash' | null>(data.pay.card && !data.pay.cash ? 'card' : data.pay.cash && !data.pay.card ? 'cash' : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const payRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => { try { setName(localStorage.getItem('qr-name') || ''); setPhone(localStorage.getItem('qr-phone') || ''); } catch { /* private mode */ } }, []);
  const request = lines.map(l => ({ code: l.code, quantity: l.quantity, choices: l.choices, notes: l.notes }));
  const asked = JSON.stringify(request) + phone;
  const errorText = (j: { error?: string; detail?: string }) => (w.errors[j.error || ''] || w.errors.default) + (j.detail && w.errors[j.error || ''] ? j.detail : '');
  // the server's price for this cart (offers, loyalty, VAT): what the button charges
  useEffect(() => {
    if (!lines.length) { setQuote(null); return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/q/${code}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ items: request, phone, quote: true }) })
        .then(r => r.json()).then((j: Quote) => { setQuote(j.ok ? j : null); setErr(j.ok ? '' : errorText(j)); })
        .catch(() => null);
    }, 350);
    return () => { clearTimeout(timer); ctl.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, code]);
  const charge = useTween(quote?.total ?? total);

  const place = async () => {
    if (!method) {
      payRef.current?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
      if (!reduced()) payRef.current?.animate([{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], { duration: 380 });
      buzz(30); setErr(w.payFirst);
      return;
    }
    setBusy(true); setErr('');
    try { localStorage.setItem('qr-name', name); localStorage.setItem('qr-phone', phone); } catch { /* private mode */ }
    const res = await fetch(`/api/q/${code}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: request, method, name, phone }) });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; token?: string; pay_url?: string; pay_error?: string; error?: string; detail?: string };
    if (!j.ok || !j.token) { setErr(errorText(j)); setBusy(false); return; }
    try { localStorage.removeItem('qr-cart-' + code); } catch { /* private mode */ }
    if (j.pay_url) { window.location.href = j.pay_url; return; }
    window.location.href = `/q/t/${j.token}${j.pay_error ? '?pay=failed' : ''}`;
  };
  const qtyStep = (l: Line, d: 1 | -1) => { buzz(6); setLines(ls => ls.map(x => {
    if (x.key !== l.key) return x;
    const i = items.get(x.code); const step = i?.unit === 'kg' ? Number(i.qty_step || 0.25) : 1;
    return { ...x, quantity: Math.max(step, Math.round((x.quantity + d * step) * 100) / 100) };
  })); };
  const methods = [
    data.pay.card && { key: 'card' as const, icon: CreditCard, title: w.card, sub: w.cardSub },
    data.pay.cash && { key: 'cash' as const, icon: Banknote, title: w.cash, sub: w.cashSub }
  ].filter(Boolean) as { key: 'card' | 'cash'; icon: typeof CreditCard; title: string; sub: string }[];
  const field = 'h-12 w-full rounded-2xl border-2 border-[#ECEBE7] bg-white px-3.5 text-[15px] outline-none focus:border-[var(--brand)]';

  return (
    <Sheet onClose={onClose} label={w.yourOrder} footer={lines.length > 0 && (
      <button onClick={place} disabled={busy || blocked}
        className="flex h-16 w-full items-center justify-between rounded-[20px] bg-[var(--brand)] px-5 text-[var(--brand-on)] disabled:opacity-50">
        <span className="text-lg font-semibold">{blocked ? (data.branch.state === 'busy' ? w.busy : w.closed) : busy ? w.sending : w.place}</span>
        <span className="board text-[28px]">{fmt(charge)}<span className="ms-1 font-[family-name:var(--font-qr)] text-sm">{sym}</span></span>
      </button>
    )}>
      <div className="flex items-center justify-between px-5 pb-3 pt-7">
        <h3 className="board text-[34px]">{w.yourOrder}</h3>
        <button onClick={onClose} aria-label={w.close} className="flex size-11 items-center justify-center rounded-full bg-white"><X className="size-5" /></button>
      </div>

      {/* the receipt */}
      <div className="mx-4 rounded-b-[20px] bg-white pb-4 pt-5 torn">
        {lines.length === 0 && (
          <p className="flex flex-col items-center gap-2 px-5 py-8 text-[#6E6A64]"><UtensilsCrossed className="size-8" aria-hidden /> {w.empty}</p>
        )}
        <ul className="divide-y divide-dashed divide-[#E2E1DC] px-4">
          {lines.map(l => {
            const i = items.get(l.code); if (!i) return null;
            const names = l.choices.flatMap(c => c.selected);
            return (
              <li key={l.key} className="py-3">
                <div className="flex items-start gap-3">
                  <span className="board min-w-9 text-[22px] text-[var(--brand-deep)]">{i.unit === 'kg' ? '' : `${l.quantity}×`}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{(lang === 'en' && i.name_en) || i.name}</span>
                    {i.unit === 'kg' && <span className="block text-sm text-[var(--brand-deep)]">{kgText(l.quantity, lang)}</span>}
                    {names.length > 0 && <span className="block text-sm text-[#6E6A64]">{names.join('، ')}</span>}
                    {l.notes && <span className="block text-sm italic text-[#6E6A64]" dir="auto">{l.notes}</span>}
                  </span>
                  <span className="shrink-0 font-semibold">{fmt(linePrice(l))}{sym}</span>
                </div>
                <div className="mt-2 flex items-center justify-end gap-1">
                  <button onClick={() => { buzz(10); setLines(ls => ls.filter(x => x.key !== l.key)); }} aria-label={w.remove}
                    className="flex size-10 items-center justify-center rounded-full text-[#6E6A64]"><Trash2 className="size-4" /></button>
                  <span className="flex h-10 items-center rounded-full bg-[#F1F2EF]">
                    <button onClick={() => qtyStep(l, -1)} aria-label={w.less} className="flex size-10 items-center justify-center"><Minus className="size-4" /></button>
                    <span className="min-w-8 text-center text-sm font-semibold">{i.unit === 'kg' ? kgText(l.quantity, lang) : l.quantity}</span>
                    <button onClick={() => qtyStep(l, 1)} aria-label={w.more} className="flex size-10 items-center justify-center"><Plus className="size-4" /></button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        {quote && lines.length > 0 && (
          <dl className="mx-4 mt-1 space-y-1.5 border-t-2 border-dashed border-[#E2E1DC] pt-3 text-[15px]">
            {(quote.discount_total > 0 || quote.vat != null || quote.gifts.length > 0) && (
              <div className="flex justify-between"><dt className="text-[#6E6A64]">{w.subtotal}</dt><dd>{fmt(quote.subtotal)}{sym}</dd></div>
            )}
            {quote.offers.filter(o => o.amount > 0).map(o => (
              <div key={o.id} className="flex justify-between gap-3 text-[#1F7A52]"><dt className="flex items-center gap-1.5"><Ticket className="size-4 shrink-0" aria-hidden /> {o.title}</dt><dd>−{fmt(o.amount)}{sym}</dd></div>
            ))}
            {quote.gifts.map(g => (
              <div key={g.name} className="flex justify-between gap-3 text-[#1F7A52]"><dt className="flex items-center gap-1.5"><Gift className="size-4 shrink-0" aria-hidden /> {g.name}</dt><dd>{w.gift}</dd></div>
            ))}
            {quote.vat != null && <div className="flex justify-between"><dt className="text-[#6E6A64]">{w.vatLine} {data.branch.vat_percent}%</dt><dd>{fmt(quote.vat)}{sym}</dd></div>}
            <div className="flex items-baseline justify-between pt-1"><dt className="font-semibold">{w.total}</dt><dd className="board text-[28px]">{fmt(quote.total)}<span className="ms-1 font-[family-name:var(--font-qr)] text-sm">{sym}</span></dd></div>
          </dl>
        )}
      </div>

      {lines.length > 0 && (
        <div className="space-y-5 px-4 pb-6 pt-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">{w.name} <span className="font-normal text-[#6E6A64]">({w.optionalField})</span></span>
              <input value={name} onChange={e => setName(e.target.value)} dir="auto" autoComplete="given-name" className={field} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">{w.phone} <span className="font-normal text-[#6E6A64]">({w.optionalField})</span></span>
              <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" dir="ltr" autoComplete="tel" className={field} />
              <span className="mt-1 block text-xs text-[#6E6A64]">{w.phoneHint}</span>
            </label>
          </div>
          <fieldset ref={payRef}>
            <legend className="mb-2 text-[17px] font-semibold">{w.pay}</legend>
            <div className={`grid gap-3 ${methods.length > 1 ? 'grid-cols-2' : ''}`}>
              {methods.map(m => {
                const on = method === m.key;
                return (
                  <button key={m.key} role="radio" aria-checked={on} onClick={() => { buzz(6); setMethod(m.key); setErr(''); }}
                    className={`relative flex flex-col items-start gap-2 rounded-[20px] border-2 p-4 text-start transition-colors duration-150
                      ${on ? 'border-[var(--brand)] bg-[var(--brand-wash)]' : 'border-[#ECEBE7] bg-white'}`}>
                    <span className={`flex size-11 items-center justify-center rounded-full ${on ? 'bg-[var(--brand)] text-[var(--brand-on)]' : 'bg-[#F1F2EF]'}`}><m.icon className="size-5" aria-hidden /></span>
                    <span className="font-semibold">{m.title}</span>
                    <span className="text-xs leading-relaxed text-[#6E6A64]">{m.sub}</span>
                    {on && <Check className="qr-pop absolute end-3 top-3 size-5 text-[var(--brand-deep)]" strokeWidth={3} aria-hidden />}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {err && <p role="alert" className="rounded-2xl bg-[#FBE9E8] px-4 py-3 text-sm font-medium text-[#B4232A]">{err}</p>}
          {data.branch.vat_percent != null && !quote && <p className="text-center text-xs text-[#6E6A64]">{w.vat(data.branch.vat_percent)}</p>}
        </div>
      )}
    </Sheet>
  );
}
