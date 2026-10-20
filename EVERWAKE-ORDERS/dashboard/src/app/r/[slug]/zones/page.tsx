'use client';
import { Crosshair, Plus, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, Field, Input, PageHeader, Select, Spinner, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import type { Shape } from '@/components/zones/ZoneMap';
import { money } from '@/lib/format';
import { sb } from '@/lib/supabase/client';
import type { Branch, Zone } from '@/lib/types';

const ZoneMap = dynamic(() => import('@/components/zones/ZoneMap'), { ssr: false, loading: () => <Spinner label="Loading the map…" /> });
const PALETTE = ['#B8913F', '#2E7D5B', '#3B6FA0', '#A33B32', '#7A4FA0', '#9A6B1E', '#16384A'];

interface Hit { zone_name: string; branch_name: string; delivery_fee: number | null; min_order: number | null; branch_state: string }

export default function ZonesPage() {
  const { tenant, can } = useTenant();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Zone> & { areasText?: string } | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [testing, setTesting] = useState(false);
  const [testPoint, setTestPoint] = useState<[number, number] | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const [b, z] = await Promise.all([
      sb().from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort'),
      sb().from('delivery_zones').select('*').eq('tenant_id', tenant.id).order('priority')
    ]);
    setBranches((b.data || []) as Branch[]);
    setZones((z.data || []) as Zone[]);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const pick = (id: string | null) => {
    setSelected(id); setDraft(null);
    const z = zones?.find(x => x.id === id);
    setForm(z ? { ...z, areasText: z.areas.join('، ') } : null);
  };
  const drawn = (s: Shape) => {
    setSelected(null); setDraft(s);
    setForm({ branch_id: branches[0]?.id, name_ar: '', priority: 100, is_active: true, areasText: '', ...s });
  };
  const edited = (id: string, s: Shape) => setForm(f => f && f.id === id ? { ...f, ...s } : f);

  const save = () => run(async () => {
    if (!form?.name_ar?.trim()) throw new Error('Give the zone a name');
    if (!form.branch_id) throw new Error('Choose the branch that delivers here');
    const row = {
      tenant_id: tenant.id, branch_id: form.branch_id, name_ar: form.name_ar.trim(), name_en: form.name_en || null,
      kind: form.kind, polygon: form.kind === 'polygon' ? form.polygon : null,
      center_lat: form.kind === 'radius' ? form.center_lat : null, center_lng: form.kind === 'radius' ? form.center_lng : null,
      radius_km: form.kind === 'radius' ? form.radius_km : null,
      areas: (form.areasText || '').split(/[,،\n]/).map(s => s.trim()).filter(Boolean),
      delivery_fee: form.delivery_fee ?? null, min_order: form.min_order ?? null, eta_min: form.eta_min ?? null, eta_max: form.eta_max ?? null,
      priority: form.priority ?? 100, is_active: form.is_active !== false
    };
    const { data, error } = form.id ? await sb().from('delivery_zones').update(row).eq('id', form.id).select('id').single()
                                    : await sb().from('delivery_zones').insert(row).select('id').single();
    if (error) throw new Error(error.message);
    setDraft(null);
    await load();
    setSelected((data as { id: string }).id);
  }, 'Zone saved — the agent uses it from the next message');

  const remove = () => run(async () => {
    if (!form?.id) { setForm(null); setDraft(null); return; }
    const { error } = await sb().from('delivery_zones').delete().eq('id', form.id);
    if (error) throw new Error(error.message);
    setForm(null); setSelected(null); await load();
  }, 'Zone deleted');

  const test = async (lat: number, lng: number) => {
    setTestPoint([lat, lng]);
    const { data } = await sb().rpc('zones_at', { p_tenant: tenant.id, p_lat: lat, p_lng: lng });
    setHits((data || []) as Hit[]);
  };

  if (!zones) return <Spinner />;
  const num = (v: string) => v === '' ? null : Number(v);

  return (
    <div>
      <PageHeader title="Delivery zones" subtitle="Draw where each branch delivers. A customer's location pin (or the area they type) picks the zone, its fee and minimum, and the branch."
        actions={<Button variant={testing ? 'primary' : 'outline'} onClick={() => { setTesting(t => !t); setHits(null); setTestPoint(null); }}>
          <Crosshair className="size-4" /> {testing ? 'Stop testing' : 'Test an address'}</Button>} />
      {branches.some(b => b.lat == null) && <p className="mb-3 rounded-lg bg-caution-wash px-3 py-2 text-sm text-caution">Some branches have no map pin yet — add their Google Maps link in Branches so distances are right.</p>}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="h-[70vh] min-h-[420px] rounded-xl border border-hairline bg-white p-1">
          <ZoneMap branches={branches} zones={zones} selected={selected} draft={draft} testPoint={testPoint} editable={can.edit && !testing}
            testing={testing} onSelect={pick} onDraw={drawn} onEdit={edited} onTest={test} />
        </div>

        <div className="space-y-3">
          {testing && (
            <Card title="Test an address">
              {!testPoint ? <p className="text-sm text-muted">Click anywhere on the map.</p> : hits && hits.length === 0
                ? <p className="text-sm text-critical">Outside every zone — the agent offers pickup here.</p>
                : <ul className="space-y-1 text-sm">{(hits || []).map((h, i) => (
                    <li key={i} className={i === 0 ? 'font-semibold' : 'text-muted'} dir="auto">
                      {h.zone_name} → {h.branch_name} · {h.delivery_fee == null ? 'fee by branch' : money(h.delivery_fee, tenant.currency_symbol)}{h.min_order ? ` · min ${money(h.min_order, tenant.currency_symbol)}` : ''} · {h.branch_state}
                      {i === 0 && ' ← the agent uses this'}</li>))}</ul>}
            </Card>
          )}

          {form ? (
            <Card title={form.id ? 'Edit zone' : 'New zone'}>
              <div className="space-y-3">
                <Field label="Name (Arabic)"><Input dir="rtl" value={form.name_ar || ''} onChange={e => setForm({ ...form, name_ar: e.target.value })} /></Field>
                <Field label="Branch that delivers here">
                  <Select value={form.branch_id || ''} onChange={e => setForm({ ...form, branch_id: e.target.value })}>
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar}</option>)}
                  </Select>
                </Field>
                <Field label="Area names in this zone" hint="Comma separated — matched when a customer types their area instead of sharing a pin.">
                  <Input dir="rtl" value={form.areasText || ''} onChange={e => setForm({ ...form, areasText: e.target.value })} placeholder="المعادي، دجلة، maadi" />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={`Delivery fee (${tenant.currency})`}><Input type="number" value={form.delivery_fee ?? ''} onChange={e => setForm({ ...form, delivery_fee: num(e.target.value) })} /></Field>
                  <Field label="Minimum order"><Input type="number" value={form.min_order ?? ''} onChange={e => setForm({ ...form, min_order: num(e.target.value) })} /></Field>
                  <Field label="Delivery from (min)"><Input type="number" value={form.eta_min ?? ''} onChange={e => setForm({ ...form, eta_min: num(e.target.value) })} /></Field>
                  <Field label="to (min)"><Input type="number" value={form.eta_max ?? ''} onChange={e => setForm({ ...form, eta_max: num(e.target.value) })} /></Field>
                </div>
                <Field label="Priority" hint="Where zones overlap, the lower number wins (if that branch is open)."><Input type="number" value={form.priority ?? 100} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} /></Field>
                <p className="text-xs text-muted">{form.kind === 'radius' ? `Circle of ${form.radius_km} km` : `Shape with ${form.polygon?.length || 0} corners`} — drag the corners on the map to adjust.</p>
                <Checkbox checked={form.is_active === false} onChange={v => setForm({ ...form, is_active: !v })} label="Paused (not delivering here for now)" />
                {can.edit && <div className="flex justify-between pt-2">
                  <Button variant="ghost" className="text-critical" onClick={remove}><Trash2 className="size-4" /> {form.id ? 'Delete' : 'Discard'}</Button>
                  <Button variant="gold" busy={busy} onClick={save}>Save zone</Button>
                </div>}
              </div>
            </Card>
          ) : (
            <Card title="Zones">
              {can.edit && <p className="mb-3 flex items-center gap-1.5 text-sm text-muted"><Plus className="size-4" /> Use the polygon, rectangle or circle tool at the top left of the map to draw a new zone.</p>}
              {zones.length === 0 ? <p className="text-sm text-muted">No zones yet. Until you draw some, each branch delivers within its &quot;delivers up to&quot; distance.</p> : (
                <ul className="space-y-1">
                  {branches.map((b, bi) => (
                    <li key={b.id}>
                      <p className="mt-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        <span className="size-2.5 rounded-full" style={{ background: PALETTE[bi % PALETTE.length] }} />{b.name_en || b.name_ar}</p>
                      {zones.filter(z => z.branch_id === b.id).map(z => (
                        <button key={z.id} onClick={() => pick(z.id)} className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm hover:bg-paper">
                          <span dir="auto">{z.name_ar}</span>
                          <span className="flex items-center gap-1.5 text-muted">{z.delivery_fee != null && money(z.delivery_fee, tenant.currency_symbol)}{!z.is_active && <Badge>paused</Badge>}</span>
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
