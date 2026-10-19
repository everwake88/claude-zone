'use client';
import { Copy, Plug, Plus, QrCode, RefreshCw, Send, Webhook } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { timeAgo } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import type { Branch, Channel } from '@/lib/types';

const COLS = 'id, tenant_id, provider, label, phone_number, instance_name, base_url, default_branch_id, status, is_active, last_inbound_at, connected_at';

export default function WhatsAppSettings() {
  const { tenant, can } = useTenant();
  const toast = useToast();
  const [list, setList] = useState<Channel[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [edit, setEdit] = useState<(Partial<Channel> & { api_key?: string }) | null>(null);
  const [hooks, setHooks] = useState<Record<string, string | null>>({});
  const [qr, setQr] = useState<{ img: string | null; code: string | null } | null>(null);
  const [testFor, setTestFor] = useState<Channel | null>(null);
  const [testNo, setTestNo] = useState('');
  const { busy, run } = useAction();

  const call = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`/api/whatsapp/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Failed');
    return body;
  };

  const load = useCallback(async () => {
    const [c, b] = await Promise.all([
      sb().from('whatsapp_channels').select(COLS).eq('tenant_id', tenant.id).order('created_at'),
      sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort')
    ]);
    const rows = (c.data || []) as Channel[];
    setList(rows); setBranches((b.data || []) as Branch[]);
    if (can.edit) {
      const h: Record<string, string | null> = {};
      await Promise.all(rows.map(async r => { try { h[r.id] = (await call(r.id, 'info')).webhook_url; } catch { h[r.id] = null; } }));
      setHooks(h);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id, can.edit]);
  useEffect(() => { load(); }, [load]);

  const save = () => run(async () => {
    const { error } = await sb().rpc('save_channel', { p_tenant: tenant.id, p: { ...edit, id: edit?.id || null } });
    if (error) throw new Error(error.message);
    setEdit(null); await load();
  }, 'Saved');

  if (!can.edit) return <p className="text-sm text-muted">Only owners and managers can manage the WhatsApp number.</p>;
  if (!list) return <Spinner />;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">The restaurant&apos;s WhatsApp number runs on an Evolution API instance. Connect it once; the same engine answers for every restaurant, so nothing else needs setting up.
        For a paid, ban-proof line, move to the official WhatsApp Cloud API later — the dashboard and the agent stay the same.</p>
      {list.length === 0 && <Empty title="No WhatsApp number yet" action={<Button variant="gold" onClick={() => setEdit({ provider: 'evolution' })}><Plus className="size-4" /> Connect a number</Button>} />}
      {list.map(c => (
        <Card key={c.id} title={<span className="flex items-center gap-2">{c.label || c.phone_number || c.instance_name}
          <Badge tone={c.status === 'connected' ? 'positive' : c.status === 'pending' ? 'caution' : 'critical'}>{c.status}</Badge></span>}
          action={<Button size="sm" variant="ghost" onClick={() => setEdit({ ...c })}>Edit</Button>}>
          <div className="space-y-3 text-sm">
            <p className="text-muted">Instance <span className="font-mono">{c.instance_name}</span> on {c.base_url}{c.last_inbound_at ? ` · last message ${timeAgo(c.last_inbound_at)}` : ' · no messages yet'}</p>
            <div>
              <p className="mb-1 font-medium">Webhook address for Evolution</p>
              {hooks[c.id] ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-lg bg-paper px-3 py-2 text-xs" dir="ltr">{hooks[c.id]}</code>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(hooks[c.id]!); toast('Copied'); }}><Copy className="size-4" /></Button>
                </div>
              ) : <p className="text-xs text-caution">Set N8N_BASE_URL on the dashboard server to see it.</p>}
              <p className="mt-1 text-xs text-muted">Events: MESSAGES_UPSERT and SEND_MESSAGE. The token in the address proves messages really come from your instance — keep it private.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" busy={busy} onClick={() => run(async () => { const r = await call(c.id, 'status'); await load(); return r; }, undefined).then(r => r && toast(`WhatsApp says: ${r.state}`, r.state === 'open' ? 'positive' : 'neutral'))}><RefreshCw className="size-4" /> Check connection</Button>
              <Button size="sm" variant="outline" busy={busy} onClick={() => run(async () => { const r = await call(c.id, 'connect'); setQr({ img: r.qr, code: r.pairing_code }); })}><QrCode className="size-4" /> Connect with a QR code</Button>
              <Button size="sm" variant="outline" busy={busy} onClick={() => run(() => call(c.id, 'set-webhook'), 'Webhook set — messages now reach the agent')}><Webhook className="size-4" /> Set the webhook for me</Button>
              <Button size="sm" variant="outline" onClick={() => setTestFor(c)}><Send className="size-4" /> Send a test</Button>
            </div>
          </div>
        </Card>
      ))}
      {list.length > 0 && <Button variant="outline" onClick={() => setEdit({ provider: 'evolution' })}><Plus className="size-4" /> Another number</Button>}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit the number' : 'Connect a number'}
        footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button variant="gold" busy={busy} onClick={save}><Plug className="size-4" /> Save</Button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Label"><Input value={edit.label || ''} onChange={e => setEdit({ ...edit, label: e.target.value })} placeholder="Main ordering line" /></Field>
            <Field label="The WhatsApp number"><Input dir="ltr" value={edit.phone_number || ''} onChange={e => setEdit({ ...edit, phone_number: e.target.value })} placeholder="2010…" /></Field>
            <Field label="Evolution server address"><Input dir="ltr" value={edit.base_url || ''} onChange={e => setEdit({ ...edit, base_url: e.target.value })} placeholder="https://evo.example.com" /></Field>
            <Field label="Instance name" hint="Unique across all restaurants — it is how the engine knows which restaurant a message is for."><Input dir="ltr" value={edit.instance_name || ''} onChange={e => setEdit({ ...edit, instance_name: e.target.value })} /></Field>
            <Field label="API key" hint={edit.id ? 'Saved and hidden. Type a new one only to replace it.' : 'The instance token from Evolution.'}><Input dir="ltr" type="password" value={edit.api_key || ''} onChange={e => setEdit({ ...edit, api_key: e.target.value })} /></Field>
            {branches.length > 1 && (
              <Field label="Belongs to one branch? (optional)">
                <Select value={edit.default_branch_id || ''} onChange={e => setEdit({ ...edit, default_branch_id: e.target.value || null })}>
                  <option value="">No — the whole restaurant</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar}</option>)}
                </Select>
              </Field>
            )}
          </div>
        )}
      </Modal>

      <Modal open={!!qr} onClose={() => setQr(null)} title="Scan with the restaurant's phone">
        <p className="mb-3 text-sm text-muted">WhatsApp → Settings → Linked devices → Link a device.</p>
        {qr?.img ? <img src={qr.img} alt="QR code" className="mx-auto w-64" /> : <p className="text-sm">Already connected, or no QR available — check the connection.</p>}
        {qr?.code && <p className="mt-3 text-center text-sm">Or enter this code: <strong className="font-mono">{qr.code}</strong></p>}
      </Modal>

      <Modal open={!!testFor} onClose={() => setTestFor(null)} title="Send a test message"
        footer={<Button variant="gold" busy={busy} onClick={() => testFor && run(() => call(testFor.id, 'test', { number: testNo }), 'Sent — check that phone').then(() => setTestFor(null))}>Send</Button>}>
        <Field label="To this number"><Input dir="ltr" value={testNo} onChange={e => setTestNo(e.target.value)} placeholder="2010…" /></Field>
      </Modal>
    </div>
  );
}
