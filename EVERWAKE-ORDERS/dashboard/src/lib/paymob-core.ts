// Paymob, the parts with no secrets and no I/O: the checkout address, the
// signature Paymob puts on every payment notice, and what a notice means.
// Following Paymob's developer docs: Create Intention (POST /v1/intention/),
// Unified Checkout (redirection) and "HMAC Transaction Callback".

export const PAYMOB_API = 'https://accept.paymob.com';
export const PAYMOB_CHECKOUT = 'https://eg.checkout.paymob.com';   // Egypt

export const checkoutUrl = (publicKey: string, clientSecret: string) =>
  `${PAYMOB_CHECKOUT}/?publicKey=${encodeURIComponent(publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`;

// the keys Paymob signs, in its order; "id" and "order.id" are read from
// obj.id / obj.order.id in a POST notice and from id / order_id in the redirect
const HMAC_KEYS = ['amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id',
  'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success'] as const;

type Obj = Record<string, unknown>;
const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Obj)[k] : undefined), o);

// the text Paymob signs. A missing value is written two ways by Paymob's own
// examples ("" and "null"), so both are tried.
export function signedText(read: (key: string) => unknown, empty: '' | 'null' = ''): string {
  return HMAC_KEYS.map(k => {
    const v = read(k);
    return v === null || v === undefined ? empty : String(v);
  }).join('');
}
export const postReader = (obj: Obj) => (k: string) => (k === 'order.id' ? at(obj, 'order.id') ?? at(obj, 'order') : at(obj, k));
export const getReader = (q: URLSearchParams) => (k: string) =>
  k === 'order.id' ? (q.get('order_id') ?? q.get('order')) : q.get(k);

// the facts the database records from a notice
export interface PaymentFacts {
  transaction_id: number | null; provider_order_id: number | null; merchant_order_id: string | null;
  success: boolean; pending: boolean; amount_cents: number | null; currency: string | null;
  is_refunded: boolean; is_voided: boolean; method: string | null; card_brand: string | null; card_last4: string | null; error: string | null;
}
const bool = (v: unknown) => v === true || v === 'true';
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

export function factsFromPost(obj: Obj): PaymentFacts {
  const type = text(at(obj, 'source_data.type'));
  const pan = text(at(obj, 'source_data.pan'));
  return {
    transaction_id: num(obj.id), provider_order_id: num(at(obj, 'order.id') ?? obj.order),
    merchant_order_id: text(at(obj, 'order.merchant_order_id')) ?? text(at(obj, 'payment_key_claims.extra.ref')),
    success: bool(obj.success), pending: bool(obj.pending), amount_cents: num(obj.amount_cents), currency: text(obj.currency),
    is_refunded: bool(obj.is_refunded), is_voided: bool(obj.is_voided), method: type, card_brand: text(at(obj, 'source_data.sub_type')),
    card_last4: type === 'card' && pan ? pan.slice(-4) : null,
    error: text(at(obj, 'data.message')) ?? text(at(obj, 'data.merchant_txn_ref'))
  };
}
export function factsFromGet(q: URLSearchParams): PaymentFacts {
  const type = q.get('source_data.type');
  const pan = q.get('source_data.pan');
  return {
    transaction_id: num(q.get('id')), provider_order_id: num(q.get('order_id') ?? q.get('order')),
    merchant_order_id: text(q.get('merchant_order_id')),
    success: bool(q.get('success')), pending: bool(q.get('pending')), amount_cents: num(q.get('amount_cents')), currency: text(q.get('currency')),
    is_refunded: bool(q.get('is_refunded')), is_voided: bool(q.get('is_voided')), method: text(type), card_brand: text(q.get('source_data.sub_type')),
    card_last4: type === 'card' && pan ? pan.slice(-4) : null, error: text(q.get('data.message'))
  };
}

// the intention body for one payment link (what the database prepared)
export interface Prepared {
  ok: boolean; error?: string; reason?: string; fact?: string; test?: boolean;
  payment_id?: number; ref: string; order_no?: string; amount: number; amount_cents: number; currency: string;
  secret_key: string; public_key: string; integration_ids: number[]; expiration: number;
  billing: Record<string, string>; items: { name: string; amount: number; quantity: number; description?: string }[];
  notification_url: string; redirection_url: string | null; short_url: string | null;
}
export function intentionBody(p: Prepared) {
  return {
    amount: p.amount_cents, currency: p.currency, payment_methods: p.integration_ids, items: p.items, billing_data: p.billing,
    special_reference: p.ref, expiration: p.expiration, notification_url: p.notification_url,
    ...(p.redirection_url ? { redirection_url: p.redirection_url } : {}),
    extras: { ref: p.ref, ...(p.order_no ? { order_no: p.order_no } : {}) }
  };
}

// Paymob's error, in one line
export function describeError(status: number, body: unknown): string {
  if (!body || typeof body !== 'object') return `Paymob answered ${status}`;
  const b = body as Obj;
  if (typeof b.detail === 'string') return `Paymob ${status}: ${b.detail}`;
  const flat = (v: unknown, k = ''): string[] => v && typeof v === 'object'
    ? Object.entries(v as Obj).flatMap(([kk, vv]) => flat(vv, k ? `${k}.${kk}` : kk))
    : [`${k}: ${String(v)}`];
  return `Paymob ${status}: ${flat(b).slice(0, 4).join('; ')}`;
}
