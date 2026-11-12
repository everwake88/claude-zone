import { redirect } from 'next/navigation';
import { currentUser, getT } from '@/lib/auth';
import { one } from '@/lib/db';
import { Mark } from '@/components/Mark';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function Login() {
  if (await currentUser()) redirect('/');
  const { t } = await getT();
  const s = await one<{ company_name: string }>('select company_name from salary.settings').catch(() => null);
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand" style={{ padding: 0 }}>
          <Mark size={36} />
          <div><div className="brand-name">{s?.company_name}</div><div className="brand-sub">{t('app.name')}</div></div>
        </div>
        <div>
          <h1>{t('login.title')}</h1>
          <p className="muted" style={{ marginTop: 6 }}>{t('login.sub')}</p>
        </div>
        <LoginForm w={{ email: t('login.email'), password: t('login.password'), submit: t('login.submit') }} />
      </div>
      <p className="powered login-foot">Powered by <b>Everwake</b></p>
    </div>
  );
}
