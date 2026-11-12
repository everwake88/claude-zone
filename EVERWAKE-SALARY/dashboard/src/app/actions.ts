'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { pool, q, one } from '@/lib/db';
import { COOKIE, MAX_AGE, sign } from '@/lib/session';
import { requireUser, getT } from '@/lib/auth';
import { readWorkbook, guessIdentity, type Column } from '@/lib/excel';
import { sendWhatsApp } from '@/lib/whatsapp';
import { periodLabel } from '@/lib/i18n';

// compared against when the email has no account, so a wrong email takes as long as a wrong password
const NO_ACCOUNT_HASH = bcrypt.hashSync('no account', 10);

export type FormState = { ok?: boolean; error?: string; message?: string } | null;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const bool = (fd: FormData, k: string) => fd.get(k) === 'on' || fd.get(k) === 'true';
const int = (fd: FormData, k: string, d: number) => { const n = parseInt(str(fd, k), 10); return Number.isFinite(n) ? n : d; };

// ---- sign in / out, language ---------------------------------------------------------------
export async function login(_: FormState, fd: FormData): Promise<FormState> {
  const { t } = await getT();
  const email = str(fd, 'email').toLowerCase();
  const u = await one<{ id: string; name: string; email: string; role: 'admin' | 'hr'; password_hash: string }>(
    'select id, name, email, role, password_hash from salary.hr_users where lower(email) = $1 and active', [email]);
  // the same work whether or not the account exists, so the answer time says nothing
  const ok = await bcrypt.compare(str(fd, 'password'), u?.password_hash ?? NO_ACCOUNT_HASH);
  if (!u || !ok) return { error: t('login.wrong') };
  await q('update salary.hr_users set last_login_at = now() where id = $1', [u.id]);
  (await cookies()).set(COOKIE, await sign({ uid: u.id, name: u.name, email: u.email, role: u.role }),
    { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: MAX_AGE });
  redirect('/');
}
export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}
export async function setLanguage(fd: FormData) {
  (await cookies()).set('lang', str(fd, 'lang') === 'en' ? 'en' : 'ar', { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  const back = str(fd, 'back');
  redirect(back.startsWith('/') ? back : '/');
}

// ---- payroll sheets ----------------------------------------------------------------------------
const HIDDEN_BY_DEFAULT = ['national_id', 'phone'];

export async function uploadSheet(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { t, lang } = await getT();
  const file = fd.get('file');
  const period = str(fd, 'period');                 // "2026-10"
  if (!(file instanceof File) || file.size === 0) return { error: t('err.noFile') };
  if (file.size > 4 * 1024 * 1024) return { error: t('err.tooBig') };
  if (!/^\d{4}-\d{2}$/.test(period)) return { error: t('err.noPeriod') };

  let parsed;
  try { parsed = await readWorkbook(Buffer.from(await file.arrayBuffer()), file.name); }
  catch (e) { return { error: e instanceof Error && e.message === 'no-rows' ? t('err.noRows') : t('err.badFile') }; }

  const identity = guessIdentity(parsed);
  const hidden = new Set(HIDDEN_BY_DEFAULT.map((f) => identity[f as keyof typeof identity]).filter(Boolean));
  const columns: Column[] = parsed.columns.map((c) => ({ ...c, visible: !hidden.has(c.key) }));
  const title = str(fd, 'title') || `${lang === 'ar' ? 'مرتبات' : 'Salaries'} ${periodLabel(lang, period)}`;

  const client = await pool.connect();
  let id: string;
  try {
    await client.query('begin');
    const r = await client.query<{ id: string }>(
      `insert into salary.payroll_sheets (period, title, file_name, sheet_name, columns, identity, uploaded_by)
       values ($1::date, $2, $3, $4, $5::jsonb, $6::jsonb, $7) returning id`,
      [`${period}-01`, title, file.name, parsed.sheetName, JSON.stringify(columns), JSON.stringify(identity), user.uid]);
    id = r.rows[0].id;
    await client.query(
      `insert into salary.payroll_rows (sheet_id, row_no, cells)
       select $1, x.row_no, x.cells from jsonb_to_recordset($2::jsonb) as x(row_no int, cells jsonb)`,
      [id, JSON.stringify(parsed.rows.map((r) => ({ row_no: r.rowNo, cells: r.cells })))]);
    await client.query('select salary.index_sheet($1)', [id]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    console.error(e);
    return { error: t('err.generic') };
  } finally { client.release(); }
  redirect(`/sheets/${id}`);
}

export async function saveSheet(_: FormState, fd: FormData): Promise<FormState> {
  await requireUser();
  const { t } = await getT();
  const id = str(fd, 'id');
  const sheet = await one<{ columns: Column[] }>('select columns from salary.payroll_sheets where id = $1', [id]);
  if (!sheet) return { error: t('err.generic') };
  const identity: Record<string, string> = {};
  for (const f of ['full_name', 'national_id', 'work_id', 'phone']) {
    const k = str(fd, `id_${f}`);
    if (k && sheet.columns.some((c) => c.key === k)) identity[f] = k;
  }
  const columns = sheet.columns.map((c) => ({ ...c, visible: bool(fd, `show_${c.key}`) }));
  await q('update salary.payroll_sheets set identity = $2::jsonb, columns = $3::jsonb, title = coalesce(nullif($4, \'\'), title) where id = $1',
    [id, JSON.stringify(identity), JSON.stringify(columns), str(fd, 'title')]);
  await q('select salary.index_sheet($1)', [id]);
  revalidatePath(`/sheets/${id}`);
  return { ok: true, message: t('sd.saved') };
}

export async function publishSheet(_: FormState, fd: FormData): Promise<FormState> {
  await requireUser();
  const { t } = await getT();
  const id = str(fd, 'id');
  const r = await one<{ r: { ok: boolean; error?: string } }>('select salary.publish_sheet($1) as r', [id]);
  if (!r?.r.ok) return { error: r?.r.error === 'choose the national ID column or the work ID column first' ? t('sd.needId') : t('err.generic') };
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteSheet(_: FormState, fd: FormData): Promise<FormState> {
  await requireUser();
  const { t } = await getT();
  const id = str(fd, 'id');
  const sheet = await one<{ period: string }>('select period from salary.payroll_sheets where id = $1', [id]);
  if (!sheet) return { error: t('err.generic') };
  if (str(fd, 'confirm') !== sheet.period.slice(0, 7)) return { error: t('sd.deleteConfirm', { month: sheet.period.slice(0, 7) }) };
  await q('delete from salary.payroll_sheets where id = $1', [id]);
  revalidatePath('/', 'layout');
  redirect('/sheets');
}

// ---- identity check ------------------------------------------------------------------------
export async function saveIdentity(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { t } = await getT();
  const nid = bool(fd, 'ask_national_id'), wid = bool(fd, 'ask_work_id');
  if (!nid && !wid) return { error: t('id.needOne') };
  const min = Math.min(30, Math.max(1, int(fd, 'work_id_min_length', 1)));
  const max = Math.min(40, Math.max(min, int(fd, 'work_id_max_length', 20)));
  await q(`update salary.settings set ask_full_name = $1, ask_national_id = $2, ask_work_id = $3, ask_phone = $4,
             phone_must_match_sender = $5, name_min_words = $6, work_id_digits_only = $7, work_id_min_length = $8,
             work_id_max_length = $9, verified_hours = $10, updated_at = now(), updated_by = $11,
             -- the fallback only means something while the match is on; switching the match off keeps it as it was
             hidden_number_ask_phone = case when $5 then $12 else hidden_number_ask_phone end`,
    [bool(fd, 'ask_full_name'), nid, wid, bool(fd, 'ask_phone'), bool(fd, 'phone_must_match_sender'),
     Math.min(6, Math.max(1, int(fd, 'name_min_words', 3))), bool(fd, 'work_id_digits_only'), min, max,
     Math.min(720, Math.max(0, int(fd, 'verified_hours', 24))), user.uid, bool(fd, 'hidden_number_ask_phone')]);
  revalidatePath('/', 'layout');
  return { ok: true, message: t('id.saved') };
}

// ---- settings --------------------------------------------------------------------------------
export async function saveCompany(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { t } = await getT();
  await q(`update salary.settings set company_name = coalesce(nullif($1, ''), company_name), agent_name = coalesce(nullif($2, ''), agent_name),
             hr_contact = $3, agent_enabled = $4, updated_at = now(), updated_by = $5`,
    [str(fd, 'company_name'), str(fd, 'agent_name'), str(fd, 'hr_contact'), bool(fd, 'agent_enabled'), user.uid]);
  revalidatePath('/', 'layout');
  return { ok: true, message: t('st.saved') };
}
export async function saveChannel(_: FormState, fd: FormData): Promise<FormState> {
  await requireUser();
  const { t } = await getT();
  const url = str(fd, 'base_url');
  if (url && !/^https?:\/\//.test(url)) return { error: 'https://…' };
  await q(`update salary.channel set provider = $1, base_url = $2, instance = $3,
             api_key = coalesce(nullif($4, ''), api_key), updated_at = now()`,
    [str(fd, 'provider') === 'cloud' ? 'cloud' : 'evolution', url.replace(/\/+$/, ''), str(fd, 'instance'), str(fd, 'api_key')]);
  revalidatePath('/settings');
  return { ok: true, message: t('st.saved') };
}
export async function addMember(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { t } = await getT();
  if (user.role !== 'admin') return { error: t('st.adminOnly') };
  const password = str(fd, 'password');
  if (password.length < 10) return { error: t('err.short') };
  try {
    await q('insert into salary.hr_users (email, name, role, password_hash) values ($1, $2, $3, $4)',
      [str(fd, 'email').toLowerCase(), str(fd, 'name'), str(fd, 'role') === 'admin' ? 'admin' : 'hr', await bcrypt.hash(password, 10)]);
  } catch { return { error: t('err.exists') }; }
  revalidatePath('/settings');
  return { ok: true, message: t('st.saved') };
}
export async function removeMember(fd: FormData) {
  const user = await requireUser();
  if (user.role !== 'admin' || str(fd, 'id') === user.uid) return;
  await q('update salary.hr_users set active = false where id = $1', [str(fd, 'id')]);
  revalidatePath('/settings');
}
export async function changePassword(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { t } = await getT();
  const password = str(fd, 'password');
  if (password.length < 10) return { error: t('err.short') };
  await q('update salary.hr_users set password_hash = $2 where id = $1', [user.uid, await bcrypt.hash(password, 10)]);
  return { ok: true, message: t('st.saved') };
}

// ---- disputes ----------------------------------------------------------------------------------
export async function replyDispute(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const { t } = await getT();
  const text = str(fd, 'text');
  const d = await one<{ conversation_id: string; reply_to: string }>(
    `select d.conversation_id, c.reply_to from salary.disputes d join salary.conversations c on c.id = d.conversation_id where d.id = $1`, [str(fd, 'id')]);
  if (!d || !text) return { error: t('err.generic') };
  const sent = await sendWhatsApp(d.reply_to, text);
  if (!sent.ok) return { error: t('dp.sendFailed', { e: sent.error }) };
  await q(`insert into salary.messages (conversation_id, direction, author, text, external_id, hr_user_id)
           values ($1, 'out', 'hr', $2, $3, $4)
           on conflict (external_id) where external_id is not null do update set author = 'hr', hr_user_id = excluded.hr_user_id`,
    [d.conversation_id, text, sent.id, user.uid]);
  revalidatePath('/disputes');
  return { ok: true, message: t('dp.sent') };
}
export async function resolveDispute(fd: FormData) {
  const user = await requireUser();
  const reopen = str(fd, 'reopen') === '1';
  await q(`update salary.disputes set status = $2, hr_note = coalesce(nullif($3, ''), hr_note),
             resolved_by = case when $2 = 'resolved' then $4::uuid end, resolved_at = case when $2 = 'resolved' then now() end
           where id = $1`, [str(fd, 'id'), reopen ? 'open' : 'resolved', str(fd, 'note'), user.uid]);
  revalidatePath('/', 'layout');
}
