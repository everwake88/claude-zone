'use client';
import { login } from '@/app/actions';
import { ActionForm, Submit, FormStatus } from './Submit';

export function LoginForm({ w }: { w: { email: string; password: string; submit: string } }) {
  return (
    <ActionForm action={login} className="form">{(state) => (<>
      <div className="field"><label htmlFor="email">{w.email}</label><input className="input ltr" id="email" name="email" type="email" autoComplete="username" required autoFocus /></div>
      <div className="field"><label htmlFor="password">{w.password}</label><input className="input ltr" id="password" name="password" type="password" autoComplete="current-password" required /></div>
      <FormStatus state={state} />
      <Submit>{w.submit}</Submit>
    </>)}</ActionForm>
  );
}
