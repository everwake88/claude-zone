import { getT } from '@/lib/auth';
import { getSettings } from '@/lib/settings';
import { IdentityForm } from '@/components/IdentityForm';
import type { Key } from '@/lib/i18n';
import { PageHeader } from '@/components/PageHeader';

export default async function Identity() {
  const { t } = await getT();
  const s = await getSettings();
  const keys = ['ask', 'full_name', 'full_nameHint', 'national_id', 'national_idHint', 'work_id', 'work_idHint', 'phone', 'phoneHint', 'needOne',
    'match', 'matchHint', 'hiddenAsk', 'hiddenAskHint', 'p.hiddenNote', 'formats', 'minWords', 'digitsOnly', 'wid', 'from', 'to', 'hours', 'hoursHint', 'save', 'preview', 'previewSub', 'p.matchNote'];
  const w = Object.fromEntries(keys.map((k) => [k.replace('p.', ''), t(`id.${k}` as Key)]));
  // the preview is the agent's own language (Egyptian Arabic), whatever language the dashboard is in
  const p: Record<string, string> = {
    ask: t('id.p.ask'), hello: t('id.p.hello', { agent: s.agent_name, company: s.company_name }),
    full_name: t('id.p.full_name'), national_id: t('id.p.national_id'), work_id: t('id.p.work_id'), phone: t('id.p.phone'),
    badId: t('id.p.badId'), ok: t('id.p.ok', { first: 'أحمد' }),
    a_full_name: 'أحمد محمد عبد الله السيد', a_national_id: '29001150101234', a_work_id: '1023', a_phone: '01001234567'
  };
  const { ask_full_name, ask_national_id, ask_work_id, ask_phone, phone_must_match_sender, hidden_number_ask_phone, name_min_words, work_id_digits_only,
          work_id_min_length, work_id_max_length, verified_hours } = s;
  return (
    <div className="page">
      <PageHeader title={t('id.title')} sub={t('id.sub')} />
      <IdentityForm w={w} p={p} initial={{ ask_full_name, ask_national_id, ask_work_id, ask_phone, phone_must_match_sender, hidden_number_ask_phone, name_min_words,
        work_id_digits_only, work_id_min_length, work_id_max_length, verified_hours }} />
    </div>
  );
}
