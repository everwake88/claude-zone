import { CheckCircle2, Clock, CreditCard, MessageCircle, XCircle } from 'lucide-react';

export interface PublicPayment {
  tenant_id: string; ref: string; status: string; link_url: string | null; expired: boolean; amount: number; amount_text: string;
  order_no: string; order_paid: boolean; restaurant: string; restaurant_en: string | null; logo_url: string | null; color: string | null;
  whatsapp: string | null; language: string;
}
export type PayState = 'paid' | 'failed' | 'expired' | 'closed' | 'checking';

// The customer's side, in the customer's language (not the dashboard's):
// what happened to the payment, and the way back to the chat.
const WORDS = {
  ar: {
    paid: ['تم الدفع ✅', 'استلمنا الدفع، وهيوصلك تأكيد على الواتساب.'],
    failed: ['الدفع مكملش', 'محصلش خصم. تقدر تجرّب تاني بنفس اللينك، أو ترجع للمحادثة وتختار كاش.'],
    expired: ['اللينك ده خلص', 'ارجع للمحادثة وإحنا نبعتلك لينك جديد، أو ادفع كاش عند الاستلام.'],
    closed: ['اللينك ده مبقاش شغال', 'ارجع للمحادثة وإحنا نساعدك.'],
    checking: ['بنتأكد من الدفع…', 'لو اتخصم منك، هيوصلك تأكيد على الواتساب خلال دقايق.'],
    order: 'طلب', back: 'ارجع للواتساب', retry: 'جرّب تاني'
  },
  en: {
    paid: ['Payment received ✅', 'We have your payment; the confirmation is on its way to WhatsApp.'],
    failed: ['The payment did not go through', 'Nothing was charged. Try again with the same link, or go back to the chat and choose cash.'],
    expired: ['This link has expired', 'Go back to the chat and we will send a new one, or pay in cash on delivery.'],
    closed: ['This link is no longer active', 'Go back to the chat and we will help.'],
    checking: ['Checking your payment…', 'If you were charged, the confirmation reaches you on WhatsApp within minutes.'],
    order: 'Order', back: 'Back to WhatsApp', retry: 'Try again'
  }
};

export function PayResult({ p, state }: { p: PublicPayment; state: PayState }) {
  const lang = p.language === 'en' ? 'en' : 'ar';
  const w = WORDS[lang];
  const [title, line] = w[state];
  const Icon = state === 'paid' ? CheckCircle2 : state === 'failed' ? XCircle : state === 'checking' ? Clock : CreditCard;
  const tone = state === 'paid' ? 'text-positive' : state === 'failed' ? 'text-critical' : 'text-muted';
  const canRetry = state === 'failed' && p.status === 'pending' && !p.expired;
  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} className="flex min-h-screen items-center justify-center bg-paper p-6">
      <div className="w-full max-w-sm space-y-5 rounded-2xl bg-white p-6 text-center shadow-sm">
        <div className="flex flex-col items-center gap-2">
          {p.logo_url
            ? <img src={p.logo_url} alt="" className="size-16 rounded-full border border-hairline bg-white object-contain p-1" />
            : <span className="flex size-14 items-center justify-center rounded-full text-xl font-bold text-white" style={{ background: p.color || '#0B222E' }}>
                {(lang === 'en' && p.restaurant_en ? p.restaurant_en : p.restaurant).slice(0, 1)}</span>}
          <p className="text-sm font-semibold">{lang === 'en' && p.restaurant_en ? p.restaurant_en : p.restaurant}</p>
        </div>
        <Icon className={`mx-auto size-12 ${tone}`} />
        <div className="space-y-1.5">
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="text-sm text-muted">{line}</p>
        </div>
        <p className="rounded-xl bg-paper px-3 py-2 text-sm"><span className="text-muted">{w.order} <bdi dir="ltr">{p.order_no}</bdi> · </span><b><bdi>{p.amount_text}</bdi></b></p>
        <div className="space-y-2">
          {canRetry && <a href={`/p/${p.ref}`} className="flex h-12 w-full items-center justify-center rounded-lg bg-gold text-base font-semibold text-navy">{w.retry}</a>}
          {p.whatsapp && (
            <a href={`https://wa.me/${p.whatsapp}`} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] text-base font-semibold text-white">
              <MessageCircle className="size-5" /> {w.back}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
