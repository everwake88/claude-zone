import 'server-only';

// Tells n8n to send what was just queued right now instead of on its next
// minute. The message is already safe in the outbox; this only makes it faster.
export async function pingOutbox(): Promise<{ ok: boolean; reason?: string }> {
  const base = process.env.N8N_BASE_URL;
  if (!base) return { ok: false, reason: 'N8N_BASE_URL is not set — the outbox sends within a minute' };
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/webhook/everwake-outbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-everwake-secret': process.env.N8N_OUTBOX_SECRET || '' },
      body: JSON.stringify({ at: new Date().toISOString() }),
      signal: AbortSignal.timeout(4000)
    });
    return { ok: res.ok };
  } catch {
    return { ok: false, reason: 'n8n did not answer — the outbox sends within a minute' };
  }
}
