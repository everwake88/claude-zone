'use client';
import { CalendarDays, Store } from 'lucide-react';
import { HoursEditor } from '@/components/branches/HoursEditor';
import { Button, Checkbox, Drawer, Field, Input, Select, Textarea, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { parseLatLng } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch } from '@/lib/types';

export const PAYMENTS: [string, string][] = [['cash', 'Cash'], ['card', 'Card on delivery'], ['wallet', 'Mobile wallet'], ['instapay', 'InstaPay'],
  ['online', 'Online (Paymob link)']];

// Adding or editing a branch: its names, address and pin, hours, fees, and what is different there.
export function BranchEditor({ edit, setEdit, list, restPay, onSaved }: {
  edit: Partial<Branch> | null; setEdit: (f: Partial<Branch> | null | ((e: Partial<Branch> | null) => Partial<Branch> | null)) => void;
  list: Branch[]; restPay: string[]; onSaved: () => Promise<unknown> | void;
}) {
  const { tenant } = useTenant();
  const { busy, run } = useAction();
  const t = useT();
  const payName = (m: string) => t(PAYMENTS.find(p => p[0] === m)?.[1] || m);
  const load = onSaved;
  const set = <K extends keyof Branch>(k: K, v: Branch[K]) => setEdit(e => ({ ...e, [k]: v }));
  const num = (v: string) => v === '' ? null : Number(v);

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
      is_active: b.is_active !== false, sort: b.sort ?? ((list?.length || 0) + 1) * 10,
      reservations: b.dine_in === false ? 'off' : b.reservations || 'off', reservation_note_ar: b.reservation_note_ar || null,
      reservation_max_guests: b.reservation_max_guests ?? null,
      dine_in: b.dine_in ?? null, payment_methods: b.payment_methods ?? null
    };
    if (row.reservations === 'phone' && !row.phone) throw new Error(t('Bookings by phone need the branch phone — the agent gives that number.'));
    if (row.payment_methods && !row.payment_methods.length) throw new Error(t('Tick at least one way to pay at this branch, or use the restaurant’s.'));
    const { error } = b.id ? await sb().from('branches').update(row).eq('id', b.id) : await sb().from('branches').insert(row);
    if (error) throw new Error(error.message.includes('branches_tenant_id_code_key') ? t('Another branch already uses that code') : error.message);
    setEdit(null); await load();
  }, t('Branch saved — the agent knows on the next message'));

  return (
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
          <Field label={t('WhatsApp for new-order tickets')} hint={t("The kitchen's number; empty = the restaurant's (Settings → Ordering rules).")}><Input dir="ltr" value={edit.ops_whatsapp || ''} onChange={e => set('ops_whatsapp', e.target.value)} /></Field>
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
          <div className="space-y-3 border-t border-hairline pt-4 sm:col-span-2">
            <p className="flex items-center gap-2 text-sm font-medium"><Store className="size-4 text-gold" /> {t('What is different at this branch')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('Seating (dine-in)')} hint={t('No seating: the agent never offers to eat in here, takes no table bookings, and leaves out dine-in only dishes.')}>
                <Select value={edit.dine_in == null ? '' : edit.dine_in ? 'yes' : 'no'}
                  onChange={e => setEdit(x => ({ ...x, dine_in: e.target.value === '' ? null : e.target.value === 'yes',
                                                 ...(e.target.value === 'no' ? { reservations: 'off' as const } : {}) }))}>
                  <option value="">{t('Not said — the agent does not promise either')}</option>
                  <option value="yes">{t('Yes — customers can eat here')}</option>
                  <option value="no">{t('No — delivery and pickup only')}</option>
                </Select>
              </Field>
              <Field label={t('Payment methods')} hint={t('The agent offers only these to customers of this branch.')}>
                <Select value={edit.payment_methods ? 'own' : 'same'}
                  onChange={e => set('payment_methods', e.target.value === 'own' ? [...restPay] : null)}>
                  <option value="same">{t('The restaurant’s ({list})', { list: restPay.map(payName).join('، ') })}</option>
                  <option value="own">{t('Its own')}</option>
                </Select>
              </Field>
            </div>
            {edit.payment_methods && (
              <div className="flex flex-wrap gap-5">
                {PAYMENTS.filter(([k]) => k !== 'online' || restPay.includes('online')).map(([k, label]) => (
                  <Checkbox key={k} checked={edit.payment_methods!.includes(k)} label={t(label)}
                    onChange={v => set('payment_methods', v ? [...edit.payment_methods!.filter(x => x !== k), k] : edit.payment_methods!.filter(x => x !== k))} />
                ))}
              </div>
            )}
            {edit.payment_methods && !restPay.includes('online') && <p className="text-xs text-muted">{t('Online payment links can be ticked here once Paymob is on (Settings → Online payments).')}</p>}
            <p className="text-xs text-muted">{t('Its own dishes, prices and choices: Menu, with this branch chosen at the top.')}</p>
          </div>
          <div className="space-y-3 border-t border-hairline pt-4 sm:col-span-2">
            <p className="flex items-center gap-2 text-sm font-medium"><CalendarDays className="size-4 text-gold" /> {t('Table bookings (dine-in)')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('How this branch takes bookings')} hint={edit.dine_in === false ? t('No seating at this branch, so no table bookings.') : undefined}>
                <Select value={edit.reservations || 'off'} disabled={edit.dine_in === false} onChange={e => set('reservations', e.target.value as Branch['reservations'])}>
                  <option value="off">{t('No table bookings')}</option>
                  <option value="whatsapp">{t('On WhatsApp — the agent takes them')}</option>
                  <option value="phone">{t('By phone only — the agent gives the branch phone')}</option>
                </Select>
              </Field>
              {edit.reservations === 'whatsapp' && (
                <Field label={t('Largest group the agent books')} hint={t('Bigger groups are passed to the team. Empty = the restaurant’s default (20).')}>
                  <Input type="number" min={1} value={edit.reservation_max_guests ?? ''} onChange={e => set('reservation_max_guests', num(e.target.value))} />
                </Field>
              )}
              {edit.reservations && edit.reservations !== 'off' && (
                <Field label={t('What the agent should tell customers about booking here')} hint={t('Optional, in Arabic.')} className="sm:col-span-2">
                  <Input dir="rtl" value={edit.reservation_note_ar || ''} onChange={e => set('reservation_note_ar', e.target.value)}
                    placeholder={edit.reservations === 'phone' ? 'الحجز في الفرع ده بالتليفون بس' : 'الترابيزات اللي على البحر محدودة'} />
                </Field>
              )}
            </div>
            {edit.reservations === 'whatsapp' && <p className="text-xs text-muted">{t('The agent collects the day, time, number of people, name and any occasion, shows a summary, and after the customer says yes sends the request to this branch’s WhatsApp for new-order tickets and to Table bookings here. The customer is told it is confirmed only when your team presses Confirm.')}</p>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
