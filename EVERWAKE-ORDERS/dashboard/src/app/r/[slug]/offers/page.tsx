'use client';
import { Pencil, Plus, Tag } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, Drawer, Empty, Field, Input, PageHeader, Select, Spinner, Switch, Textarea, useAction } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Category, Item, Offer } from '@/lib/types';

const KIND: Record<Offer['kind'], string> = {
  percent_off: '% off', amount_off: 'Amount off', fixed_price: 'Special price', free_delivery: 'Free delivery', free_item: 'Free item'
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// an ISO time shown in the browser's own clock, for <input type="datetime-local">
const localInput = (iso: string | null | undefined) =>
  iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

export default function OffersPage() {
  const { tenant, can } = useTenant();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [edit, setEdit] = useState<Partial<Offer> | null>(null);
  const { busy, run } = useAction();
  const t = useT();
  const sym = tenant.currency_symbol;

  const load = useCallback(async () => {
    const [o, i, c, b] = await Promise.all([
      sb().from('offers').select('*').eq('tenant_id', tenant.id).order('priority'),
      sb().from('menu_items').select('id, code, name_ar, price, unit').eq('tenant_id', tenant.id).eq('is_active', true).order('name_ar'),
      sb().from('menu_categories').select('*').eq('tenant_id', tenant.id).order('sort'),
      sb().from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort')
    ]);
    setOffers((o.data || []) as Offer[]); setItems((i.data || []) as Item[]); setCats((c.data || []) as Category[]); setBranches((b.data || []) as Branch[]);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const describe = (o: Offer) => {
    const what = o.kind === 'percent_off' ? t('{v}% off', { v: o.value }) : o.kind === 'amount_off' ? t('{v} off', { v: money(o.value, sym) })
      : o.kind === 'fixed_price' ? t('{v} special price', { v: money(o.value, sym) })
      : o.kind === 'free_delivery' ? t('Free delivery') : t('Free {item}', { item: items.find(i => i.id === o.free_item_id)?.name_ar || t('item') });
    const on = o.scope === 'items' ? ' ' + t('on {n} dishes', { n: o.item_ids.length })
      : o.scope === 'categories' ? ' ' + t('on {n} categories', { n: o.category_ids.length }) : '';
    return what + on + (o.min_subtotal ? ' · ' + t('orders over {v}', { v: money(o.min_subtotal, sym) }) : '');
  };

  const toggle = (o: Offer, v: boolean) => run(async () => {
    const { error } = await sb().from('offers').update({ is_active: v }).eq('id', o.id);
    if (error) throw new Error(error.message);
    await load();
  }, v ? t('Offer on — the agent mentions it when it fits') : t('Offer off'));

  const save = () => run(async () => {
    const o = edit!;
    if (!o.title_ar?.trim()) throw new Error(t('Give the offer a title'));
    const row = {
      tenant_id: tenant.id, title_ar: o.title_ar.trim(), title_en: o.title_en || null, description_ar: o.description_ar || null,
      kind: o.kind || 'percent_off', scope: o.kind === 'free_delivery' ? 'order' : (o.scope || 'order'), value: Number(o.value || 0),
      max_discount: o.max_discount ?? null, min_subtotal: o.min_subtotal ?? null,
      item_ids: o.scope === 'items' ? o.item_ids || [] : [], category_ids: o.scope === 'categories' ? o.category_ids || [] : [],
      branch_ids: o.branch_ids || [], free_item_id: o.kind === 'free_item' ? o.free_item_id || null : null, free_item_qty: Number(o.free_item_qty || 1),
      promo_code: (o.promo_code || '').trim().toUpperCase() || null, first_order_only: !!o.first_order_only, stackable: !!o.stackable,
      every_nth_order: o.every_nth_order && o.every_nth_order > 1 ? Math.round(o.every_nth_order) : null,
      priority: Number(o.priority ?? 100), starts_at: o.starts_at || null, ends_at: o.ends_at || null, days_of_week: o.days_of_week || [],
      time_from: o.time_from || null, time_to: o.time_to || null, is_active: o.is_active !== false
    };
    if (row.kind === 'free_item' && !row.free_item_id) throw new Error(t('Choose the free item'));
    const { error } = o.id ? await sb().from('offers').update(row).eq('id', o.id) : await sb().from('offers').insert(row);
    if (error) throw new Error(error.message);
    setEdit(null); await load();
  }, t('Offer saved — the agent knows on the next message'));

  if (!offers) return <Spinner />;
  const set = <K extends keyof Offer>(k: K, v: Offer[K]) => setEdit(e => ({ ...e, [k]: v }));
  const multi = (e: React.ChangeEvent<HTMLSelectElement>) => Array.from(e.target.selectedOptions).map(o => o.value);

  return (
    <div>
      <PageHeader title={t('Offers')} subtitle={t('WhatsApp-only deals. The cart applies them by itself; the agent mentions one when it genuinely helps the customer.')}
        actions={can.edit && <Button variant="gold" onClick={() => setEdit({ kind: 'percent_off', scope: 'order', value: 10, is_active: true, priority: 100, free_item_qty: 1 })}><Plus className="size-4" /> {t('New offer')}</Button>} />
      <PageGuide id="offers" steps={[
          t('Make a deal: a percent or an amount off, a special price, free delivery or a free item.'),
          t('Limit it if you like: some dishes or categories, some branches, days and hours, a minimum order, first orders only, or a promo code.'),
          t('The cart applies it by itself and the customer sees it in the order summary. A promo-code offer counts only once the customer gives the code.')
        ]} />
      {offers.length === 0 ? <Empty title={t('No offers yet')}>{t('A WhatsApp-only offer (a free side, free delivery, 10% off) is the easiest way to move customers from the delivery apps to your own line.')}</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {offers.map(o => (
            <Card key={o.id}>
              <div className="flex items-start gap-3">
                <Tag className="mt-0.5 size-5 text-gold" />
                <div className="flex-1">
                  <p className="font-semibold" dir="auto">{o.title_ar}</p>
                  <p className="text-sm text-muted">{describe(o)}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge tone="gold">{t(KIND[o.kind])}</Badge>
                    {o.promo_code && <Badge tone="navy">{t('code {code}', { code: o.promo_code })}</Badge>}
                    {o.first_order_only && <Badge>{t('first order')}</Badge>}
                    {o.every_nth_order && <Badge tone="gold">{t('every {n}th order', { n: o.every_nth_order })}</Badge>}
                    {o.stackable && <Badge>{t('stacks with others')}</Badge>}
                    {o.days_of_week.length > 0 && <Badge>{o.days_of_week.map(d => t(DAYS[d])).join(' ')}</Badge>}
                    {o.time_from && <Badge>{o.time_from.slice(0, 5)}–{o.time_to?.slice(0, 5)}</Badge>}
                    {o.ends_at && <Badge tone={new Date(o.ends_at) < new Date() ? 'critical' : 'neutral'}>{t('until {date}', { date: o.ends_at.slice(0, 10) })}</Badge>}
                    {o.branch_ids.length > 0 && <Badge>{o.branch_ids.length > 1 ? t('{n} branches', { n: o.branch_ids.length }) : t('1 branch')}</Badge>}
                  </div>
                </div>
                <Switch checked={o.is_active} onChange={v => toggle(o, v)} disabled={!can.edit} label={t('Active')} />
                {can.edit && <Button size="sm" variant="ghost" onClick={() => setEdit(o)}><Pencil className="size-4" /></Button>}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Drawer open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? t('Edit offer') : t('New offer')} footer={<Button variant="gold" busy={busy} onClick={save}>{t('Save offer')}</Button>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Title (Arabic)')} className="sm:col-span-2"><Input dir="rtl" value={edit.title_ar || ''} onChange={e => set('title_ar', e.target.value)} placeholder="بطاطس هدية مع أي وجبة" /></Field>
            <Field label={t('How the agent should describe it')} className="sm:col-span-2"><Textarea dir="rtl" rows={2} value={edit.description_ar || ''} onChange={e => set('description_ar', e.target.value)} /></Field>
            <Field label={t('Type')}>
              <Select value={edit.kind} onChange={e => set('kind', e.target.value as Offer['kind'])}>
                {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
              </Select>
            </Field>
            {edit.kind !== 'free_delivery' && edit.kind !== 'free_item' && (
              <Field label={edit.kind === 'percent_off' ? t('Percent') : edit.kind === 'fixed_price' ? t('New price ({currency})', { currency: tenant.currency }) : t('Amount ({currency})', { currency: tenant.currency })}>
                <Input type="number" value={edit.value ?? ''} onChange={e => set('value', Number(e.target.value))} />
              </Field>
            )}
            {edit.kind === 'free_item' && (
              <Field label={t('Free item')}>
                <Select value={edit.free_item_id || ''} onChange={e => set('free_item_id', e.target.value)}>
                  <option value="">{t('Choose…')}</option>{items.map(i => <option key={i.id} value={i.id}>{i.name_ar}</option>)}
                </Select>
              </Field>
            )}
            {edit.kind !== 'free_delivery' && (
              <Field label={t('Applies to')}>
                <Select value={edit.scope} onChange={e => set('scope', e.target.value as Offer['scope'])}>
                  <option value="order">{t('The whole order')}</option><option value="items">{t('Specific dishes')}</option><option value="categories">{t('Categories')}</option>
                </Select>
              </Field>
            )}
            {edit.scope === 'items' && edit.kind !== 'free_delivery' && (
              <Field label={t('Dishes')} hint={t('Ctrl/⌘-click to pick several.')} className="sm:col-span-2">
                <select multiple className="h-40 w-full rounded-lg border border-hairline p-2 text-sm" value={edit.item_ids || []} onChange={e => set('item_ids', multi(e))}>
                  {items.map(i => <option key={i.id} value={i.id}>{i.code} · {i.name_ar}</option>)}
                </select>
              </Field>
            )}
            {edit.scope === 'categories' && edit.kind !== 'free_delivery' && (
              <Field label={t('Categories')} className="sm:col-span-2">
                <select multiple className="h-32 w-full rounded-lg border border-hairline p-2 text-sm" value={edit.category_ids || []} onChange={e => set('category_ids', multi(e))}>
                  {cats.map(c => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('Minimum order ({currency})', { currency: tenant.currency })}><Input type="number" value={edit.min_subtotal ?? ''} onChange={e => set('min_subtotal', e.target.value === '' ? null : Number(e.target.value))} /></Field>
            {edit.kind === 'percent_off' && <Field label={t('Maximum discount ({currency})', { currency: tenant.currency })}><Input type="number" value={edit.max_discount ?? ''} onChange={e => set('max_discount', e.target.value === '' ? null : Number(e.target.value))} /></Field>}
            <Field label={t('Loyalty: every how many orders? (optional)')} hint={t('10 = the customer’s 10th, 20th, 30th… order gets it, on WhatsApp and the QR menu. The agent tells them how close they are.')}>
              <Input type="number" min={2} value={edit.every_nth_order ?? ''} onChange={e => set('every_nth_order', e.target.value === '' ? null : Number(e.target.value))} placeholder="10" />
            </Field>
            <Field label={t('Promo code (optional)')} hint={t('Only customers who send this code get it; the agent never reveals it.')}><Input dir="ltr" value={edit.promo_code || ''} onChange={e => set('promo_code', e.target.value.toUpperCase())} placeholder="RAMADAN20" /></Field>
            <Field label={t('Starts')}><Input type="datetime-local" value={localInput(edit.starts_at)} onChange={e => set('starts_at', e.target.value ? new Date(e.target.value).toISOString() : null)} /></Field>
            <Field label={t('Ends')}><Input type="datetime-local" value={localInput(edit.ends_at)} onChange={e => set('ends_at', e.target.value ? new Date(e.target.value).toISOString() : null)} /></Field>
            <div className="sm:col-span-2">
              <p className="mb-1.5 text-sm font-medium">{t('Days (none = every day)')}</p>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => {
                  const on = (edit.days_of_week || []).includes(i);
                  return <Button key={d} size="sm" variant={on ? 'primary' : 'outline'} onClick={() => set('days_of_week', on ? (edit.days_of_week || []).filter(x => x !== i) : [...(edit.days_of_week || []), i])}>{t(d)}</Button>;
                })}
              </div>
            </div>
            <Field label={t('From (time of day)')}><Input type="time" value={(edit.time_from || '').slice(0, 5)} onChange={e => set('time_from', e.target.value || null)} /></Field>
            <Field label={t('Until')}><Input type="time" value={(edit.time_to || '').slice(0, 5)} onChange={e => set('time_to', e.target.value || null)} /></Field>
            {branches.length > 1 && (
              <Field label={t('Branches (none selected = all)')} className="sm:col-span-2">
                <select multiple className="h-28 w-full rounded-lg border border-hairline p-2 text-sm" value={edit.branch_ids || []} onChange={e => set('branch_ids', multi(e))}>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name_en || b.name_ar}</option>)}
                </select>
              </Field>
            )}
            <div className="flex flex-wrap gap-5 sm:col-span-2">
              <Checkbox checked={!!edit.first_order_only} onChange={v => set('first_order_only', v)} label={t('First order only')} />
              <Checkbox checked={!!edit.stackable} onChange={v => set('stackable', v)} label={t('Can combine with other offers')} />
            </div>
            <p className="text-xs text-muted sm:col-span-2">{t('When several offers that do not combine apply, the customer gets the one worth the most.')}</p>
          </div>
        )}
      </Drawer>
    </div>
  );
}
