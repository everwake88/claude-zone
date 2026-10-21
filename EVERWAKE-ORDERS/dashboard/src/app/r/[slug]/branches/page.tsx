'use client';
import { Clock, MapPin, Pause, Pencil, Phone, Plus, Store } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { HoursEditor } from '@/components/branches/HoursEditor';
import { Badge, Button, Card, Checkbox, Drawer, Empty, Field, Input, Modal, PageHeader, Spinner, Switch, Textarea, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { clock, money, parseLatLng } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch } from '@/lib/types';

const STATE: Record<string, { label: string; tone: 'positive' | 'neutral' | 'caution' | 'critical' }> = {
  open: { label: 'Open now', tone: 'positive' }, closed: { label: 'Closed now', tone: 'neutral' },
  busy: { label: 'Paused (busy)', tone: 'caution' }, not_accepting: { label: 'Not taking orders', tone: 'critical' },
  unknown: { label: 'No hours set', tone: 'neutral' }
};

export default function BranchesPage() {
  const { tenant, base, can } = useTenant();
  const [list, setList] = useState<Branch[] | null>(null);
  const [states, setStates] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<Partial<Branch> | null>(null);
  const [busyFor, setBusyFor] = useState<Branch | null>(null);
  const { busy, run } = useAction();
  const t = useT();

  const load = useCallback(async () => {
    const { data } = await sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort');
    const rows = (data || []) as Branch[];
    setList(rows);
    const st: Record<string, string> = {};
    await Promise.all(rows.map(async b => { const { data: s } = await sb().rpc('branch_state', { p_branch: b.id }); st[b.id] = s as string; }));
    setStates(st);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const save = () => run(async () => {
    const b = edit!;
    if (!b.name_ar?.trim()) throw new Error(t('The branch needs an Arabic name'));
    const code = (b.code || b.name_en || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    if (code.length < 2) throw new Error(t('Give the branch a short English name or code (e.g. zamalek)'));
    const row = {
      tenant_id: tenant.id, code, name_ar: b.name_ar.trim(), name_en: b.name_en || null,
      aliases: (typeof b.aliases === 'string' ? (b.aliases as string).split(/[,،]/) : b.aliases || []).map(s => s.trim()).filter(Boolean),
      area_ar: b.area_ar || null, address_ar: b.address_ar || null, address_en: b.address_en || null,
      lat: b.lat ?? null, lng: b.lng ?? null, maps_url: b.maps_url || null, phone: b.phone || null,
      ops_whatsapp: (b.ops_whatsapp || '').replace(/\D/g, '') || null, hours: b.hours || {}, hours_text_ar: b.hours_text_ar || null,
      accepting_orders: b.accepting_orders !== false, delivery_enabled: b.delivery_enabled !== false, pickup_enabled: b.pickup_enabled !== false,
      delivery_fee: b.delivery_fee ?? null, min_order: b.min_order ?? null, max_delivery_km: b.max_delivery_km ?? null,
      vat_percent: b.vat_percent ?? null, price_note_ar: b.price_note_ar || null, prep_minutes: b.prep_minutes ?? null,
      delivery_eta_text: b.delivery_eta_text || null, serves_hint_ar: b.serves_hint_ar || null, seasonal: !!b.seasonal,
      is_active: b.is_active !== false, sort: b.sort ?? ((list?.length || 0) + 1) * 10
    };
    const { error } = b.id ? await sb().from('branches').update(row).eq('id', b.id) : await sb().from('branches').insert(row);
    if (error) throw new Error(error.message.includes('branches_tenant_id_code_key') ? t('Another branch already uses that code') : error.message);
    setEdit(null); await load();
  }, t('Branch saved — the agent knows on the next message'));

  const accepting = (b: Branch, v: boolean) => run(async () => {
    const { error } = await sb().rpc('set_branch_accepting', { p_branch: b.id, p_accepting: v });
    if (error) throw new Error(error.message);
    await load();
  }, v ? t('{branch} is taking orders again', { branch: b.name_en || b.name_ar }) : t('{branch} stopped taking orders — the agent offers another branch', { branch: b.name_en || b.name_ar }));
  const pause = (b: Branch, minutes: number) => run(async () => {
    const { error } = await sb().rpc('set_branch_busy', { p_branch: b.id, p_minutes: minutes, p_reason: null });
    if (error) throw new Error(error.message);
    setBusyFor(null); await load();
  }, minutes ? t('Paused for {n} minutes', { n: minutes }) : t('Taking orders again'));

  if (!list) return <Spinner />;
  const set = <K extends keyof Branch>(k: K, v: Branch[K]) => setEdit(e => ({ ...e, [k]: v }));
  const num = (v: string) => v === '' ? null : Number(v);

  return (
    <div>
      <PageHeader title={t('Branches')} subtitle={t('Where orders are made. Opening hours, fees and the switches here decide what the agent promises.')}
        actions={can.edit && <Button variant="gold" onClick={() => setEdit({ hours: { default: [{ open: '12:00', close: '00:00' }] }, accepting_orders: true, delivery_enabled: true, pickup_enabled: true, is_active: true })}><Plus className="size-4" /> {t('Add a branch')}</Button>} />
      {list.length === 0 ? <Empty title={t('No branches yet')}>{t('Add at least one branch with its address and hours — every order goes to a branch.')}</Empty> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map(b => {
            const st = STATE[states[b.id] || 'unknown'];
            return (
              <Card key={b.id} className={b.is_active ? '' : 'opacity-60'}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 font-semibold"><Store className="size-4 text-gold" />{b.name_en || b.name_ar}</p>
                    <p className="text-sm text-muted ar" dir="rtl">{b.name_ar} · <span className="font-mono">{b.code}</span></p>
                  </div>
                  <Badge tone={st.tone}>{t(st.label)}{states[b.id] === 'busy' && b.busy_until ? ' ' + t('until {date}', { date: clock(b.busy_until, tenant.timezone) }) : ''}</Badge>
                </div>
                <div className="mt-3 space-y-1 text-sm text-muted">
                  {b.address_ar && <p className="flex items-start gap-1.5" dir="auto"><MapPin className="mt-0.5 size-3.5 shrink-0" />{b.address_ar}</p>}
                  {b.phone && <p className="flex items-center gap-1.5"><Phone className="size-3.5" />{b.phone}</p>}
                  {b.hours_text_ar && <p className="flex items-center gap-1.5" dir="auto"><Clock className="size-3.5" />{b.hours_text_ar}</p>}
                  <p>{b.delivery_enabled ? t('Delivery {fee}', { fee: b.delivery_fee != null ? money(b.delivery_fee, tenant.currency_symbol) : t('(fee by zone)') }) : t('No delivery')} · {b.pickup_enabled ? t('Pickup') : t('No pickup')}{b.vat_percent != null ? ' · ' + t('VAT {v}%', { v: b.vat_percent }) : ''}</p>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                  <label className="flex items-center gap-2 text-sm">{t('Taking orders')} <Switch checked={b.accepting_orders} onChange={v => accepting(b, v)} disabled={busy} /></label>
                  <span className="flex-1" />
                  {states[b.id] === 'busy'
                    ? <Button size="sm" variant="outline" onClick={() => pause(b, 0)}>{t('Resume now')}</Button>
                    : <Button size="sm" variant="outline" onClick={() => setBusyFor(b)}><Pause className="size-3.5" /> {t('Too busy')}</Button>}
                  {can.edit && <Button size="sm" variant="ghost" onClick={() => setEdit({ ...b, aliases: b.aliases })}><Pencil className="size-4" /></Button>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-sm text-muted">{t('Delivery areas and their fees are drawn on the map in')} <Link href={`${base}/zones`} className="text-gold-ink underline">{t('Delivery zones')}</Link>.</p>

      <Modal open={!!busyFor} onClose={() => setBusyFor(null)} title={t('Pause {branch}', { branch: busyFor?.name_en || busyFor?.name_ar })}>
        <p className="mb-3 text-sm text-muted">{t('The agent tells customers this branch is too busy right now and offers another open branch. It starts taking orders again by itself.')}</p>
        <div className="grid grid-cols-3 gap-2">
          {[15, 30, 45, 60, 90, 120].map(m => <Button key={m} variant="outline" busy={busy} onClick={() => busyFor && pause(busyFor, m)}>{m < 60 ? t('{n} min', { n: m }) : t('{n} h', { n: m / 60 })}</Button>)}
        </div>
      </Modal>

      <Drawer open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? t('Edit {name}', { name: edit.name_en || edit.name_ar }) : t('New branch')}
        footer={<Button variant="gold" busy={busy} onClick={save}>{t('Save')}</Button>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Name (Arabic)')}><Input dir="rtl" value={edit.name_ar || ''} onChange={e => set('name_ar', e.target.value)} /></Field>
            <Field label={t('Name (English)')}><Input value={edit.name_en || ''} onChange={e => set('name_en', e.target.value)} /></Field>
            <Field label={t('Code')} hint={t('Short, English, never changes (e.g. zamalek).')}><Input dir="ltr" value={edit.code || ''} disabled={!!edit.id} onChange={e => set('code', e.target.value)} /></Field>
            <Field label={t('Other names customers use')} hint={t('Comma separated.')}><Input value={Array.isArray(edit.aliases) ? edit.aliases.join('، ') : (edit.aliases as unknown as string) || ''} onChange={e => set('aliases', e.target.value as unknown as string[])} /></Field>
            <Field label={t('Address (Arabic)')} className="sm:col-span-2"><Input dir="rtl" value={edit.address_ar || ''} onChange={e => set('address_ar', e.target.value)} /></Field>
            <Field label={t('Google Maps link or coordinates')} hint={edit.lat ? t('Pinned at {lat}, {lng}', { lat: edit.lat.toFixed(5), lng: edit.lng?.toFixed(5) }) : t("Paste the branch's Maps link — used for distances and the nearest branch.")} className="sm:col-span-2">
              <Input dir="ltr" value={edit.maps_url || ''} onChange={e => { const ll = parseLatLng(e.target.value); setEdit(x => ({ ...x, maps_url: e.target.value, ...(ll ? { lat: ll[0], lng: ll[1] } : {}) })); }} />
            </Field>
            <Field label={t('Branch phone')}><Input dir="ltr" value={edit.phone || ''} onChange={e => set('phone', e.target.value)} /></Field>
            <Field label={t('WhatsApp for new-order tickets')} hint={t("The kitchen's number; empty = the restaurant's (Settings → Ordering).")}><Input dir="ltr" value={edit.ops_whatsapp || ''} onChange={e => set('ops_whatsapp', e.target.value)} /></Field>
            <div className="sm:col-span-2"><p className="mb-2 text-sm font-medium">{t('Opening hours')}</p><HoursEditor value={edit.hours || {}} onChange={h => set('hours', h)} /></div>
            <Field label={t('Hours as the agent should say them')} hint={t('Optional — e.g.') + ' كل يوم من 12 الضهر لـ 2 بالليل'} className="sm:col-span-2"><Input dir="rtl" value={edit.hours_text_ar || ''} onChange={e => set('hours_text_ar', e.target.value)} /></Field>
            <div className="flex flex-wrap gap-5 sm:col-span-2">
              <Checkbox checked={edit.delivery_enabled !== false} onChange={v => set('delivery_enabled', v)} label={t('Delivers')} />
              <Checkbox checked={edit.pickup_enabled !== false} onChange={v => set('pickup_enabled', v)} label={t('Pickup')} />
              <Checkbox checked={!!edit.seasonal} onChange={v => set('seasonal', v)} label={t('Seasonal')} />
              <Checkbox checked={edit.is_active === false} onChange={v => set('is_active', !v)} label={t('Closed down (hidden)')} />
            </div>
            <Field label={t('Delivery fee ({currency})', { currency: tenant.currency })} hint={t('Used when no delivery zone sets one.')}><Input type="number" value={edit.delivery_fee ?? ''} onChange={e => set('delivery_fee', num(e.target.value))} /></Field>
            <Field label={t('Minimum order ({currency})', { currency: tenant.currency })}><Input type="number" value={edit.min_order ?? ''} onChange={e => set('min_order', num(e.target.value))} /></Field>
            <Field label={t('VAT %')} hint={t('Empty = prices exclude fees the branch adds.')}><Input type="number" value={edit.vat_percent ?? ''} onChange={e => set('vat_percent', num(e.target.value))} /></Field>
            <Field label={t('Delivers up to (km)')} hint={t('Used only before delivery zones are drawn.')}><Input type="number" value={edit.max_delivery_km ?? ''} onChange={e => set('max_delivery_km', num(e.target.value))} /></Field>
            <Field label={t('Usual delivery time')} hint={t('e.g.') + ' 45–60 دقيقة'}><Input dir="rtl" value={edit.delivery_eta_text || ''} onChange={e => set('delivery_eta_text', e.target.value)} /></Field>
            <Field label={t('Pickup ready in (minutes)')}><Input type="number" value={edit.prep_minutes ?? ''} onChange={e => set('prep_minutes', num(e.target.value))} /></Field>
            <Field label={t('Areas it usually serves')} hint={t('For customers who type an area instead of sharing a pin.')} className="sm:col-span-2"><Input dir="rtl" value={edit.serves_hint_ar || ''} onChange={e => set('serves_hint_ar', e.target.value)} /></Field>
            <Field label={t('Note about prices')} className="sm:col-span-2"><Textarea dir="rtl" rows={2} value={edit.price_note_ar || ''} onChange={e => set('price_note_ar', e.target.value)} placeholder="الأسعار من غير ضريبة 14%" /></Field>
          </div>
        )}
      </Drawer>
    </div>
  );
}
