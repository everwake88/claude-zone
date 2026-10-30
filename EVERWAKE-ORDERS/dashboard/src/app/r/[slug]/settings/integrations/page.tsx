'use client';
import { Copy, Eye, EyeOff, KeyRound, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, Field, Input, Modal, Spinner, Switch, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { ApiKey, IntegrationEndpoint } from '@/lib/types';

const EVENTS: [string, string][] = [
  ['order.created', 'A new order'], ['order.updated', 'An order moves (status or payment)'], ['item.availability', 'A dish sold out or back']
];
interface Delivery { id: number; endpoint_id: string; event: string; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null }

// The restaurant keeps its own POS, ERP or CRM: every order made here is sent
// there as it happens (signed, retried), and that system can tell us back
// what sold out and where an order is. Nobody types an order twice.
export default function Integrations() {
  const { tenant, can } = useTenant();
  const t = useT();
  const toast = useToast();
  const { busy, run } = useAction();
  const [endpoints, setEndpoints] = useState<IntegrationEndpoint[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(process.env.NEXT_PUBLIC_SITE_URL || window.location.origin), []);

  const load = useCallback(async () => {
    const [e, d, k] = await Promise.all([
      sb().from('integration_endpoints').select('*').eq('tenant_id', tenant.id).order('created_at'),
      sb().from('integration_events').select('id, endpoint_id, event, status, attempts, last_error, created_at, sent_at')
        .eq('tenant_id', tenant.id).order('id', { ascending: false }).limit(15),
      sb().from('api_keys').select('id, label, key_hint, created_at, last_used_at, revoked_at').eq('tenant_id', tenant.id).order('created_at')
    ]);
    setEndpoints((e.data || []) as IntegrationEndpoint[]);
    setDeliveries((d.data || []) as Delivery[]);
    setKeys((k.data || []) as ApiKey[]);
  }, [tenant.id]);
  useEffect(() => { if (can.edit) load(); }, [load, can.edit]);

  if (!can.edit) return <Card><p className="text-sm text-muted">{t('Only owners and managers can connect other systems.')}</p></Card>;
  if (!endpoints) return <Spinner />;

  const addEndpoint = () => run(async () => {
    if (!/^https:\/\/\S+$/.test(url.trim())) throw new Error(t('The address must start with https://'));
    const { error } = await sb().from('integration_endpoints').insert({ tenant_id: tenant.id, url: url.trim(), label: label.trim() || null });
    if (error) throw new Error(error.message);
    setUrl(''); setLabel('');
    await load();
  }, t('Saved — new orders go there from now on'));
  const patch = (e: IntegrationEndpoint, p: Partial<IntegrationEndpoint>) => run(async () => {
    const { error } = await sb().from('integration_endpoints').update(p).eq('id', e.id);
    if (error) throw new Error(error.message);
    setEndpoints(endpoints.map(x => x.id === e.id ? { ...x, ...p } : x));
  });
  const removeEndpoint = (e: IntegrationEndpoint) => {
    if (!confirm(t('Stop sending to this address?'))) return;
    run(async () => {
      const { error } = await sb().from('integration_endpoints').delete().eq('id', e.id);
      if (error) throw new Error(error.message);
      await load();
    });
  };
  const test = (e: IntegrationEndpoint) => run(async () => {
    const { error } = await sb().rpc('integration_test', { p_endpoint: e.id });
    if (error) throw new Error(error.message);
    await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
    setTimeout(load, 8000);
  }, t('Test sent — its result shows below in a few seconds'));

  const makeKey = () => run(async () => {
    const { data, error } = await sb().rpc('api_key_create', { p_tenant: tenant.id, p_label: keyLabel.trim() || null });
    if (error) throw new Error(error.message);
    setNewKey((data as { key: string }).key);
    setKeyLabel('');
    await load();
  });
  const revoke = (k: ApiKey) => {
    if (!confirm(t('Revoke this key? Whatever uses it stops working at once.'))) return;
    run(async () => {
      const { error } = await sb().from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', k.id);
      if (error) throw new Error(error.message);
      await load();
    });
  };
  // a browser that refuses the clipboard: the text stays on screen to select by hand
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast(t('Copied')), () => null);
  const api = `${origin}/api/v1`;
  const tone = (s: string) => s === 'sent' ? 'positive' : s === 'failed' ? 'critical' : 'caution';

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Webhook className="size-4 text-gold-ink" /> {t('Send orders to your system')}</span>}>
        <p className="mb-4 text-sm text-muted">{t('Every order from WhatsApp and from the QR codes is sent to the address you add, the moment it is placed and each time it moves. If your system is down, it is sent again (1, 2, 4… minutes), up to 7 tries.')}</p>
        <div className="space-y-3">
          {endpoints.map(e => (
            <div key={e.id} className="rounded-xl border border-hairline p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.label || t('Your system')}</span>
                <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{e.url}</bdi>
                {e.last_ok_at && <Badge tone="positive">{t('Reached {ago}', { ago: timeAgo(e.last_ok_at) })}</Badge>}
                <Switch checked={e.is_active} disabled={busy} onChange={v => patch(e, { is_active: v })} label={t('On')} />
                <Button size="sm" variant="outline" disabled={busy || !e.is_active} onClick={() => test(e)}><Send className="size-3.5" /> {t('Send a test')}</Button>
                <button onClick={() => removeEndpoint(e)} disabled={busy} className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-critical" aria-label={t('Delete')}><Trash2 className="size-4" /></button>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                {EVENTS.map(([k, l]) => (
                  <Checkbox key={k} checked={e.events.includes(k)} label={t(l)}
                    onChange={v => patch(e, { events: v ? [...e.events.filter(x => x !== k), k] : e.events.filter(x => x !== k) })} />
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className="text-muted">{t('Signing secret')}:</span>
                <bdi dir="ltr" className="font-mono">{shown[e.id] ? e.secret : '•'.repeat(16) + e.secret.slice(-4)}</bdi>
                <button onClick={() => setShown({ ...shown, [e.id]: !shown[e.id] })} className="rounded p-1 text-muted hover:text-ink" aria-label={t('Show')}>
                  {shown[e.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</button>
                <button onClick={() => copy(e.secret)} className="rounded p-1 text-muted hover:text-ink" aria-label={t('Copy')}><Copy className="size-3.5" /></button>
              </div>
              {e.last_error && <p className="mt-2 rounded-lg bg-paper p-2 text-xs text-critical" dir="ltr">{e.last_error}</p>}
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-end">
            <Field label={t('Name')}><Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Odoo" /></Field>
            <Field label={t('Your system’s address (webhook URL)')}><Input dir="ltr" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://pos.example.com/everwake" /></Field>
            <Button variant="gold" disabled={busy || !url.trim()} onClick={addEndpoint}><Plus className="size-4" /> {t('Add')}</Button>
          </div>
        </div>
        {deliveries.length > 0 && (
          <div className="mt-5">
            <p className="mb-2 text-sm font-medium">{t('Last deliveries')}</p>
            <ul className="divide-y divide-hairline rounded-xl border border-hairline text-sm">
              {deliveries.map(d => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <bdi dir="ltr" className="font-mono text-xs">{d.event}</bdi>
                  <Badge tone={tone(d.status)}>{t(d.status)}</Badge>
                  {d.attempts > 1 && <span className="text-xs text-muted">{t('{n} tries', { n: d.attempts })}</span>}
                  {d.last_error && <bdi dir="ltr" className="min-w-0 flex-1 truncate text-xs text-critical">{d.last_error}</bdi>}
                  <span className="ms-auto text-xs text-muted">{timeAgo(d.sent_at || d.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-gold-ink" /> {t('Let your system update us')}</span>}>
        <p className="mb-4 text-sm text-muted">{t('Your system calls us with a key: a dish sold out at the POS stops being offered on WhatsApp and the QR menu, and an order marked ready there tells the customer here.')}</p>
        {keys.length > 0 && (
          <ul className="mb-3 divide-y divide-hairline rounded-xl border border-hairline text-sm">
            {keys.map(k => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium">{k.label || t('Key')}</span>
                <bdi dir="ltr" className="font-mono text-xs text-muted">ew_…{k.key_hint}</bdi>
                {k.revoked_at ? <Badge tone="critical">{t('Revoked')}</Badge>
                  : <span className="text-xs text-muted">{k.last_used_at ? t('Used {ago}', { ago: timeAgo(k.last_used_at) }) : t('Not used yet')}</span>}
                {!k.revoked_at && <Button size="sm" variant="ghost" className="ms-auto" disabled={busy} onClick={() => revoke(k)}>{t('Revoke')}</Button>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Field label={t('Name')} className="flex-1"><Input value={keyLabel} onChange={e => setKeyLabel(e.target.value)} placeholder="Odoo POS" /></Field>
          <Button variant="outline" disabled={busy} onClick={makeKey}><Plus className="size-4" /> {t('Make a key')}</Button>
        </div>
      </Card>

      <Card title={t('For your developer')}>
        <div className="space-y-4 text-sm" dir="ltr">
          <div>
            <p className="mb-1 font-medium">Webhooks (POST, JSON)</p>
            <pre className="overflow-x-auto rounded-lg bg-paper p-3 text-xs leading-relaxed">{`X-Everwake-Event: order.created | order.updated | item.availability | test
X-Everwake-Delivery: <id — the same on every retry>
X-Everwake-Signature: sha256=<HMAC-SHA256 of the raw body with the signing secret>

{ "id": 812, "event": "order.created", "restaurant": "${tenant.slug}", "created_at": "…",
  "data": { "order_no": "…", "status": "placed", "source": "whatsapp | qr", "branch": { "code": "…" },
            "customer": {…}, "delivery_method": "…", "table": null, "items": [ { "code", "name", "quantity", "unit_price", "choices" } ],
            "subtotal", "discount_total", "vat", "delivery_fee", "total", "payment_method", "payment_status" } }

// Node.js: check the signature before trusting the body
const ok = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex') === req.headers['x-everwake-signature'];
// answer 2xx within 15 seconds; anything else is retried`}</pre>
          </div>
          <div>
            <p className="mb-1 font-medium">API (Authorization: Bearer ew_…)</p>
            <pre className="overflow-x-auto rounded-lg bg-paper p-3 text-xs leading-relaxed">{`POST ${api}/stock                     {"item_code":"KOFTA","available":false,"branch_code":"zamalek","until":"2026-10-31T05:00:00+02:00"}
                                        or {"items":[ … up to 200 ]}
POST ${api}/orders/<order_no>/status  {"status":"ready","note":"…"}   accepted | preparing | ready | out_for_delivery | delivered | picked_up | rejected | cancelled
GET  ${api}/orders?since=<until>      what changed since your last ask (for a system that cannot receive webhooks)
GET  ${api}/menu?branch=<code>        item codes, names, prices and stock — map them to your own items once`}</pre>
          </div>
          <div dir="auto">
            <p className="mb-1 font-medium">{t('Odoo, Foodics and others')}</p>
            <ul className="list-disc space-y-1 ps-5 text-muted">
              <li>{t('Odoo: an automation rule can call the stock and status addresses above when a product or a POS order changes; to receive orders, a small module or n8n / Make takes the webhook and creates the POS order.')}</li>
              <li>{t('Foodics, Loyverse and other cloud POS: n8n, Make or Zapier joins the two — the webhook in, their API out — without code on either side.')}</li>
              <li>{t('A POS on a computer in the shop that cannot receive anything from the internet: it asks every minute with “orders since”.')}</li>
            </ul>
          </div>
        </div>
      </Card>

      <Modal open={!!newKey} onClose={() => setNewKey(null)} title={t('Your new key')}
        footer={<Button variant="gold" onClick={() => { if (newKey) navigator.clipboard.writeText(newKey).then(() => { toast(t('Copied')); setNewKey(null); }, () => null); }}><Copy className="size-4" /> {t('Copy and close')}</Button>}>
        <p className="mb-3 text-sm text-muted">{t('Copy it now and keep it somewhere safe: it is shown only once. Anyone with it can change your stock and orders.')}</p>
        <bdi dir="ltr" className="block break-all rounded-lg bg-paper p-3 font-mono text-xs">{newKey}</bdi>
      </Modal>
    </div>
  );
}
