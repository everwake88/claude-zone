import Link from 'next/link';
import { headers } from 'next/headers';
import { getT, requireUser } from '@/lib/auth';
import { q, one } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { dateTime } from '@/lib/format';
import { removeMember } from '../../actions';
import { CompanyForm, ChannelForm, AddMemberForm, PasswordForm } from '@/components/SettingsForms';
import type { Key } from '@/lib/i18n';
import { PageHeader } from '@/components/PageHeader';
import { Segmented } from '@/components/Segmented';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { t, lang } = await getT();
  const tab = (await searchParams).tab || 'company';
  const words = (keys: string[], prefix = 'st.') => Object.fromEntries(keys.map((k) => [k, t(`${prefix}${k}` as Key)]));
  const tabs = [['company', t('st.company')], ['whatsapp', t('st.whatsapp')], ['team', t('st.team')]] as const;

  let body: React.ReactNode = null;
  if (tab === 'whatsapp') {
    const c = await one<{ provider: string; base_url: string; instance: string; has_key: boolean; webhook_token: string }>(
      `select provider, base_url, instance, api_key <> '' as has_key, webhook_token from salary.channel`);
    const h = await headers();
    const base = (process.env.N8N_BASE_URL || `https://n8n.${h.get('host') ?? 'example.com'}`).replace(/\/+$/, '');
    body = (
      <section className="section">
        <header><h2>{t('st.whatsapp')}</h2><p>{t('st.webhookHint')}</p></header>
        <div className="panel"><div className="panel-body" style={{ paddingTop: 20 }}>
          <ChannelForm c={c!} webhook={`${base}/webhook/everwake-salary?token=${c!.webhook_token}`}
            w={words(['provider', 'evolution', 'cloud', 'baseUrl', 'instance', 'apiKey', 'apiKeyHint', 'webhook', 'webhookHint', 'copy', 'copied', 'save'])} />
        </div></div>
      </section>
    );
  } else if (tab === 'team') {
    const members = await q<{ id: string; name: string; email: string; role: string; last_login_at: string | null }>(
      `select id, name, email, role, last_login_at from salary.hr_users where active order by created_at`);
    body = (
      <>
        <section className="section">
          <header><h2>{t('st.members')}</h2><p>{user.role === 'admin' ? t('st.tempPasswordHint') : t('st.adminOnly')}</p></header>
          <div className="panel"><div className="panel-body" style={{ paddingTop: 12 }}>
            <table className="t collapse">
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td><span style={{ fontWeight: 500 }}>{m.name || m.email}</span>{m.id === user.uid && <span className="muted"> ({t('st.you')})</span>}
                      <div className="small muted ltr" style={{ textAlign: 'start' }}>{m.email}</div></td>
                    <td><span className="pill">{m.role === 'admin' ? t('st.admin') : t('st.hr')}</span></td>
                    <td data-l2 className="small muted">{dateTime(lang, m.last_login_at)}</td>
                    <td className="num">{user.role === 'admin' && m.id !== user.uid && (
                      <form action={removeMember}><input type="hidden" name="id" value={m.id} /><button className="btn sm danger" type="submit">{t('st.remove')}</button></form>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </section>
        {user.role === 'admin' && (
          <section className="section">
            <header><h2>{t('st.addMember')}</h2><p>{t('st.tempPasswordHint')}</p></header>
            <div className="panel"><div className="panel-body" style={{ paddingTop: 20 }}>
              <AddMemberForm w={{ ...words(['name', 'role', 'admin', 'hr', 'tempPassword', 'tempPasswordHint', 'add']), email: t('login.email') }} />
            </div></div>
          </section>
        )}
        <section className="section">
          <header><h2>{t('st.myPassword')}</h2></header>
          <div className="panel"><div className="panel-body" style={{ paddingTop: 20 }}><PasswordForm w={words(['newPassword', 'change'])} /></div></div>
        </section>
      </>
    );
  } else {
    const s = await getSettings();
    body = (
      <section className="section">
        <header><h2>{t('st.company')}</h2><p>{t('st.companySub')}</p></header>
        <div className="panel"><div className="panel-body" style={{ paddingTop: 20 }}>
          <CompanyForm s={s} w={words(['companyName', 'agentName', 'agentNameHint', 'hrContact', 'hrContactHint', 'agent', 'agentHint', 'save'])} />
        </div></div>
      </section>
    );
  }

  return (
    <div className="page">
      <PageHeader title={t('st.title')} />
      <div className="rise" style={{ ['--i' as string]: 1 }}>
        <Segmented label={t('st.title')} current={tab} options={tabs.map(([k, label]) => ({ key: k, href: `/settings?tab=${k}`, label }))} />
      </div>
      <div className="rise" style={{ ['--i' as string]: 2 }}>{body}</div>
    </div>
  );
}
