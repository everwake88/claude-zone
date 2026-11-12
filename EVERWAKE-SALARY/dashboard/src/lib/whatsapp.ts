import 'server-only';
import { one } from './db';

// HR's reply to an employee, sent on the company WhatsApp. Evolution API today; the
// WhatsApp Cloud API branch is the one place to add when the line moves there.
export async function sendWhatsApp(to: string, text: string): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const ch = await one<{ provider: string; base_url: string; instance: string; api_key: string; phone_number_id: string }>(
    'select provider, base_url, instance, api_key, phone_number_id from salary.channel');
  if (!ch || !ch.base_url || !ch.instance) return { ok: false, error: 'WhatsApp is not connected (Settings → WhatsApp)' };
  if (ch.provider !== 'evolution') return { ok: false, error: 'WhatsApp Cloud API sending is not set up yet' };
  try {
    const res = await fetch(`${ch.base_url.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(ch.instance)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: ch.api_key },
      body: JSON.stringify({ number: to, text, linkPreview: false }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, id: (body as { key?: { id?: string } })?.key?.id ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'no answer' };
  }
}
