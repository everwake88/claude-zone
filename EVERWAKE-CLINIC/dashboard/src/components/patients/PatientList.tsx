'use client';
import { CalendarPlus, Search, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clock, cx, dateShort, phone as fmtPhone } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useCached } from '@/lib/use-cached';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Drawer, Empty, Field, Input, PageTitle, Pill, Segmented, Skeleton, Textarea, useAction } from '../ui';
import { useTenant } from '../tenant';

interface Row { id: number; file_no: string | null; full_name: string; sex: string | null; age: string | null; phone: string | null;
  last_visit_at: string | null; visits_count: number; tags: string[]; next: { id: number; starts_at: string; doctor: string } | null }

// Every patient: find one by name, mobile or file number, see when they last came and when they come next.
export function PatientList() {
  const { tenant, base } = useTenant();
  const { t } = useLang();
  const shell = useShell();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(false);
  const [show, setShow] = useState<'all' | 'today' | 'coming' | 'new'>('all');
  useEffect(() => { const timer = setTimeout(() => setTerm(q.trim()), 200); return () => clearTimeout(timer); }, [q]);
  const { data } = useCached<Row[]>(`patients:${tenant.id}:${term}`, async () => {
    const { data, error } = await sb().rpc('patient_search', { p_tenant: tenant.id, p_q: term, p_limit: 60 });
    if (error) throw new Error(error.message);
    return data as Row[];
  });

  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(new Date());
  const rows = (list: Row[]) => list.filter(p => show === 'all' ? true : show === 'new' ? !p.visits_count
    : show === 'coming' ? !!p.next : !!p.next && new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(new Date(p.next.starts_at)) === todayKey);
  return (
    <div>
      <PageTitle title={t('Patients')} finding={data ? (term ? t('{n} found', { n: data.length }) : t('The most recent first')) : ''}
        actions={<><Button variant="outline" onClick={() => setAdding(true)}><UserPlus className="size-4" aria-hidden />{t('Add a patient')}</Button>
          <Button onClick={() => shell.newBooking()}><CalendarPlus className="size-4" aria-hidden />{t('New booking')}</Button></>} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Name, mobile or file number')} className="h-11 rounded-full ps-10" aria-label={t('Search patients')} />
        </div>
        <div className="rail -mx-1 overflow-x-auto px-1">
          <Segmented label="patients-show" value={show} onChange={setShow}
            options={[{ value: 'all', label: t('All') }, { value: 'today', label: t('Booked today') }, { value: 'coming', label: t('Coming up') }, { value: 'new', label: t('New') }]} />
        </div>
      </div>
      {!data ? (
        <div className="card divide-y divide-rule">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex items-center gap-3 p-4"><Skeleton className="size-9 rounded-full" /><Skeleton className="h-4 w-48" /></div>)}</div>
      ) : rows(data).length === 0 ? (
        <Empty action={<Button size="sm" variant="outline" onClick={() => setAdding(true)}>{t('Add a patient')}</Button>}>
          {term ? t('No patient by that name or number.') : show !== 'all' ? t('Nobody here yet.') : t('No patients yet. They are added when they book on WhatsApp or at the desk.')}
        </Empty>
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto] gap-4 border-b border-rule px-5 pb-2.5 pt-4 text-[12px] text-faint md:grid">
            <span>{t('Patient')}</span><span>{t('Mobile')}</span><span>{t('Last visit')}</span><span>{t('Next')}</span><span className="w-8" />
          </div>
          <ul className="divide-y divide-rule">
            {rows(data).map((p, i) => (
              <li key={p.id} className="c-rise group relative" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
                <Link href={`${base}/patients/${p.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-raised md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]">
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar name={p.full_name} size={34} />
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium">{p.full_name}</span>
                      <span className="block truncate text-xs text-muted">{[p.file_no && `#${p.file_no}`, p.age, p.sex && t(p.sex === 'female' ? 'Female' : 'Male')].filter(Boolean).join(' · ')}</span>
                    </span>
                  </span>
                  <span className="hidden text-[13px] tabular-nums text-muted md:block" dir="ltr">{fmtPhone(p.phone)}</span>
                  <span className="hidden text-[13px] text-muted md:block">{p.last_visit_at ? <>{dateShort(p.last_visit_at, tenant.timezone)} <span className="text-faint">· {t('{n} visits', { n: p.visits_count })}</span></> : <Pill tone="accent">{t('New')}</Pill>}</span>
                  <span className="text-[13px] max-md:col-start-2 max-md:row-start-1 max-md:text-end">
                    {p.next ? <span className="text-ink"><span className="font-medium">{dateShort(p.next.starts_at, tenant.timezone)}</span> <span className="text-muted">{clock(p.next.starts_at, tenant.timezone)}</span></span> : <span className="text-faint">—</span>}
                  </span>
                  <span className="hidden w-8 md:block" />
                </Link>
                <button onClick={() => shell.newBooking({ patientId: p.id, patientName: p.full_name })} aria-label={t('Book for {name}', { name: p.full_name })}
                  className={cx('press absolute end-3 top-1/2 hidden size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted ring-1 ring-inset ring-border hover:bg-sheet hover:text-accent md:flex',
                    'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100')}>
                  <CalendarPlus className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <PatientForm open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

export interface PatientDetails { id?: number; full_name?: string; phone?: string | null; sex?: string | null; birth_date?: string | null; age?: string;
  national_id?: string | null; blood_group?: string | null; occupation?: string | null; address?: string | null; insurance?: string | null; notes?: string | null }

// a patient's details: new, or changing them
export function PatientForm({ open, onClose, initial, onSaved }: { open: boolean; onClose: () => void; initial?: PatientDetails; onSaved?: () => void }) {
  const { tenant, base } = useTenant();
  const { t } = useLang();
  const router = useRouter();
  const { busy, run } = useAction();
  const [p, setP] = useState<PatientDetails>({});
  useEffect(() => { if (open) setP(initial || { sex: '' }); }, [open, initial]);
  const set = (k: keyof PatientDetails) => (e: { target: { value: string } }) => setP(x => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    const r = await run(async () => {
      const body: Record<string, unknown> = { ...p };
      if (!body.birth_date) delete body.birth_date;
      if (!body.age) delete body.age;
      const { data, error } = await sb().rpc('save_patient', { p_tenant: tenant.id, p: body });
      if (error) throw new Error(error.message);
      return data as { id: number };
    }, initial?.id ? t('Saved.') : t('Patient added.'));
    if (r) { onClose(); onSaved?.(); if (!initial?.id) router.push(`${base}/patients/${r.id}`); }
  };
  return (
    <Drawer open={open} onClose={onClose} title={initial?.id ? t('Patient details') : t('Add a patient')} width="max-w-[480px]"
      footer={<><Button variant="outline" onClick={onClose}>{t('Cancel')}</Button><Button busy={busy} disabled={!p.full_name?.trim()} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Full name')} className="sm:col-span-2"><Input value={p.full_name || ''} onChange={set('full_name')} /></Field>
        <Field label={t('Mobile (WhatsApp)')}><Input dir="ltr" inputMode="tel" value={p.phone || ''} onChange={set('phone')} placeholder="010 0000 0000" /></Field>
        <Field label={t('Sex')}>
          <Segmented label="pf-sex" value={(p.sex || 'x') as 'female' | 'male' | 'x'} onChange={v => setP(x => ({ ...x, sex: v === 'x' ? '' : v }))}
            options={[{ value: 'female', label: t('Female') }, { value: 'male', label: t('Male') }]} />
        </Field>
        <Field label={t('Date of birth')}><Input type="date" value={p.birth_date || ''} onChange={set('birth_date')} /></Field>
        <Field label={t('…or age')} hint={t('e.g. 34 or 8 months')}><Input value={p.age || ''} onChange={set('age')} /></Field>
        <Field label={t('Blood group')}><Input value={p.blood_group || ''} onChange={set('blood_group')} placeholder="O+" dir="ltr" /></Field>
        <Field label={t('Insurance')}><Input value={p.insurance || ''} onChange={set('insurance')} /></Field>
        <Field label={t('National ID')}><Input dir="ltr" inputMode="numeric" value={p.national_id || ''} onChange={set('national_id')} /></Field>
        <Field label={t('Occupation')}><Input value={p.occupation || ''} onChange={set('occupation')} /></Field>
        <Field label={t('Address')} className="sm:col-span-2"><Input value={p.address || ''} onChange={set('address')} /></Field>
        <Field label={t('Notes for the team')} className="sm:col-span-2"><Textarea rows={2} value={p.notes || ''} onChange={set('notes')} /></Field>
      </div>
    </Drawer>
  );
}
