'use client';
import { CalendarDays, Check, MessageCircle, Phone, Settings2, Sparkles, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Badge, Button, Card, Checkbox, Drawer, Empty, Field, Input, Modal, PageHeader, Spinner, Tabs, Textarea, useAction } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Reservation, ReservationStatus, Settings } from '@/lib/types';

type Tab = 'waiting' | 'upcoming' | 'past';
const STATUS: Record<ReservationStatus, { label: string; tone: 'positive' | 'neutral' | 'caution' | 'critical' }> = {
  requested: { label: 'Waiting for you', tone: 'caution' }, confirmed: { label: 'Confirmed', tone: 'positive' },
  declined: { label: 'Declined', tone: 'critical' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
  seated: { label: 'Arrived', tone: 'positive' }, no_show: { label: 'Did not come', tone: 'critical' }
};
const local = (p: string | null) => (!p ? '' : p.startsWith('20') && p.length === 12 ? '0' + p.slice(2) : '+' + p);
const isoDay = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

// Table bookings: the requests the agent sent after the customer said yes to
// the summary. The team calls the customer, then presses Confirm — that is
// when the customer hears on WhatsApp that the table is theirs.
export default function Reservations() {
  const { tenant, base, can } = useTenant();
  const { t, lang } = useLang();
  const { busy, run } = useAction();
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tab, setTab] = useState<Tab>('waiting');
  const [decide, setDecide] = useState<{ r: Reservation; status: 'declined' | 'cancelled' } | null>(null);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [rules, setRules] = useState(false);
  const tz = tenant.timezone || 'Africa/Cairo';

  const load = useCallback(async () => {
    const { data } = await sb().from('reservations').select('*').eq('tenant_id', tenant.id).neq('status', 'draft')
      .gte('reserved_for', new Date(Date.now() - 30 * 864e5).toISOString()).order('reserved_for');
    setRows((data || []) as Reservation[]);
  }, [tenant.id]);
  useEffect(() => {
    load();
    sb().from('branches').select('*').eq('tenant_id', tenant.id).order('sort').then(({ data }) => setBranches((data || []) as Branch[]));
    const db = sb();
    const ch = db.channel('reservations-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'reservations', filter: `tenant_id=eq.${tenant.id}` }, () => load())
      .subscribe();
    const id = setInterval(load, 60000);
    return () => { db.removeChannel(ch); clearInterval(id); };
  }, [tenant.id, load]);

  const setStatus = (r: Reservation, status: ReservationStatus, opts: { note?: string; notify?: boolean } = {}) => run(async () => {
    const { data, error } = await sb().rpc('set_reservation_status', { p_id: r.id, p_status: status, p_note: opts.note || null, p_notify: opts.notify ?? true });
    if (error) throw new Error(error.message);
    if ((data as { notified?: boolean })?.notified) await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
    setDecide(null); setNote('');
    await load();
  }, status === 'confirmed' ? t('Confirmed — {name} gets it on WhatsApp', { name: r.full_name || local(r.phone) })
    : status === 'seated' ? t('Marked as arrived') : status === 'no_show' ? t('Marked as did not come') : t('Saved'));

  const groups = useMemo(() => {
    if (!rows) return null;
    const now = Date.now();
    const pick: Record<Tab, Reservation[]> = {
      waiting: rows.filter(r => r.status === 'requested'),
      upcoming: rows.filter(r => r.status === 'confirmed' && new Date(r.reserved_for).getTime() > now - 3 * 3600e3),
      past: rows.filter(r => !(r.status === 'requested' || (r.status === 'confirmed' && new Date(r.reserved_for).getTime() > now - 3 * 3600e3))).reverse()
    };
    return pick;
  }, [rows]);

  if (!rows || !groups) return <Spinner />;
  const taking = branches.filter(b => b.is_active && b.reservations === 'whatsapp');
  const byPhone = branches.filter(b => b.is_active && b.reservations === 'phone');
  const branchName = (id: string | null) => branches.find(b => b.id === id)?.name_ar || '';
  const today = isoDay(new Date(), tz), tomorrow = isoDay(new Date(Date.now() + 864e5), tz);
  const dayLabel = (d: string) => {
    const name = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' })
      .format(new Date(d + 'T12:00:00Z'));
    return d === today ? `${t('Today')} · ${name}` : d === tomorrow ? `${t('Tomorrow')} · ${name}` : name;
  };
  const time12 = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? t('AM') : t('PM')}`;
  };
  const list = groups[tab];
  const days = [...new Set(list.map(r => r.reserve_date))];

  return (
    <div className="space-y-5">
      <PageHeader title={t('Table bookings')}
        subtitle={t('Booking requests the agent took on WhatsApp. Call the customer, then press Confirm — they get the confirmation on WhatsApp.')}
        actions={can.edit && <Button variant="outline" onClick={() => setRules(true)}><Settings2 className="size-4" /> {t('Booking rules')}</Button>} />
      <PageGuide id="reservations" steps={[
          t('A booking the agent took arrives here and on the branch’s WhatsApp as a request — it is not confirmed yet.'),
          t('Call the customer if you need to, then press Confirm or Decline. They get your answer on WhatsApp.'),
          t('On the day, mark them Arrived or Did not come.'),
          t('Which branches take bookings, and how: Branches → a branch → Table bookings. The rules (how far ahead, group size): Booking rules, above.')
        ]} />

      {taking.length === 0 && (
        <Card>
          <p className="text-sm">
            {byPhone.length
              ? t('The agent gives the phone number of branches that book by phone. To let it take bookings itself, open a branch and choose “On WhatsApp”.')
              : t('No branch takes table bookings on WhatsApp yet. Open a branch and choose how it takes bookings.')}{' '}
            <Link href={`${base}/branches`} className="text-gold-ink underline">{t('Branches')}</Link>
          </p>
        </Card>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'waiting', label: <span className="flex items-center gap-1.5">{t('Waiting for you')}{groups.waiting.length > 0 && <span className="rounded-full bg-gold px-1.5 text-xs font-semibold text-navy">{groups.waiting.length}</span>}</span> },
        { value: 'upcoming', label: t('Confirmed') },
        { value: 'past', label: t('Past') }
      ]} />

      {list.length === 0
        ? <Empty title={tab === 'waiting' ? t('No requests waiting') : tab === 'upcoming' ? t('No confirmed bookings coming up') : t('Nothing in the last 30 days')}>
            {tab === 'waiting' && taking.length > 0 ? t('When a customer books on WhatsApp, the request appears here and on the branch’s WhatsApp for new-order tickets.') : null}
          </Empty>
        : days.map(d => (
          <section key={d} className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted"><CalendarDays className="size-4" /> {dayLabel(d)}</h2>
            <div className="grid gap-3 lg:grid-cols-2">
              {list.filter(r => r.reserve_date === d).map(r => (
                <Card key={r.id} className={r.status === 'requested' ? 'border-gold' : ''}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xl font-semibold tabular-nums">{time12(r.reserve_time)}</p>
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                        <span className="flex items-center gap-1"><Users className="size-3.5" /> {t('{n} people', { n: r.guests })}</span>
                        {branches.length > 1 && <span dir="rtl">{branchName(r.branch_id)}</span>}
                        <span className="font-mono text-xs">{r.ref_no}</span>
                      </p>
                    </div>
                    <Badge tone={STATUS[r.status].tone}>{t(STATUS[r.status].label)}</Badge>
                  </div>
                  <div className="mt-3 space-y-1.5 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" dir="auto">{r.full_name || t('No name')}</span>
                      {r.phone && <a href={`tel:${local(r.phone)}`} className="inline-flex items-center gap-1 text-gold-ink hover:underline" dir="ltr"><Phone className="size-3.5" /> {local(r.phone)}</a>}
                    </p>
                    {r.occasion && <p className="flex items-center gap-1.5" dir="auto"><Sparkles className="size-3.5 text-gold" /> {r.occasion}</p>}
                    {r.requests && <p className="rounded-lg bg-paper px-3 py-2" dir="auto">{r.requests}</p>}
                    {r.decline_reason && ['declined', 'cancelled'].includes(r.status) && <p className="text-xs text-muted" dir="auto">{t('Reason')}: {r.decline_reason}</p>}
                    <p className="text-xs text-muted">{t('Asked {ago} on WhatsApp', { ago: timeAgo(r.requested_at || r.created_at) })}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                    {r.status === 'requested' && <>
                      <Button size="sm" variant="gold" busy={busy} onClick={() => setStatus(r, 'confirmed')}><Check className="size-4" /> {t('Confirm')}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setNotify(true); setDecide({ r, status: 'declined' }); }}><X className="size-4" /> {t('Decline')}</Button>
                    </>}
                    {r.status === 'confirmed' && <>
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => setStatus(r, 'seated')}>{t('Arrived')}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setStatus(r, 'no_show')}>{t('Did not come')}</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setNotify(true); setDecide({ r, status: 'cancelled' }); }}>{t('Cancel')}</Button>
                    </>}
                    <span className="flex-1" />
                    {r.conversation_id && <Link href={`${base}/inbox?c=${r.conversation_id}`}><Button size="sm" variant="ghost"><MessageCircle className="size-4" /> {t('Open the chat')}</Button></Link>}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ))}

      <Modal open={!!decide} onClose={() => setDecide(null)}
        title={decide?.status === 'declined' ? t('Decline booking {ref}', { ref: decide?.r.ref_no }) : t('Cancel booking {ref}', { ref: decide?.r.ref_no })}
        footer={<><Button variant="outline" onClick={() => setDecide(null)}>{t('Back')}</Button>
          <Button variant="gold" busy={busy} onClick={() => decide && setStatus(decide.r, decide.status, { note, notify })}>
            {decide?.status === 'declined' ? t('Decline') : t('Cancel the booking')}</Button></>}>
        <div className="space-y-3">
          <Field label={t('Reason, for the customer (optional)')} hint={t('e.g.') + ' الفرع محجوز بالكامل الساعة دي'}>
            <Textarea dir="rtl" rows={2} value={note} onChange={e => setNote(e.target.value)} />
          </Field>
          <Checkbox checked={notify} onChange={setNotify} label={t('Tell the customer on WhatsApp')} />
          {decide?.status === 'declined' && <p className="text-xs text-muted">{t('The message offers to look at another time, and the agent picks it up from there.')}</p>}
        </div>
      </Modal>

      {can.edit && <BookingRules open={rules} onClose={() => setRules(false)} />}
    </div>
  );
}

// the restaurant's rules the agent checks every booking against
function BookingRules({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { row, save, busy } = useTenantRow();
  const { t } = useLang();
  const [s, setS] = useState<{ max: string; lead: string; ahead: string; occasions: string }>({ max: '', lead: '', ahead: '', occasions: '' });
  useEffect(() => {
    if (!row) return;
    const x = (row.settings || {}) as Settings;
    setS({ max: x.reservation_max_guests ? String(x.reservation_max_guests) : '', lead: x.reservation_lead_minutes != null ? String(x.reservation_lead_minutes) : '',
           ahead: x.reservation_days_ahead ? String(x.reservation_days_ahead) : '', occasions: (x.reservation_occasions || []).join('، ') });
  }, [row]);
  const submit = async () => {
    if (!row) return;
    const n = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Math.round(Number(v))));
    const occasions = s.occasions.split(/[,،\n]+/).map(x => x.trim()).filter(Boolean);
    const next: Settings = { ...(row.settings as Settings), reservation_max_guests: n(s.max), reservation_lead_minutes: n(s.lead),
                             reservation_days_ahead: n(s.ahead), reservation_occasions: occasions.length ? occasions : undefined };
    if (await save({ settings: next })) onClose();
  };
  return (
    <Drawer open={open} onClose={onClose} title={t('Booking rules')} footer={<Button variant="gold" busy={busy} onClick={submit}>{t('Save')}</Button>}>
      {!row ? <Spinner /> : (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('The agent checks every booking against these, and against the branch’s opening hours. Whether a branch takes bookings is set on the branch.')}</p>
          <Field label={t('Largest group the agent books')} hint={t('Bigger groups are passed to the team. A branch can set its own. Empty = 20.')}>
            <Input type="number" min={1} value={s.max} onChange={e => setS({ ...s, max: e.target.value })} placeholder="20" />
          </Field>
          <Field label={t('Book at least (minutes ahead)')} hint={t('Empty = 60.')}>
            <Input type="number" min={0} value={s.lead} onChange={e => setS({ ...s, lead: e.target.value })} placeholder="60" />
          </Field>
          <Field label={t('Book up to (days ahead)')} hint={t('Empty = 30.')}>
            <Input type="number" min={1} value={s.ahead} onChange={e => setS({ ...s, ahead: e.target.value })} placeholder="30" />
          </Field>
          <Field label={t('Occasions people book for')} hint={t('Comma separated, in Arabic. The agent may mention them; the customer never has to pick one.')}>
            <Input dir="rtl" value={s.occasions} onChange={e => setS({ ...s, occasions: e.target.value })} placeholder="عيد ميلاد، عيد جواز، خطوبة، اجتماع عمل، عزومة عائلية" />
          </Field>
        </div>
      )}
    </Drawer>
  );
}
