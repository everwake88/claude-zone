'use client';
import { ArrowLeft, Lock } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useLang } from '@/lib/i18n';
import { PageTitle } from '../ui';
import { useTenant } from '../tenant';
import { AgentSection, BookingSection, BrandSection, ClinicSection, MessagesSection } from './ClinicSettings';
import { DoctorsSection, LocationsSection, SchedulesSection, TeamSection, WhatsAppSection } from './PeopleSettings';
import { SETTINGS_SECTIONS } from './sections';

const BODY: Record<string, () => React.ReactElement> = {
  clinic: ClinicSection, agent: AgentSection, doctors: DoctorsSection, locations: LocationsSection, schedules: SchedulesSection,
  booking: BookingSection, messages: MessagesSection, whatsapp: WhatsAppSection, team: TeamSection, brand: BrandSection
};

export function SettingsSection({ section }: { section: string }) {
  const { base, can } = useTenant();
  const { t } = useLang();
  const s = SETTINGS_SECTIONS.find(x => x.key === section);
  if (!s) notFound();
  const Body = BODY[s.key];
  const allowed = s.need === 'owner' ? can.owner || (s.key === 'whatsapp' && can.edit) : can.edit;
  return (
    <div className="mx-auto max-w-4xl">
      <Link href={`${base}/settings`} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t('Settings')}</Link>
      <PageTitle title={t(s.label)} finding={t(s.sub)} />
      {allowed || s.key === 'team' ? <Body /> : (
        <p className="flex items-center gap-2 rounded-[10px] bg-raised px-4 py-3 text-[13.5px] text-muted ring-1 ring-inset ring-border">
          <Lock className="size-4 text-faint" aria-hidden />{t('Only the clinic’s owner, managers and doctors change this.')}
        </p>
      )}
    </div>
  );
}
