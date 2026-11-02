'use client';
import { AlertTriangle, ArrowLeft, CalendarPlus, FileText, Lock, MessageCircle, Mic, Pencil, Phone, Users } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useClinic } from '@/lib/clinic-data';
import { clock, cx, dateShort, phone as fmtPhone } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import type { ApptCard } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { ApptDrawer, STATUS_LABEL, STATUS_TONE } from '../appointment/ApptDrawer';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Card, Empty, Pill, Segmented, Skeleton } from '../ui';
import { useTenant } from '../tenant';
import { DentalChart, Plans } from './Dental';
import { PatientForm } from './PatientList';
import { RecordList, Vitals } from './Records';
import type { Profile } from './types';
import { VisitNotes } from './VisitNotes';

type Tab = 'overview' | 'visits' | 'dental' | 'files' | 'appointments';

// One patient: who they are and how to reach them, what the doctor must not miss (allergies first),
// their visits, their teeth when the clinic has a dentist, their files, and every appointment.
export function PatientProfile({ id }: { id: number }) {
  const { tenant, base, can } = useTenant();
  const { t, lang } = useLang();
  const shell = useShell();
  const { doctors } = useClinic();
  const [tab, setTab] = useState<Tab>('overview');
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState<ApptCard | null>(null);
  const [draftTooth, setDraftTooth] = useState<{ tooth: number; planned: string | null } | null>(null);
  const { data: p, refresh } = useCached<Profile>(`patient:${id}`, async () => {
    const { data, error } = await sb().rpc('patient_profile', { p_patient: id });
    if (error) throw new Error(error.message);
    return data as Profile;
  });
  useLive(['appointments'], (e) => { if (Number(e.row.patient_id) === id) refresh(); });

  const dental = useMemo(() => doctors.some(d => d.specialty === 'dentistry') || (p?.dental_chart?.length || 0) > 0, [doctors, p]);
  if (!p) return <div className="space-y-4"><Skeleton className="h-24" /><div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-56 lg:col-span-2" /><Skeleton className="h-56" /></div></div>;

  const pt = p.patient;
  const tz = tenant.timezone;
  const now = Date.now();
  const upcoming = p.appointments.filter(a => ['booked', 'confirmed', 'held'].includes(a.status) && +new Date(a.ends_at) > now).reverse();
  const activeAllergies = (p.allergies || []).filter(a => a.status === 'active');
  // today's visit, to open the visit workspace on
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const visitAppt = p.appointments.find(a => a.session_date === todayKey && ['arrived', 'in_visit', 'confirmed', 'booked'].includes(a.status));
  const wa = p.contacts.find(c => c.conversation_id);
  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: t('Overview') }, { value: 'visits', label: t('Visits') },
    ...(dental && p.clinical ? [{ value: 'dental' as Tab, label: t('Teeth & plans') }] : []),
    { value: 'files', label: t('Files') }, { value: 'appointments', label: t('Appointments') }
  ];

  return (
    <div className="space-y-5">
      <Link href={`${base}/patients`} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t('Patients')}</Link>

      {/* who */}
      <header className="card c-rise flex flex-wrap items-start gap-4 p-5 sm:p-6">
        <Avatar name={pt.full_name} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-tight">{pt.full_name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span className="tabular-nums">#{pt.file_no}</span>
            {(lang === 'en' ? pt.age_en : pt.age) && <span>{lang === 'en' ? pt.age_en : pt.age}</span>}
            {pt.sex && <span>{t(pt.sex === 'female' ? 'Female' : 'Male')}</span>}
            {pt.blood_group && <span dir="ltr">{pt.blood_group}</span>}
            {pt.insurance && <span><bdi>{pt.insurance}</bdi></span>}
            <span>{pt.visits_count ? t('{n} visits', { n: pt.visits_count }) : t('New patient')}{pt.first_visit_at ? ` · ${t('since {d}', { d: dateShort(pt.first_visit_at, tz) })}` : ''}</span>
            {pt.no_show_count > 0 && <Pill tone="caution">{t('Missed {n} before', { n: pt.no_show_count })}</Pill>}
          </p>
          {activeAllergies.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5">
              <AlertTriangle className="size-4 text-critical" aria-hidden /><span className="text-[13px] font-semibold text-critical-ink">{t('Allergic to')}</span>
              {activeAllergies.map(a => <span key={a.id} className="rounded-full bg-critical-soft px-2.5 py-0.5 text-[12.5px] font-medium text-critical-ink"><bdi>{String(a.substance)}</bdi></span>)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 max-sm:w-full">
          {pt.phone && <a href={`tel:+${pt.phone}`} className="press inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] ring-1 ring-inset ring-control hover:bg-raised"><Phone className="size-4 text-muted" aria-hidden /><bdi dir="ltr">{fmtPhone(pt.phone)}</bdi></a>}
          {wa && <Link href={`${base}/inbox?c=${wa.conversation_id}`} className="press inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] ring-1 ring-inset ring-control hover:bg-raised"><MessageCircle className="size-4 text-positive" aria-hidden />{t('Chat')}</Link>}
          <Button variant="ghost" onClick={() => setEdit(true)}><Pencil className="size-4" aria-hidden />{t('Details')}</Button>
          {visitAppt && can.clinical
            ? <Link href={`${base}/visit/${visitAppt.id}`} className="press inline-flex h-10 items-center gap-1.5 rounded-full bg-gold px-4 text-sm font-semibold text-navy hover:bg-gold-bright"><Mic className="size-4" aria-hidden />{t('Start visit')}</Link>
            : null}
          <Button onClick={() => shell.newBooking({ patientId: pt.id, patientName: pt.full_name })}><CalendarPlus className="size-4" aria-hidden />{t('Book')}</Button>
        </div>
      </header>

      {upcoming[0] && (
        <button onClick={() => setOpen(upcoming[0])} className="lift flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-accent-soft px-5 py-2.5 text-start text-[13.5px] text-accent-ink ring-1 ring-inset ring-accent-track">
          <span className="font-semibold">{t('Next visit')}</span>
          <span>{dateShort(upcoming[0].est_at || upcoming[0].starts_at, tz)} · {clock(upcoming[0].est_at || upcoming[0].starts_at, tz)}</span>
          <span className="text-accent-ink/80"><bdi>{(lang === 'en' && upcoming[0].service_en) || upcoming[0].service}</bdi></span>
          <Pill tone={STATUS_TONE[upcoming[0].status]} className="ms-auto">{t(STATUS_LABEL[upcoming[0].status])}</Pill>
        </button>
      )}

      <div className="rail -mx-1 overflow-x-auto px-1"><Segmented label="patient-tab" value={tab} onChange={setTab} options={tabs} /></div>

      {!p.clinical && tab !== 'appointments' && (
        <p className="flex items-center gap-2 rounded-2xl bg-raised px-5 py-3 text-[13px] text-muted ring-1 ring-inset ring-border">
          <Lock className="size-4 shrink-0 text-faint" aria-hidden />{t('Medical records are for the doctors and nurses. You can see the patient’s details and appointments.')}
        </p>
      )}

      <div key={tab} className="c-fade">
        {tab === 'overview' && p.clinical && (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="grid min-w-0 items-start gap-5 md:grid-cols-2">
              <RecordList patientId={pt.id} table="allergies" rows={p.allergies || []} onChanged={refresh} />
              <RecordList patientId={pt.id} table="conditions" rows={p.conditions || []} onChanged={refresh} />
              <RecordList patientId={pt.id} table="medications" rows={p.medications || []} onChanged={refresh} />
              <RecordList patientId={pt.id} table="patient_history" rows={p.history || []} onChanged={refresh} />
            </div>
            <div className="min-w-0 space-y-5">
              <Vitals rows={p.vitals || []} />
              <Family p={p} />
              {pt.notes && <Card title={t('Notes for the team')}><p className="text-[13.5px] leading-relaxed"><bdi>{pt.notes}</bdi></p></Card>}
            </div>
          </div>
        )}
        {tab === 'overview' && !p.clinical && <Family p={p} />}
        {tab === 'visits' && p.clinical && <VisitNotes patientId={pt.id} encounters={p.encounters || []} templates={p.templates || []} onChanged={refresh} />}
        {tab === 'dental' && p.clinical && (
          <div className="space-y-5">
            <DentalChart patientId={pt.id} teeth={p.dental_chart || []} onChanged={refresh} onPlanTooth={(tooth, planned) => setDraftTooth({ tooth, planned })} />
            <Plans patientId={pt.id} plans={p.plans || []} onChanged={refresh} draftTooth={draftTooth} onDraftUsed={() => setDraftTooth(null)} />
          </div>
        )}
        {tab === 'files' && p.clinical && <Files p={p} />}
        {tab === 'appointments' && (
          <Card pad={false} title={t('Appointments')} sub={t('{n} in all', { n: p.appointments.length })}>
            {p.appointments.length === 0 ? <div className="p-4"><Empty>{t('No appointments yet.')}</Empty></div> : (
              <ul className="divide-y divide-rule">
                {p.appointments.map(a => (
                  <li key={a.id}>
                    <button onClick={() => setOpen(a)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5 text-start hover:bg-raised">
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-medium">{dateShort(a.est_at || a.starts_at, tz)} · {clock(a.est_at || a.starts_at, tz)}</span>
                        <span className="block truncate text-xs text-muted"><bdi>{(lang === 'en' && a.service_en) || a.service || '—'}</bdi>{a.price_text ? ` · ${a.price_text}` : ''}</span>
                      </span>
                      <Pill tone={STATUS_TONE[a.status]}>{t(STATUS_LABEL[a.status])}</Pill>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      <PatientForm open={edit} onClose={() => setEdit(false)} onSaved={refresh}
        initial={{ id: pt.id, full_name: pt.full_name, phone: pt.phone, sex: pt.sex, birth_date: pt.birth_date, national_id: pt.national_id, blood_group: pt.blood_group,
                   occupation: pt.occupation, address: pt.address, insurance: pt.insurance, notes: pt.notes }} />
      <ApptDrawer appt={open} onClose={() => setOpen(null)} onChanged={refresh} />
    </div>
  );
}

const RELATION: Record<string, string> = { self: 'Their own number', child: 'Parent’s number', parent: 'Child’s number', spouse: 'Spouse’s number', sibling: 'Sibling’s number', other: 'Family number' };
function Family({ p }: { p: Profile }) {
  const { t } = useLang();
  const { base } = useTenant();
  if (!p.contacts.length && !p.family.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Users className="size-4 text-faint" aria-hidden />{t('Contact and family')}</span>}>
      <ul className="space-y-2.5 text-[13.5px]">
        {p.contacts.map(c => (
          <li key={c.contact_id} className="flex items-center justify-between gap-3">
            <span className="min-w-0"><span className="block truncate"><bdi>{c.name || '—'}</bdi></span><span className="text-xs text-muted">{t(RELATION[c.relation] || RELATION.other)}</span></span>
            <bdi dir="ltr" className="shrink-0 tabular-nums text-muted">{fmtPhone(c.phone)}</bdi>
          </li>
        ))}
        {p.family.map(f => (
          <li key={f.id}><Link href={`${base}/patients/${f.id}`} className="text-gold-ink hover:underline"><bdi>{f.full_name}</bdi></Link> <span className="text-xs text-muted">· {t('same WhatsApp number')}</span></li>
        ))}
      </ul>
    </Card>
  );
}

const DOC_KIND: Record<string, string> = { lab: 'Lab result', imaging: 'X-ray or scan', prescription: 'Prescription', photo: 'Photo', report: 'Report', referral: 'Referral', other: 'File' };
function Files({ p }: { p: Profile }) {
  const { t } = useLang();
  const { tenant } = useTenant();
  const docs = p.documents || [];
  if (!docs.length) return <Empty>{t('No files yet. Photos and PDFs the patient sends on WhatsApp land here, read and summarised.')}</Empty>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {docs.map(d => (
        <article key={d.id} className="card p-4">
          <header className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-raised ring-1 ring-inset ring-border"><FileText className="size-4 text-muted" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium"><bdi>{d.title || t(DOC_KIND[d.kind] || 'File')}</bdi></p>
              <p className="text-xs text-muted">{t(DOC_KIND[d.kind] || 'File')} · {d.source === 'whatsapp' ? t('from WhatsApp') : t('uploaded')} · {dateShort(d.created_at, tenant.timezone)}</p>
            </div>
            {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-gold-ink hover:underline">{t('Open')}</a>}
          </header>
          {d.ai_summary && <p className="mt-3 text-[13px] leading-relaxed"><bdi>{d.ai_summary}</bdi></p>}
          {d.ai_values && d.ai_values.length > 0 && (
            <table className="mt-3 w-full text-[13px]">
              <tbody className="divide-y divide-rule">
                {d.ai_values.map((v, i) => (
                  <tr key={i}><td className="py-1.5" dir="ltr">{v.name}</td>
                    <td className={cx('py-1.5 text-end font-semibold tabular-nums', v.flag === 'high' || v.flag === 'low' ? 'text-critical' : '')} dir="ltr">{v.value} {v.unit}</td>
                    <td className="w-14 py-1.5 text-end text-xs">{v.flag === 'high' ? <Pill tone="critical">{t('high')}</Pill> : v.flag === 'low' ? <Pill tone="caution">{t('low')}</Pill> : null}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      ))}
    </div>
  );
}
