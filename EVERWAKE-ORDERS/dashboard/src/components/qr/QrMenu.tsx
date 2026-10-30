'use client';
import { Banknote, CreditCard, Globe, Minus, Plus, ShoppingBag, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { kgText } from './kg';

// The branch's menu on the customer's phone, from a QR code on the counter
// or a table. They pick dishes and choices, then pay by card or cash at the
// counter. Prices here are a preview: the server prices the cart again.
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

const W = {
  ar: {
    table: 'ترابيزة', closed: 'الفرع مقفول دلوقتي', busy: 'الفرع عليه ضغط دلوقتي ومش واخد طلبات جديدة', soldOut: 'خلصان',
    add: 'ضيف', cart: 'السلة', checkout: 'كمّل الطلب', notes: 'ملاحظة للمطبخ (اختياري)', required: 'مطلوب', upTo: 'لحد',
    name: 'اسمك (اختياري)', phone: 'رقم موبايلك (اختياري)', phoneHint: 'للإيصال والمكافآت', pay: 'هتدفع إزاي؟',
    card: 'كارت / محفظة', cash: 'كاش عند الكاشير', place: 'اطلب', total: 'الإجمالي', vat: 'الأسعار من غير ضريبة', empty: 'السلة فاضية',
    subtotal: 'الأصناف', vatLine: 'ضريبة', gift: 'هدية',
    goesWith: 'بيتطلب معاه غالباً', addIt: 'ضيفه', kg: 'كيلو', perKg: 'للكيلو', sending: 'بنبعت طلبك…', each: 'للواحد',
    errors: { SOLD_OUT: 'صنف خلص من شوية: ', CHOICE_MISSING: 'محتاج تختار: ', BRANCH_CLOSED: 'الفرع مقفول دلوقتي', BRANCH_BUSY: 'الفرع مش واخد طلبات دلوقتي',
              NOT_ON_MENU: 'صنف مش متاح دلوقتي', default: 'حصلت مشكلة، جرّب تاني' } as Record<string, string>,
    payFailed: 'الدفع بالكارت مش متاح دلوقتي — اختار كاش عند الكاشير'
  },
  en: {
    table: 'Table', closed: 'The branch is closed right now', busy: 'The branch is very busy and not taking new orders right now', soldOut: 'Sold out',
    add: 'Add', cart: 'Cart', checkout: 'Checkout', notes: 'Note for the kitchen (optional)', required: 'required', upTo: 'up to',
    name: 'Your name (optional)', phone: 'Your mobile (optional)', phoneHint: 'for the receipt and rewards', pay: 'How will you pay?',
    card: 'Card / wallet', cash: 'Cash at the counter', place: 'Place order', total: 'Total', vat: 'Prices exclude VAT', empty: 'Your cart is empty',
    subtotal: 'Items', vatLine: 'VAT', gift: 'Free',
    goesWith: 'Often ordered with it', addIt: 'Add', kg: 'kg', perKg: 'per kg', sending: 'Sending your order…', each: 'each',
    errors: { SOLD_OUT: 'Just sold out: ', CHOICE_MISSING: 'Please choose: ', BRANCH_CLOSED: 'The branch is closed right now', BRANCH_BUSY: 'The branch is not taking orders right now',
              NOT_ON_MENU: 'A dish is not available right now', default: 'Something went wrong, please try again' } as Record<string, string>,
    payFailed: 'Card payment is not available right now — choose cash at the counter'
  }
};
const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US');

export function QrMenu({ data, code }: { data: QrMenuData; code: string }) {
  const [lang, setLang] = useState<'ar' | 'en'>(data.restaurant.language === 'en' ? 'en' : 'ar');
  const w = W[lang];
  const sym = data.restaurant.currency_symbol || 'ج';
  const color = data.restaurant.color || '#0B222E';
  const items = useMemo(() => new Map(data.categories.flatMap(c => c.items).map(i => [i.code, i])), [data]);
  const [lines, setLines] = useState<Line[]>([]);
  const [open, setOpen] = useState<QrItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [suggest, setSuggest] = useState<QrItem | null>(null);
  const [cat, setCat] = useState(0);
  const closed = ['closed', 'not_accepting'].includes(data.branch.state);
  const busy = data.branch.state === 'busy';

  // the cart survives a refresh (this phone only)
  useEffect(() => { try { const s = localStorage.getItem('qr-cart-' + code); if (s) setLines(JSON.parse(s)); } catch { /* private mode */ } }, [code]);
  useEffect(() => { try { localStorage.setItem('qr-cart-' + code, JSON.stringify(lines)); } catch { /* private mode */ } }, [lines, code]);

  const nameOf = (i: QrItem) => (lang === 'en' && i.name_en) || i.name;
  const linePrice = (l: Line) => {
    const i = items.get(l.code); if (!i) return 0;
    const adds = l.choices.reduce((s, c) => s + c.selected.reduce((x, n) => x + Number(i.levels.find(v => v.level === c.level)?.options.find(o => o.name === n)?.price || 0), 0), 0);
    return (Number(i.price || 0) + adds) * l.quantity;
  };
  const count = lines.reduce((s, l) => s + (items.get(l.code)?.unit === 'kg' ? 1 : l.quantity), 0);
  const total = lines.reduce((s, l) => s + linePrice(l), 0);
  const priceText = (i: QrItem) => i.price == null ? '' : `${fmt(i.price)}${sym}${i.unit === 'kg' ? ' ' + w.perKg : ''}`;

  const add = (l: Line) => {
    setLines(ls => [...ls, l]);
    setOpen(null);
    const next = (data.pairs[l.code] || []).map(c => items.get(c)).find(x => x && x.available && !lines.some(y => y.code === x.code) && x.code !== l.code);
    setSuggest(next || null);
  };

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} className="min-h-screen bg-paper pb-28">
      <header className="relative overflow-hidden px-4 pb-5 pt-6 text-white" style={{ background: color }}>
        <div className="flex items-center gap-3">
          {data.restaurant.logo_url
            ? <img src={data.restaurant.logo_url} alt="" className="size-14 rounded-full bg-white object-cover shadow" />
            : <span className="flex size-14 items-center justify-center rounded-full bg-white/20 text-2xl font-bold">{data.restaurant.name_ar.slice(0, 1)}</span>}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold">{(lang === 'en' && data.restaurant.name_en) || data.restaurant.name_ar}</h1>
            <p className="truncate text-sm opacity-90">{(lang === 'en' && data.branch.name_en) || data.branch.name_ar}
              {data.table && <> · {w.table} {data.table}</>}</p>
          </div>
          <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} className="flex items-center gap-1 rounded-full bg-white/20 px-3 py-1.5 text-xs font-semibold">
            <Globe className="size-3.5" /> {lang === 'ar' ? 'EN' : 'ع'}
          </button>
        </div>
        {(closed || busy) && (
          <p className="mt-4 rounded-xl bg-white/95 px-3 py-2 text-sm font-medium text-critical">
            {closed ? w.closed : w.busy}{closed && data.branch.hours_text_ar ? ` · ${data.branch.hours_text_ar}` : ''}
          </p>
        )}
      </header>

      {data.offers.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pt-3">
          {data.offers.map((o, i) => (
            <span key={i} className="flex shrink-0 items-center gap-1.5 rounded-full bg-gold-wash px-3 py-1.5 text-xs font-semibold text-gold-ink ring-1 ring-gold-line">
              <Sparkles className="size-3.5" /> {(lang === 'en' && o.title_en) || o.title_ar}
            </span>
          ))}
        </div>
      )}

      <nav className="sticky top-0 z-10 mt-3 flex gap-2 overflow-x-auto bg-paper/95 px-4 py-2 backdrop-blur">
        {data.categories.map((c, i) => (
          <a key={i} href={`#cat-${i}`} onClick={() => setCat(i)}
             className="shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium"
             style={cat === i ? { background: color, color: '#fff' } : { background: '#fff' }}>
            {(lang === 'en' && c.name_en) || c.name_ar || '—'}
          </a>
        ))}
      </nav>

      <main className="space-y-6 px-4 pt-2">
        {data.categories.map((c, ci) => (
          <section key={ci} id={`cat-${ci}`} className="scroll-mt-14">
            <h2 className="mb-2 text-lg font-bold">{(lang === 'en' && c.name_en) || c.name_ar}</h2>
            <div className="space-y-2.5">
              {c.items.map(i => (
                <button key={i.code} disabled={!i.available} onClick={() => setOpen(i)}
                  className="flex w-full items-stretch gap-3 rounded-2xl bg-white p-2.5 text-start shadow-sm disabled:opacity-50">
                  {i.photo
                    ? <img src={i.photo} alt="" loading="lazy" className="size-24 shrink-0 rounded-xl object-cover" />
                    : <span className="flex size-24 shrink-0 items-center justify-center rounded-xl text-3xl font-bold text-white/90" style={{ background: color }}>{i.name.slice(0, 1)}</span>}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold leading-snug">{nameOf(i)} {i.signature && <span className="text-gold">★</span>}</span>
                    {i.desc && <span className="mt-0.5 line-clamp-2 text-xs text-muted">{i.desc}</span>}
                    <span className="mt-auto flex items-center justify-between pt-1.5">
                      <b className="text-sm">{i.available ? priceText(i) : w.soldOut}</b>
                      {i.available && <span className="flex size-8 items-center justify-center rounded-full text-white" style={{ background: color }}><Plus className="size-4" /></span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {data.branch.vat_percent != null && <p className="pb-2 text-center text-xs text-muted">{w.vat} {data.branch.vat_percent}%</p>}
      </main>

      {suggest && !open && (
        <div className="fixed inset-x-3 bottom-24 z-20 flex items-center gap-3 rounded-2xl bg-white p-3 shadow-lg ring-1 ring-hairline">
          {suggest.photo && <img src={suggest.photo} alt="" className="size-12 rounded-lg object-cover" />}
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-xs text-muted">{w.goesWith}</p>
            <p className="truncate font-semibold">{nameOf(suggest)} · {priceText(suggest)}</p>
          </div>
          <button onClick={() => { setOpen(suggest); setSuggest(null); }} className="rounded-full px-3 py-1.5 text-sm font-semibold text-white" style={{ background: color }}>{w.addIt}</button>
          <button onClick={() => setSuggest(null)} className="p-1 text-muted"><X className="size-4" /></button>
        </div>
      )}

      {lines.length > 0 && !cartOpen && (
        <button onClick={() => { setCartOpen(true); setSuggest(null); }}
          className="fixed inset-x-3 bottom-4 z-20 flex h-14 items-center justify-between rounded-2xl px-5 text-white shadow-lg" style={{ background: color }}>
          <span className="flex items-center gap-2 font-semibold"><ShoppingBag className="size-5" /> {w.cart} · {count}</span>
          <span className="font-bold">{fmt(total)}{sym}</span>
        </button>
      )}

      {open && <ItemSheet item={open} lang={lang} sym={sym} color={color} onClose={() => setOpen(null)} onAdd={add} />}
      {cartOpen && (
        <CartSheet data={data} code={code} lang={lang} lines={lines} setLines={setLines} items={items} linePrice={linePrice}
                   total={total} sym={sym} color={color} blocked={closed || busy} onClose={() => setCartOpen(false)} />
      )}
    </div>
  );
}

function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white pb-6 shadow-2xl">{children}</div>
    </div>
  );
}

function ItemSheet({ item, lang, sym, color, onClose, onAdd }:
  { item: QrItem; lang: 'ar' | 'en'; sym: string; color: string; onClose: () => void; onAdd: (l: Line) => void }) {
  const w = W[lang];
  const kg = item.unit === 'kg';
  const step = kg ? Number(item.qty_step || 0.25) : 1;
  const [q, setQ] = useState(kg ? Math.max(Number(item.min_qty || 0.5), step) : 1);
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [notes, setNotes] = useState('');
  const levels = item.levels.map(l => ({ ...l, options: l.options.filter(o => !o.extra_charge) })).filter(l => l.options.length);
  const missing = levels.filter(l => l.required && (sel[l.level] || []).length < Math.max(1, Number(l.min || 1)));
  const adds = levels.reduce((s, l) => s + (sel[l.level] || []).reduce((x, n) => x + Number(l.options.find(o => o.name === n)?.price || 0), 0), 0);
  const price = (Number(item.price || 0) + adds) * q;
  const toggle = (l: QrLevel, name: string) => setSel(s => {
    const cur = s[l.level] || [];
    if (l.max === 1 || (l.required && (l.max || 1) === 1)) return { ...s, [l.level]: [name] };
    if (cur.includes(name)) return { ...s, [l.level]: cur.filter(x => x !== name) };
    if (l.max && cur.length >= l.max) return s;
    return { ...s, [l.level]: [...cur, name] };
  });
  return (
    <Sheet onClose={onClose}>
      {item.photo && <img src={item.photo} alt="" className="h-56 w-full object-cover" />}
      <button onClick={onClose} className="absolute end-3 top-3 rounded-full bg-white/90 p-1.5 shadow"><X className="size-5" /></button>
      <div className="space-y-4 px-5 pt-4">
        <div>
          <h3 className="text-xl font-bold">{(lang === 'en' && item.name_en) || item.name}</h3>
          {item.desc && <p className="mt-1 text-sm text-muted">{item.desc}</p>}
        </div>
        {levels.map(l => (
          <div key={l.level}>
            <p className="mb-1.5 flex items-center justify-between text-sm font-semibold">
              <span>{(lang === 'en' && l.label_en) || l.label_ar}</span>
              <span className="text-xs font-normal text-muted">{l.required ? w.required : l.max ? `${w.upTo} ${l.max}` : ''}</span>
            </p>
            <div className="space-y-1.5">
              {l.options.map(o => {
                const on = (sel[l.level] || []).includes(o.name);
                return (
                  <button key={o.name} onClick={() => toggle(l, o.name)}
                    className="flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-sm"
                    style={on ? { borderColor: color, background: color + '12' } : { borderColor: '#DFE5E8' }}>
                    <span>{(lang === 'en' && o.name_en) || o.name}</span>
                    <span className="text-muted">{o.price ? `+${fmt(o.price)}${sym}` : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={w.notes} dir="auto"
               className="h-11 w-full rounded-xl border border-hairline px-3 text-sm" />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-full border border-hairline p-1">
            <button onClick={() => setQ(x => Math.max(kg ? Math.max(step, Number(item.min_qty || step)) : 1, Math.round((x - step) * 100) / 100))} className="p-2"><Minus className="size-4" /></button>
            <span className="min-w-16 text-center text-sm font-semibold">{kg ? kgText(q, lang) : q}</span>
            <button onClick={() => setQ(x => Math.min(50, Math.round((x + step) * 100) / 100))} className="p-2"><Plus className="size-4" /></button>
          </div>
          <button disabled={missing.length > 0}
            onClick={() => onAdd({ key: crypto.randomUUID(), code: item.code, quantity: q, notes,
                                   choices: Object.entries(sel).filter(([, v]) => v.length).map(([k, v]) => ({ level: Number(k), selected: v })) })}
            className="flex h-12 flex-1 items-center justify-between rounded-xl px-4 font-semibold text-white disabled:opacity-40" style={{ background: color }}>
            <span>{missing.length ? `${(lang === 'en' && missing[0].label_en) || missing[0].label_ar}` : w.add}</span>
            <span>{fmt(price)}{sym}</span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function CartSheet({ data, code, lang, lines, setLines, items, linePrice, total, sym, color, blocked, onClose }: {
  data: QrMenuData; code: string; lang: 'ar' | 'en'; lines: Line[]; setLines: (f: (l: Line[]) => Line[]) => void; items: Map<string, QrItem>;
  linePrice: (l: Line) => number; total: number; sym: string; color: string; blocked: boolean; onClose: () => void }) {
  const w = W[lang];
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState<'card' | 'cash' | null>(data.pay.card && !data.pay.cash ? 'card' : data.pay.cash && !data.pay.card ? 'cash' : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => { try { setName(localStorage.getItem('qr-name') || ''); setPhone(localStorage.getItem('qr-phone') || ''); } catch { /* private mode */ } }, []);
  const request = lines.map(l => ({ code: l.code, quantity: l.quantity, choices: l.choices, notes: l.notes }));
  const asked = JSON.stringify(request) + phone;
  // the server's price for this cart (offers, loyalty, VAT): what the button charges
  useEffect(() => {
    if (!lines.length) { setQuote(null); return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/q/${code}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ items: request, phone, quote: true }) })
        .then(r => r.json()).then((j: Quote) => { setQuote(j.ok ? j : null); setErr(j.ok ? '' : (w.errors[j.error || ''] || w.errors.default) + (j.detail && w.errors[j.error || ''] ? j.detail : '')); })
        .catch(() => null);
    }, 350);
    return () => { clearTimeout(timer); ctl.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, code]);
  const charge = quote?.total ?? total;

  const place = async () => {
    if (!method) return;
    setBusy(true); setErr('');
    try { localStorage.setItem('qr-name', name); localStorage.setItem('qr-phone', phone); } catch { /* private mode */ }
    const res = await fetch(`/api/q/${code}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: request, method, name, phone }) });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; token?: string; pay_url?: string; pay_error?: string; error?: string; detail?: string };
    if (!j.ok || !j.token) { setErr((w.errors[j.error || ''] || w.errors.default) + (j.detail && w.errors[j.error || ''] ? j.detail : '')); setBusy(false); return; }
    try { localStorage.removeItem('qr-cart-' + code); } catch { /* private mode */ }
    if (j.pay_url) { window.location.href = j.pay_url; return; }
    window.location.href = `/q/t/${j.token}${j.pay_error ? '?pay=failed' : ''}`;
  };
  const qtyStep = (l: Line, d: 1 | -1) => setLines(ls => ls.map(x => {
    if (x.key !== l.key) return x;
    const i = items.get(x.code); const step = i?.unit === 'kg' ? Number(i.qty_step || 0.25) : 1;
    return { ...x, quantity: Math.max(step, Math.round((x.quantity + d * step) * 100) / 100) };
  }));

  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <h3 className="text-lg font-bold">{w.cart}</h3>
        <button onClick={onClose} className="p-1"><X className="size-5" /></button>
      </div>
      <div className="space-y-3 px-5 pt-3">
        {lines.length === 0 && <p className="py-6 text-center text-muted">{w.empty}</p>}
        {lines.map(l => {
          const i = items.get(l.code); if (!i) return null;
          const names = l.choices.flatMap(c => c.selected);
          return (
            <div key={l.key} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{(lang === 'en' && i.name_en) || i.name}</p>
                {(names.length > 0 || l.notes) && <p className="truncate text-xs text-muted">{[names.join('، '), l.notes].filter(Boolean).join(' · ')}</p>}
                <p className="text-sm font-semibold">{fmt(linePrice(l))}{sym}</p>
              </div>
              <div className="flex items-center gap-1 rounded-full border border-hairline p-0.5">
                <button onClick={() => qtyStep(l, -1)} className="p-1.5"><Minus className="size-3.5" /></button>
                <span className="min-w-10 text-center text-xs font-semibold">{i.unit === 'kg' ? kgText(l.quantity, lang) : l.quantity}</span>
                <button onClick={() => qtyStep(l, 1)} className="p-1.5"><Plus className="size-3.5" /></button>
              </div>
              <button onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} className="p-1.5 text-muted"><Trash2 className="size-4" /></button>
            </div>
          );
        })}
        {lines.length > 0 && (
          <>
            <div className="grid gap-2 border-t border-hairline pt-3 sm:grid-cols-2">
              <input value={name} onChange={e => setName(e.target.value)} placeholder={w.name} dir="auto" className="h-11 rounded-xl border border-hairline px-3 text-sm" />
              <div>
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder={w.phone} inputMode="tel" dir="ltr" className="h-11 w-full rounded-xl border border-hairline px-3 text-sm" />
                <p className="mt-0.5 px-1 text-[11px] text-muted">{w.phoneHint}</p>
              </div>
            </div>
            {quote && (quote.discount_total > 0 || quote.vat != null || quote.gifts.length > 0) && (
              <dl className="space-y-1 rounded-xl bg-paper px-3 py-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted">{w.subtotal}</dt><dd>{fmt(quote.subtotal)}{sym}</dd></div>
                {quote.offers.filter(o => o.amount > 0).map(o => (
                  <div key={o.id} className="flex justify-between text-positive"><dt>{o.title}</dt><dd>−{fmt(o.amount)}{sym}</dd></div>
                ))}
                {quote.gifts.map(g => (
                  <div key={g.name} className="flex justify-between text-positive"><dt>🎁 {g.name}</dt><dd>{w.gift}</dd></div>
                ))}
                {quote.vat != null && <div className="flex justify-between"><dt className="text-muted">{w.vatLine} {data.branch.vat_percent}%</dt><dd>{fmt(quote.vat)}{sym}</dd></div>}
                <div className="flex justify-between border-t border-hairline pt-1 font-bold"><dt>{w.total}</dt><dd>{fmt(quote.total)}{sym}</dd></div>
              </dl>
            )}
            <p className="text-sm font-semibold">{w.pay}</p>
            <div className="grid grid-cols-2 gap-2">
              {data.pay.card && (
                <button onClick={() => setMethod('card')} className="flex h-14 items-center justify-center gap-2 rounded-xl border text-sm font-semibold"
                        style={method === 'card' ? { borderColor: color, background: color + '12' } : { borderColor: '#DFE5E8' }}>
                  <CreditCard className="size-5" /> {w.card}</button>
              )}
              {data.pay.cash && (
                <button onClick={() => setMethod('cash')} className="flex h-14 items-center justify-center gap-2 rounded-xl border text-sm font-semibold"
                        style={method === 'cash' ? { borderColor: color, background: color + '12' } : { borderColor: '#DFE5E8' }}>
                  <Banknote className="size-5" /> {w.cash}</button>
              )}
            </div>
            {err && <p className="rounded-xl bg-critical-wash px-3 py-2 text-sm text-critical">{err}</p>}
            <button onClick={place} disabled={!method || busy || blocked}
              className="flex h-14 w-full items-center justify-between rounded-2xl px-5 text-lg font-bold text-white disabled:opacity-40" style={{ background: color }}>
              <span>{busy ? w.sending : w.place}</span><span>{fmt(charge)}{sym}</span>
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
