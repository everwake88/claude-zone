import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { checkoutUrl, describeError, intentionBody, PAYMOB_API, signedText, type Prepared } from './paymob-core';

export * from './paymob-core';

// one payment link: an intention at Paymob, and the checkout page for it
export async function createIntention(p: Prepared): Promise<{ id: string; orderId: number | null; url: string }> {
  let res: Response;
  try {
    res = await fetch(`${PAYMOB_API}/v1/intention/`, {
      method: 'POST',
      headers: { Authorization: `Token ${p.secret_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(intentionBody(p)),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(`Paymob did not answer (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = await res.json().catch(() => null) as { id?: string; client_secret?: string; intention_order_id?: number } | null;
  if (!res.ok || !body?.client_secret) throw new Error(describeError(res.status, body));
  return { id: String(body.id || ''), orderId: body.intention_order_id ?? null, url: checkoutUrl(p.public_key, body.client_secret) };
}

// is this notice really from Paymob? (HMAC-SHA512 of the signed text with the restaurant's HMAC secret)
export function signatureOk(read: (key: string) => unknown, received: string | null, secret: string | null): boolean {
  if (!received || !secret) return false;
  const want = Buffer.from(received.toLowerCase(), 'utf8');
  return (['', 'null'] as const).some(empty => {
    const got = Buffer.from(createHmac('sha512', secret).update(signedText(read, empty)).digest('hex'), 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
