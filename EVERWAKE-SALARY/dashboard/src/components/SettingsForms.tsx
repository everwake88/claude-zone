'use client';
import { useState } from 'react';
import { saveCompany, saveChannel, addMember, changePassword } from '@/app/actions';
import { ActionForm, Submit, FormStatus } from './Submit';

type W = Record<string, string>;

export function CompanyForm({ s, w }: { s: { company_name: string; agent_name: string; hr_contact: string; agent_enabled: boolean }; w: W }) {
  return (
    <ActionForm action={saveCompany} className="form">{(state) => (<>
      <div className="two">
        <div className="field"><label htmlFor="company_name">{w.companyName}</label><input className="input" id="company_name" name="company_name" defaultValue={s.company_name} required /></div>
        <div className="field"><label htmlFor="agent_name">{w.agentName}</label><input className="input" id="agent_name" name="agent_name" defaultValue={s.agent_name} aria-describedby="an-h" required /><span className="hint" id="an-h">{w.agentNameHint}</span></div>
      </div>
      <div className="field"><label htmlFor="hr_contact">{w.hrContact}</label><input className="input" id="hr_contact" name="hr_contact" defaultValue={s.hr_contact} aria-describedby="hc-h" /><span className="hint" id="hc-h">{w.hrContactHint}</span></div>
      <div className="switch-row">
        <div><div style={{ fontWeight: 500 }} id="ag-l">{w.agent}</div><div className="hint">{w.agentHint}</div></div>
        <span className="switch"><input type="checkbox" role="switch" name="agent_enabled" aria-labelledby="ag-l" defaultChecked={s.agent_enabled} /><span /></span>
      </div>
      <div className="form-foot"><Submit>{w.save}</Submit><FormStatus state={state} /></div>
    </>)}</ActionForm>
  );
}

export function ChannelForm({ c, webhook, w }: { c: { provider: string; base_url: string; instance: string; has_key: boolean }; webhook: string; w: W }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionForm action={saveChannel} className="form">{(state) => (<>
      <div className="field">
        <label htmlFor="provider">{w.provider}</label>
        <select className="select" id="provider" name="provider" defaultValue={c.provider}>
          <option value="evolution">{w.evolution}</option>
          <option value="cloud" disabled>{w.cloud}</option>
        </select>
      </div>
      <div className="two">
        <div className="field"><label htmlFor="base_url">{w.baseUrl}</label><input className="input ltr" id="base_url" name="base_url" type="url" placeholder="https://evo.example.com" defaultValue={c.base_url} /></div>
        <div className="field"><label htmlFor="instance">{w.instance}</label><input className="input ltr" id="instance" name="instance" defaultValue={c.instance} /></div>
      </div>
      <div className="field">
        <label htmlFor="api_key">{w.apiKey}</label>
        <input className="input ltr" id="api_key" name="api_key" type="password" autoComplete="off" placeholder={c.has_key ? '••••••••••••' : ''} aria-describedby="ak-h" />
        <span className="hint" id="ak-h">{w.apiKeyHint}</span>
      </div>
      <div className="field">
        <label htmlFor="webhook">{w.webhook}</label>
        <div className="copybox">
          <input className="input" id="webhook" readOnly value={webhook} aria-describedby="wh-h" />
          <button type="button" className="btn" onClick={async () => { await navigator.clipboard.writeText(webhook); setCopied(true); setTimeout(() => setCopied(false), 1600); }}>
            {copied ? w.copied : w.copy}
          </button>
        </div>
        <span className="hint" id="wh-h">{w.webhookHint}</span>
      </div>
      <div className="form-foot"><Submit>{w.save}</Submit><FormStatus state={state} /></div>
    </>)}</ActionForm>
  );
}

export function AddMemberForm({ w }: { w: W }) {
  return (
    <ActionForm action={addMember} className="form" resetOnOk>{(state) => (<>
      <div className="two">
        <div className="field"><label htmlFor="m_name">{w.name}</label><input className="input" id="m_name" name="name" required /></div>
        <div className="field"><label htmlFor="m_email">{w.email}</label><input className="input ltr" id="m_email" name="email" type="email" required /></div>
        <div className="field"><label htmlFor="m_role">{w.role}</label>
          <select className="select" id="m_role" name="role" defaultValue="hr"><option value="hr">{w.hr}</option><option value="admin">{w.admin}</option></select></div>
        <div className="field"><label htmlFor="m_pw">{w.tempPassword}</label><input className="input ltr" id="m_pw" name="password" type="text" minLength={10} required aria-describedby="pw-h" autoComplete="off" /><span className="hint" id="pw-h">{w.tempPasswordHint}</span></div>
      </div>
      <div className="form-foot"><Submit className="btn">{w.add}</Submit><FormStatus state={state} /></div>
    </>)}</ActionForm>
  );
}

export function PasswordForm({ w }: { w: W }) {
  return (
    <ActionForm action={changePassword} resetOnOk className="form" style={{ maxWidth: 420 }}>{(state) => (<>
      <div className="field"><label htmlFor="np">{w.newPassword}</label><input className="input ltr" id="np" name="password" type="password" minLength={10} required autoComplete="new-password" /></div>
      <div className="form-foot"><Submit className="btn">{w.change}</Submit><FormStatus state={state} /></div>
    </>)}</ActionForm>
  );
}
