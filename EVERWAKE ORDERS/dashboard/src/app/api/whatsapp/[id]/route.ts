import { NextResponse, type NextRequest } from 'next/server';
import { adminClient, serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface Channel { id: string; tenant_id: string; base_url: string | null; instance_name: string | null; api_key: string | null }

// Talks to the restaurant's Evolution instance for the WhatsApp settings
// page. The API key is read with the service role, only after the
// caller's own client proved they are an owner or manager there.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action, number } = await req.json().catch(() => ({})) as { action?: string; number?: string };
  const db = await serverClient();
  const { data: visible } = await db.from('whatsapp_channels').select('id, tenant_id').eq('id', id).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'Number not found' }, { status: 404 });
  const { data: role } = await db.rpc('member_role', { p_tenant: (visible as { tenant_id: string }).tenant_id });
  if (role !== 'owner' && role !== 'manager') return NextResponse.json({ error: 'Only owners and managers' }, { status: 403 });

  const admin = adminClient();
  const { data } = await admin.from('whatsapp_channels').select('id, tenant_id, base_url, instance_name, api_key, webhook_token').eq('id', id).single();
  const ch = data as Channel & { webhook_token: string };
  const n8n = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
  const webhookUrl = n8n ? `${n8n}/webhook/everwake-evo?token=${ch.webhook_token}` : null;
  if (action === 'info') return NextResponse.json({ webhook_url: webhookUrl, n8n_configured: !!n8n });
  if (!ch.base_url || !ch.instance_name || !ch.api_key) return NextResponse.json({ error: 'Fill in the server address, the instance name and the API key first' }, { status: 400 });

  const evo = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${ch.base_url!.replace(/\/+$/, '')}${path}`, {
      method, headers: { apikey: ch.api_key!, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.response?.message?.toString?.() || json?.message || `Evolution answered ${res.status}`);
    return json;
  };
  const instance = encodeURIComponent(ch.instance_name);

  try {
    if (action === 'status') {
      const r = await evo('GET', `/instance/connectionState/${instance}`);
      const state = r?.instance?.state || r?.state || 'unknown';
      await admin.from('whatsapp_channels').update({ status: state === 'open' ? 'connected' : 'disconnected',
        ...(state === 'open' ? { connected_at: new Date().toISOString() } : {}) }).eq('id', id);
      return NextResponse.json({ state });
    }
    if (action === 'connect') {
      const r = await evo('GET', `/instance/connect/${instance}`);
      return NextResponse.json({ qr: r?.base64 || null, pairing_code: r?.pairingCode || null, state: r?.instance?.state || null });
    }
    if (action === 'set-webhook') {
      if (!webhookUrl) throw new Error('N8N_BASE_URL is not set on the dashboard server');
      await evo('POST', `/webhook/set/${instance}`, {
        webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'SEND_MESSAGE'] }
      });
      return NextResponse.json({ ok: true, webhook_url: webhookUrl });
    }
    if (action === 'test') {
      const to = String(number || '').replace(/\D/g, '');
      if (to.length < 10) throw new Error('Type the number in international format, e.g. 2010…');
      const r = await evo('POST', `/message/sendText/${instance}`, { number: to, text: 'رسالة تجربة من Everwake Orders ✅ — the WhatsApp line is connected.' });
      return NextResponse.json({ ok: !!r?.key?.id });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
