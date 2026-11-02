'use client';
import { Bot, EyeOff, FileUp, Plus, Sparkles, Stethoscope, Tag } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { docName, serviceName, useClinic } from '@/lib/clinic-data';
import { cx, dateShort, money, priceText } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Offer, PriceKind, Service } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { DocDot } from '../booking/pickers';
import { Button, Card, Drawer, Empty, Input, PageTitle, Pill, Segmented, Skeleton, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';
import { ImportDrawer } from './ImportDrawer';
import { ServiceDrawer } from './ServiceDrawer';

export const CATEGORIES: { key: string; label: string }[] = [
  { key: 'consultation', label: 'Check-ups' }, { key: 'follow_up', label: 'Follow-ups' }, { key: 'diagnostic', label: 'X-rays and tests' },
  { key: 'procedure', label: 'Treatments' }, { key: 'cosmetic', label: 'Cosmetic' }, { key: 'package', label: 'Packages' }, { key: 'other', label: 'Other' }
];

// catalogue changes go through catalog_change: audited, and undone from the toast
export function useCatalog() {
  const { tenant } = useTenant();
  const { t } = useLang();
  const toast = useToast();
  const { refresh } = useClinic();
  const { busy, run } = useAction();
  const change = async (changes: unknown[], said: string) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('catalog_change', { p_tenant: tenant.id, p_changes: changes, p_apply: true, p_source: 'dashboard' });
      if (error) throw new Error(error.message);
      const res = data as { ok: boolean; error?: string; change_id?: number; problems?: { problem: string }[] };
      if (!res.ok) throw new Error(t(res.problems?.[0]?.problem === 'SERVICE_NOT_FOUND' ? 'That service was not found.' : 'Nothing was changed.'));
      return res;
    });
    if (r) {
      await refresh();
      toast(said, 'positive', r.change_id ? { label: t('Undo'), run: async () => { await sb().rpc('catalog_undo', { p_change: r.change_id }); await refresh(); toast(t('Undone.'), 'neutral'); } } : undefined);
    }
    return r;
  };
  return { busy, change };
}

// What the clinic offers and charges — the list the assistant answers from, word for word.
export function Services() {
  const { can } = useTenant();
  const { t, lang } = useLang();
  const { services, doctors, ready } = useClinic();
  const [doctor, setDoctor] = useState('all');
  const [open, setOpen] = useState<Service | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [digest, setDigest] = useState(false);
  const active = services.filter(s => s.is_active && (doctor === 'all' || !s.doctor_ids.length || s.doctor_ids.includes(doctor)));
  const unpriced = active.filter(s => s.price == null && !['after_exam', 'free'].includes(s.price_kind)).length;
  const groups = CATEGORIES.map(c => ({ ...c, list: active.filter(s => s.category === c.key) })).filter(g => g.list.length);
  const docs = doctors.filter(d => d.is_active);

  return (
    <div className="space-y-5">
      <PageTitle title={t('Services & prices')}
        finding={ready ? [t('{n} services', { n: active.length }), unpriced ? t('{n} without a price — the assistant says it will ask the doctor', { n: unpriced }) : t('the assistant answers prices from this list')].join(' · ') : ''}
        actions={<>
          <Button variant="ghost" onClick={() => setDigest(true)}><Bot className="size-4" aria-hidden />{t('What the assistant reads')}</Button>
          {can.edit && <Button variant="outline" onClick={() => setImporting(true)}><FileUp className="size-4" aria-hidden />{t('Import a price list')}</Button>}
          {can.edit && <Button variant="accent" onClick={() => setOpen('new')}><Plus className="size-4" aria-hidden />{t('Add a service')}</Button>}
        </>} />
      {docs.length > 1 && (
        <div className="rail -mx-1 overflow-x-auto px-1">
          <Segmented label="svc-doctor" value={doctor} onChange={setDoctor}
            options={[{ value: 'all', label: t('Everyone’s') }, ...docs.map(d => ({ value: d.id, label: <span className="inline-flex items-center gap-1.5"><DocDot color={d.color} />{docName(d, lang)}</span> }))]} />
        </div>
      )}

      {!ready ? <Skeleton className="h-80" /> : groups.length === 0 ? (
        <Empty action={can.edit ? <Button size="sm" variant="outline" onClick={() => setImporting(true)}>{t('Import a price list')}</Button> : undefined}>{t('No services yet.')}</Empty>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-5">
            {groups.map(g => (
              <Card key={g.key} pad={false} title={t(g.label)} sub={t('{n} services', { n: g.list.length })}>
                <ul className="divide-y divide-rule">
                  {g.list.map((s, i) => <ServiceRow key={s.id} s={s} i={i} onOpen={() => setOpen(s)} />)}
                </ul>
              </Card>
            ))}
          </div>
          <div className="min-w-0 space-y-5">
            <Offers />
            <p className="rounded-[10px] bg-raised px-4 py-3 text-[13px] leading-relaxed text-muted ring-1 ring-inset ring-border">
              <Sparkles className="me-1.5 inline size-4 text-accent" aria-hidden />
              {t('Change a price here and the next patient who asks hears the new one. You can also change prices from your own WhatsApp: “ارفع سعر التنضيف لـ 700”.')}
            </p>
          </div>
        </div>
      )}

      <ServiceDrawer service={open === 'new' ? null : open} open={open !== null} onClose={() => setOpen(null)} />
      <ImportDrawer open={importing} onClose={() => setImporting(false)} />
      <DigestDrawer open={digest} onClose={() => setDigest(false)} />
    </div>
  );
}

const KINDS: { value: PriceKind; label: string }[] = [
  { value: 'fixed', label: 'Fixed' }, { value: 'range', label: 'From–to' }, { value: 'from', label: 'From' }, { value: 'after_exam', label: 'After check-up' }, { value: 'free', label: 'Free' }
];

function ServiceRow({ s, i, onOpen }: { s: Service; i: number; onOpen: () => void }) {
  const { tenant, can } = useTenant();
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  const { busy, change } = useCatalog();
  const [edit, setEdit] = useState(false);
  const [kind, setKind] = useState<PriceKind>(s.price_kind);
  const [p, setP] = useState(s.price != null ? String(s.price) : '');
  const [mx, setMx] = useState(s.price_max != null ? String(s.price_max) : '');
  const sym = tenant.currency_symbol;
  const noPrice = s.price == null && !['after_exam', 'free'].includes(s.price_kind);
  const who = s.doctor_ids.map(id => doctors.find(d => d.id === id)).filter(Boolean);
  const save = async () => {
    const r = await change([{ op: 'set_price', service: s.code, price: ['after_exam', 'free'].includes(kind) ? null : Number(p) || null,
      price_max: kind === 'range' ? Number(mx) || null : null, price_kind: kind }], t('{name}: price saved.', { name: serviceName(s, lang) }));
    if (r) setEdit(false);
  };
  return (
    <li className="c-rise" style={{ animationDelay: `${Math.min(i, 12) * 16}ms` }}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3">
        <button onClick={onOpen} className="min-w-0 text-start">
          <span className="flex items-center gap-2 text-[14px] font-medium">
            <span className="truncate"><bdi>{serviceName(s, lang)}</bdi></span>
            {!s.agent_visible && <EyeOff className="size-3.5 shrink-0 text-faint" aria-label={t('Hidden from the assistant')} />}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {lang === 'ar' && s.name_en && <span dir="ltr">{s.name_en}</span>}
            <span>{t('{n} min', { n: s.duration_min })}</span>
            {s.sessions > 1 && <span>{t('{n} sessions', { n: s.sessions })}</span>}
            {s.needs_consult_first && <Pill>{t('Check-up first')}</Pill>}
            {s.resource_kind === 'chair' && <Pill>{t('Chair')}</Pill>}
            {who.length > 0 && who.map(d => <span key={d!.id} className="inline-flex items-center gap-1"><DocDot color={d!.color} />{docName(d, lang)}</span>)}
          </span>
        </button>
        <div className="text-end">
          {edit ? null : (
            <button onClick={() => can.edit && setEdit(true)} disabled={!can.edit}
              className={cx('press rounded-[7px] px-2 py-1 text-[14px] font-semibold tabular-nums hover:bg-raised', noPrice && 'text-caution')}>
              {noPrice ? t('Add a price') : priceText(s.price_kind, s.price, s.price_max, s.price_unit, sym)}
            </button>
          )}
          {s.price_note_ar && !edit && <p className="max-w-56 truncate text-xs text-muted"><bdi>{s.price_note_ar}</bdi></p>}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {edit && (
          <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden" onSubmit={e => { e.preventDefault(); save(); }}>
            <div className="flex flex-wrap items-center gap-2 border-t border-rule bg-raised/70 px-4 py-3">
              <Segmented label={`kind-${s.id}`} size="sm" value={kind} onChange={setKind} options={KINDS.map(k => ({ value: k.value, label: t(k.label) }))} />
              {!['after_exam', 'free'].includes(kind) && <Input autoFocus inputMode="numeric" aria-label={t('Price')} value={p} onChange={e => setP(e.target.value.replace(/[^\d.]/g, ''))} className="!w-24 tabular-nums" placeholder={t('Price')} />}
              {kind === 'range' && <><span className="text-muted">–</span><Input inputMode="numeric" aria-label={t('Up to')} value={mx} onChange={e => setMx(e.target.value.replace(/[^\d.]/g, ''))} className="!w-24 tabular-nums" placeholder={t('Up to')} /></>}
              <span className="text-[13px] text-muted">{sym}</span>
              <span className="ms-auto flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>{t('Cancel')}</Button>
                <Button size="sm" variant="accent" type="submit" busy={busy}>{t('Save')}</Button>
              </span>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </li>
  );
}

function Offers() {
  const { tenant, can } = useTenant();
  const { t, lang } = useLang();
  const { services } = useClinic();
  const { busy, change } = useCatalog();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [svc, setSvc] = useState('');
  const [ends, setEnds] = useState('');
  const { data, refresh } = useCached<Offer[]>(`offers:${tenant.id}`, async () => {
    const { data } = await sb().from('offers').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('created_at', { ascending: false });
    return (data || []) as Offer[];
  });
  const live = (data || []).filter(o => !o.ends_at || +new Date(o.ends_at) > Date.now());
  const add = async () => {
    const s = services.find(x => x.id === svc);
    const r = await change([{ op: 'add_offer', title_ar: title, kind: 'percent_off', value: Number(value) || 0, services: s ? [s.code] : [], ends_at: ends || null }], t('Offer added.'));
    if (r) { setAdding(false); setTitle(''); setValue(''); setSvc(''); setEnds(''); refresh(); }
  };
  const end = async (o: Offer) => { const r = await change([{ op: 'end_offer', offer: o.title_ar }], t('Offer ended.')); if (r) refresh(); };
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Tag className="size-4 text-accent" aria-hidden />{t('Offers')}</span>} pad={false}
      action={can.edit && !adding ? <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus className="size-3.5" aria-hidden />{t('Add')}</Button> : undefined}>
      <ul className="divide-y divide-rule">
        {live.map(o => (
          <li key={o.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium"><bdi>{o.title_ar}</bdi></p>
              <p className="text-xs text-muted">
                {o.kind === 'percent_off' ? t('{n}% off', { n: o.value }) : o.kind === 'amount_off' ? t('{p} off', { p: money(o.value, tenant.currency_symbol) }) : money(o.value, tenant.currency_symbol)}
                {o.service_ids.length ? <> · <bdi>{o.service_ids.map(id => serviceName(services.find(s => s.id === id), lang)).join('، ')}</bdi></> : null}
                {o.ends_at ? ` · ${t('until {d}', { d: dateShort(o.ends_at, tenant.timezone) })}` : ''}
              </p>
            </div>
            {can.edit && <button onClick={() => end(o)} className="press shrink-0 rounded-[6px] px-2 py-1 text-xs text-muted ring-1 ring-inset ring-border hover:bg-raised">{t('End')}</button>}
          </li>
        ))}
        {!live.length && !adding && <li className="px-4 py-3 text-[13px] text-muted">{t('No offers running.')}</li>}
      </ul>
      {adding && (
        <form className="c-fade space-y-2 border-t border-rule bg-raised/60 p-3" onSubmit={e => { e.preventDefault(); if (title.trim()) add(); }}>
          <Input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="خصم 20% على التبييض" aria-label={t('Offer')} />
          <div className="flex gap-2">
            <Input inputMode="numeric" value={value} onChange={e => setValue(e.target.value.replace(/\D/g, ''))} placeholder="%" aria-label={t('Percent off')} className="!w-16" />
            <select value={svc} onChange={e => setSvc(e.target.value)} aria-label={t('Service')} className="h-9 min-w-0 flex-1 rounded-[7px] border border-control bg-sheet px-2 text-sm">
              <option value="">{t('Any service')}</option>
              {services.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{serviceName(s, lang)}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Input type="date" value={ends} onChange={e => setEnds(e.target.value)} aria-label={t('Ends on')} className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('Cancel')}</Button>
            <Button size="sm" variant="accent" type="submit" busy={busy}>{t('Add')}</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function DigestDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant } = useTenant();
  const { t } = useLang();
  const { data } = useCached<{ digest: string; built_at: string }>(open ? `digest:${tenant.id}:${Date.now() >> 15}` : null, async () => {
    const { data, error } = await sb().rpc('agent_digest', { p_tenant: tenant.id });
    if (error) throw new Error(error.message);
    return data as { digest: string; built_at: string };
  });
  return (
    <Drawer open={open} onClose={onClose} width="max-w-[620px]" title={<span className="inline-flex items-center gap-2"><Stethoscope className="size-4 text-accent" aria-hidden />{t('What the assistant reads')}</span>}>
      <p className="mb-3 text-[13px] text-muted">{t('Before every reply the assistant reads this, built from your services, prices, offers, answers and rules. It quotes prices only from here.')}</p>
      {!data ? <Skeleton className="h-96" /> : <pre dir="rtl" className="whitespace-pre-wrap rounded-[10px] bg-raised p-4 font-sans text-[13px] leading-relaxed ring-1 ring-inset ring-border">{data.digest}</pre>}
    </Drawer>
  );
}
