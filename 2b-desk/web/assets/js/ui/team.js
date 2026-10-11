// Supervisors and admins: the people who use the desk.
import { html, useEffect, useState } from '../lib/h.js';
import { useStore } from '../lib/store.js';
import { dayLabel, clock } from '../lib/time.js';
import { get, api, toast } from '../state.js';
import { Icon } from './icons.js';
import { Avatar, Modal, Empty } from './common.js';

const ROLE_HELP = {
  agent: 'Answers chats.',
  supervisor: 'Answers chats, sees Live and Reports, manages agents.',
  admin: 'Everything, including settings and other supervisors.',
};

function Secret({ title, text, username, password, onClose }) {
  const copy = () => navigator.clipboard?.writeText(`Username: ${username}\nPassword: ${password}`).then(
    () => toast({ tone: 'ok', icon: 'copy', title: 'Copied' }),
    () => {},
  );
  return html`<${Modal} title=${title} onClose=${onClose} footer=${html`<button class="btn primary" onClick=${onClose}>Done</button>`}>
    <p style=${{ margin: 0, color: 'var(--text-2)' }}>${text}</p>
    <div class="kv"><div><span>Username</span><b>${username}</b></div></div>
    <div class="secret"><span>${password}</span><button class="btn sm" onClick=${copy}><${Icon} name="copy" cls="sm" />Copy</button></div>
    <div class="callout warn"><${Icon} name="info" cls="sm" />This password is shown only once. They can change it from their menu after signing in.</div>
  <//>`;
}

function UserForm({ user, me, onClose, onSaved }) {
  const editing = !!user;
  const [f, setF] = useState({
    full_name: user?.full_name || '',
    employee_id: user?.employee_id || '',
    username: user?.username || '',
    role: user?.role || 'agent',
    max_chats: user?.max_chats ?? '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const roles = me.user.role === 'admin' ? ['agent', 'supervisor', 'admin'] : ['agent'];

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      full_name: f.full_name,
      employee_id: f.employee_id,
      username: f.username,
      role: f.role,
      max_chats: f.max_chats === '' ? null : Number(f.max_chats),
    };
    try {
      let res;
      if (editing) res = await api('PATCH', `/api/users/${user.id}`, body);
      else res = await api('POST', '/api/users', { ...body, password: f.password || undefined });
      onSaved(res, editing ? null : f.password ? null : res.password);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  return html`<${Modal} title=${editing ? `Edit ${user.full_name}` : 'Add a team member'} onClose=${onClose}
    subtitle=${editing ? null : 'They sign in with this username. Leave the password empty to generate one.'}
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${busy} onClick=${save}>${editing ? 'Save' : 'Add'}</button>`}>
    ${error ? html`<div class="login__error">${error}</div>` : null}
    <div class="form-grid">
      <label class="field"><span>Full name</span><input class="input" value=${f.full_name} onInput=${set('full_name')} dir="auto" /></label>
      <label class="field"><span>Employee ID</span><input class="input" placeholder="2B-014" value=${f.employee_id} onInput=${set('employee_id')} /></label>
      <label class="field"><span>Username</span><input class="input" autocapitalize="none" spellcheck="false" placeholder="nour.ali" value=${f.username} onInput=${set('username')} /></label>
      <label class="field"><span>Role</span>
        <select class="select" value=${f.role} onChange=${set('role')}>${roles.map((r) => html`<option value=${r}>${r[0].toUpperCase() + r.slice(1)}</option>`)}</select>
        <small>${ROLE_HELP[f.role]}</small>
      </label>
      <label class="field"><span>Max chats at once</span><input class="input" type="number" min="1" max="200" placeholder=${`Default (${me.settings.max_chats})`} value=${f.max_chats} onInput=${set('max_chats')} />
        <small>Leave empty for the team default.</small></label>
      ${!editing ? html`<label class="field"><span>Password</span><input class="input" type="text" autocomplete="new-password" placeholder="Generate one for me" value=${f.password} onInput=${set('password')} />
        <small>At least 8 characters.</small></label>` : null}
    </div>
  <//>`;
}

export function Team() {
  const me = useStore((s) => s.me);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null | 'new' | user
  const [secret, setSecret] = useState(null);
  const [q, setQ] = useState('');

  const load = () => get('/api/users').then((d) => setUsers(d.users), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const canManage = (u) => me.user.role === 'admin' || u.role === 'agent';

  async function resetPassword(u) {
    if (!confirm(`Reset ${u.full_name}'s password? They will be signed out and need the new one.`)) return;
    try {
      const res = await api('PATCH', `/api/users/${u.id}`, { reset_password: true });
      setSecret({ title: 'New password', text: `Give this to ${u.full_name}.`, username: u.username, password: res.password });
    } catch (err) {
      toast({ tone: 'hot', title: 'Could not reset', text: err.message });
    }
  }
  async function toggleActive(u) {
    if (u.is_active && !confirm(`Switch off ${u.full_name}? They are signed out and their chats go back to the team.`)) return;
    try {
      await api('PATCH', `/api/users/${u.id}`, { is_active: !u.is_active });
      load();
    } catch (err) {
      toast({ tone: 'hot', title: 'Could not change', text: err.message });
    }
  }

  const list = (users || []).filter((u) => !q || `${u.full_name} ${u.username} ${u.employee_id}`.toLowerCase().includes(q.toLowerCase()));
  const active = (users || []).filter((u) => u.is_active);

  return html`<div class="page"><div class="page__inner">
    <div class="page__head">
      <div style=${{ flex: 1 }}><h1>Team</h1><p>${active.length} active accounts · ${active.filter((u) => u.role === 'agent').length} agents</p></div>
      <div class="search"><${Icon} name="search" cls="sm" /><input class="input" placeholder="Search people" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      <button class="btn primary" onClick=${() => setForm('new')}><${Icon} name="userPlus" cls="sm" />Add person</button>
    </div>
    ${error ? html`<div class="callout warn">${error}</div>` : null}
    <section class="panel"><div class="panel__body table-wrap">
      ${users && !list.length ? html`<${Empty} icon="users" title="Nobody here yet">Add your agents to get started.</${Empty}>` : null}
      ${list.length ? html`<table class="t">
        <thead><tr><th>Person</th><th>Username</th><th>Role</th><th class="r">Max chats</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${list.map((u) => html`<tr key=${u.id} style=${u.is_active ? null : { opacity: 0.55 }}>
            <td><div class="who"><${Avatar} name=${u.full_name} size="sm" /><div><b dir="auto">${u.full_name}</b><small>${u.employee_id}</small></div></div></td>
            <td class="num">${u.username}</td>
            <td><span class=${`tag ${u.role === 'agent' ? '' : 'accent'}`}>${u.role}</span></td>
            <td class="r num">${u.max_chats ?? html`<span class="muted">${me.settings.max_chats}</span>`}</td>
            <td>${u.last_login ? `${dayLabel(u.last_login)} ${clock(u.last_login)}` : html`<span class="muted">Never</span>`}</td>
            <td>${u.is_active ? html`<span class="tag ok">Active</span>` : html`<span class="tag">Switched off</span>`}</td>
            <td class="r" style=${{ whiteSpace: 'nowrap' }}>
              ${canManage(u) ? html`
                <button class="btn ghost sm" onClick=${() => setForm(u)}>Edit</button>
                <button class="btn ghost sm" onClick=${() => resetPassword(u)}><${Icon} name="key" cls="sm" />Reset</button>
                ${u.id !== me.user.id ? html`<button class=${`btn ghost sm ${u.is_active ? 'danger' : ''}`} onClick=${() => toggleActive(u)}>${u.is_active ? 'Switch off' : 'Switch on'}</button>` : null}
              ` : null}
            </td>
          </tr>`)}
        </tbody>
      </table>` : null}
    </div></section>
    ${form ? html`<${UserForm} user=${form === 'new' ? null : form} me=${me} onClose=${() => setForm(null)}
      onSaved=${(res, generated) => {
        setForm(null);
        load();
        if (generated) setSecret({ title: 'Account created', text: `Give these to ${res.user.full_name}.`, username: res.user.username, password: generated });
        else toast({ tone: 'ok', icon: 'check', title: 'Saved' });
      }} />` : null}
    ${secret ? html`<${Secret} ...${secret} onClose=${() => setSecret(null)} />` : null}
  </div></div>`;
}
