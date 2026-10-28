// A local stand-in for the parts of Supabase the dashboard uses, so the real
// dashboard runs on a plain Postgres for filming the launch video:
//
//   /auth/v1      one demo user, any password
//   /rest/v1      the slice of PostgREST the dashboard calls, run as the
//                 signed-in user so row level security applies as on Supabase
//   /storage/v1   files on disk
//   /realtime/v1  database changes pushed to open pages (new orders ring)
//
// FOR FILMING ONLY: one user, no passwords, a fixed secret, no realtime RLS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const PORT = +process.env.PORT || 54321;
const DB = process.env.DATABASE_URL || 'postgres://postgres@localhost/everwake?host=/tmp&port=5433';
const FILES = process.env.STORAGE_DIR || path.resolve('storage');
const SECRET = 'local-filming-secret-not-for-production';
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'demo@everwake.tech' };

const pool = new pg.Pool({ connectionString: DB, max: 12 });

// ── tokens ───────────────────────────────────────────────────────────────
const b64u = (s) => Buffer.from(s).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function sign(claims) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claims));
  return head + '.' + hmac(head);
}
function verify(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!s || hmac(h + '.' + p) !== s) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}
const YEAR = 2000000000;  // fixed, so the keys are the same on every run
export const ANON_KEY = sign({ role: 'anon', iss: 'local', exp: YEAR });
export const SERVICE_KEY = sign({ role: 'service_role', iss: 'local', exp: YEAR });

const user = () => ({
  id: USER.id, aud: 'authenticated', role: 'authenticated', email: USER.email,
  email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
});
function session() {
  const now = Math.floor(Date.now() / 1000), ttl = 7 * 86400;
  return {
    access_token: sign({ sub: USER.id, email: USER.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + ttl, session_id: 'local' }),
    token_type: 'bearer', expires_in: ttl, expires_at: now + ttl, refresh_token: 'local-refresh', user: user()
  };
}
function claimsOf(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return verify(bearer) || verify(req.headers.apikey) || { role: 'anon' };
}

// ── http plumbing ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
function send(res, status, data, headers = {}) {
  if (data === undefined) { res.writeHead(status, headers); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Location, x-supabase-api-version');
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url);
    if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url);
    if (url.pathname.startsWith('/storage/v1/')) return await storage(req, res, url);
    send(res, 404, { message: 'not found' });
  } catch (e) {
    console.error(req.method, req.url, e);
    send(res, 500, { message: String(e.message || e) });
  }
});

// ── auth ─────────────────────────────────────────────────────────────────
async function auth(req, res, url) {
  const p = url.pathname.slice('/auth/v1'.length);
  await readBody(req);
  if (p === '/token') return send(res, 200, session());
  if (p === '/user') {
    return claimsOf(req).role === 'authenticated'
      ? send(res, 200, user())
      : send(res, 401, { code: 401, error_code: 'no_authorization', msg: 'not signed in' });
  }
  if (p === '/logout') return send(res, 204);
  if (p === '/settings') return send(res, 200, { external: { email: true }, disable_signup: true });
  send(res, 200, {});
}

// ── rest (a PostgREST subset) ────────────────────────────────────────────
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

function prefer(h) {
  const out = {};
  for (const part of String(h || '').split(',')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k] = v;
  }
  return out;
}

async function rest(req, res, url) {
  const claims = claimsOf(req);
  const role = ['anon', 'authenticated', 'service_role'].includes(claims.role) ? claims.role : 'anon';
  const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'everwake';
  const rel = decodeURIComponent(url.pathname.slice('/rest/v1/'.length));
  const raw = (await readBody(req)).toString();
  const input = raw ? JSON.parse(raw) : undefined;
  const pref = prefer(req.headers.prefer);
  const one = String(req.headers.accept || '').includes('vnd.pgrst.object');

  const client = await pool.connect();
  let out;
  try {
    await client.query('begin');
    await client.query(`set local search_path = ${q(schema)}, public`);
    await client.query(`set local role ${role}`);
    await client.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true),
                               set_config('request.jwt.claim.role', $3, true)`, [JSON.stringify(claims), claims.sub || '', role]);
    out = rel.startsWith('rpc/')
      ? await rpc(client, schema, rel.slice(4), input ?? Object.fromEntries(url.searchParams))
      : await table(client, schema, rel, req.method, url.searchParams, input, pref);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    const status = e.code === '42501' ? 403 : e.code === '42P01' || e.code === '42883' ? 404 : 400;
    if (!['P0001', '23505'].includes(e.code)) console.error(`${req.method} ${rel}: ${e.message}`);
    return send(res, status, { code: e.code || 'PGRST000', message: e.message, details: e.detail || null, hint: e.hint || null });
  } finally {
    client.release();
  }

  const headers = {};
  if (out.count != null) headers['Content-Range'] = out.rows.length ? `0-${out.rows.length - 1}/${out.count}` : `*/${out.count}`;
  if (out.kind === 'rpc') return send(res, 200, out.value);
  if (out.kind === 'write' && pref.return !== 'representation') return send(res, req.method === 'POST' ? 201 : 204, undefined, headers);
  let data = out.rows;
  if (one) {
    if (data.length !== 1) {
      return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned',
                              details: `The result contains ${data.length} rows`, hint: null });
    }
    data = data[0];
  }
  if (req.method === 'HEAD') return send(res, 200, undefined, headers);
  send(res, out.kind === 'write' && req.method === 'POST' ? 201 : 200, data, headers);
}

async function table(client, schema, name, method, sp, input, pref) {
  const T = `${q(schema)}.${q(name)}`;
  const params = [];
  const where = filters(sp, params, 't', '');
  const sel = sp.get('select') || '*';

  if (method === 'GET' || method === 'HEAD') {
    const cols = await columns(client, schema, name, sel, 't', sp, '');
    const order = orderBy(sp.get('order'), 't');
    const limit = sp.get('limit') ? ` limit ${parseInt(sp.get('limit'))}` : '';
    const offset = sp.get('offset') ? ` offset ${parseInt(sp.get('offset'))}` : '';
    const sql = `select coalesce(json_agg(x), '[]'::json) as j from (select ${cols} from ${T} t${where}${order}${limit}${offset}) x`;
    const rows = (await client.query(sql, params)).rows[0].j;
    const count = pref.count ? +(await client.query(`select count(*) from ${T} t${where}`, params)).rows[0].count : null;
    return { kind: 'read', rows, count };
  }

  let sql;
  if (method === 'POST') {
    const list = Array.isArray(input) ? input : [input];
    const keys = sp.get('columns')
      ? sp.get('columns').split(',').map((s) => s.replace(/"/g, '').trim())
      : [...new Set(list.flatMap((r) => Object.keys(r)))];
    params.push(JSON.stringify(list));
    const cl = keys.map(q).join(', ');
    sql = `insert into ${T} as t (${cl}) select ${cl} from json_populate_recordset(null::${T}, $${params.length}::json)`;
    if (pref.resolution) {
      const conflict = sp.get('on_conflict') ? sp.get('on_conflict').split(',').map((s) => s.trim()) : await primaryKey(client, schema, name);
      const upd = keys.filter((k) => !conflict.includes(k));
      sql += ` on conflict (${conflict.map(q).join(', ')}) ` + (pref.resolution === 'ignore-duplicates' || !upd.length
        ? 'do nothing'
        : 'do update set ' + upd.map((k) => `${q(k)} = excluded.${q(k)}`).join(', '));
    }
  } else if (method === 'PATCH') {
    params.push(JSON.stringify(input));
    const keys = Object.keys(input);
    sql = `update ${T} as t set ${keys.map((k) => `${q(k)} = r.${q(k)}`).join(', ')}
             from json_populate_record(null::${T}, $${params.length}::json) r${where}`;
  } else if (method === 'DELETE') {
    sql = `delete from ${T} as t${where}`;
  } else {
    throw Object.assign(new Error('method not supported'), { code: 'PGRST105' });
  }

  if (pref.return === 'representation') {
    const cols = await columns(client, schema, name, sel, 't', sp, '');
    const r = await client.query(`with w as (${sql} returning t.*) select coalesce(json_agg(x), '[]'::json) as j from (select ${cols} from w t) x`, params);
    return { kind: 'write', rows: r.rows[0].j };
  }
  await client.query(sql, params);
  return { kind: 'write', rows: [] };
}

// split on commas that are not inside brackets or quotes
function splitTop(s) {
  const out = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const unquote = (v) => (v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

// col, col->a->>b
function colExpr(alias, col) {
  const parts = col.split(/(->>|->)/);
  let e = `${alias}.${q(parts[0])}`;
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i + 1];
    e += parts[i] + (/^\d+$/.test(key) ? key : `'${key.replace(/'/g, "''")}'`);
  }
  return e;
}

function condition(alias, col, v, params) {
  let neg = false;
  if (v.startsWith('not.')) { neg = true; v = v.slice(4); }
  const dot = v.indexOf('.');
  const op = v.slice(0, dot), val = v.slice(dot + 1);
  const c = colExpr(alias, col);
  const p = (x) => { params.push(x); return `$${params.length}`; };
  const cmp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', cs: '@>', cd: '<@', ov: '&&' };
  let s;
  if (cmp[op]) s = `${c} ${cmp[op]} ${p(unquote(val))}`;
  else if (op === 'like' || op === 'ilike') s = `${c}::text ${op} ${p(unquote(val).replace(/\*/g, '%'))}`;
  else if (op === 'is') s = `${c} is ${{ null: 'null', true: 'true', false: 'false', unknown: 'unknown' }[val.toLowerCase()]}`;
  else if (op === 'in') {
    const items = splitTop(val.replace(/^\(|\)$/g, '')).map(unquote);
    s = items.length ? `${c} in (${items.map(p).join(', ')})` : 'false';
  } else throw Object.assign(new Error(`operator ${op} not supported here`), { code: 'PGRST100' });
  return neg ? `not (${s})` : s;
}

function logic(kind, inner, alias, params) {
  const parts = splitTop(inner.replace(/^\(|\)$/g, '')).map((part) => {
    const m = part.match(/^(not\.)?(and|or)\((.*)\)$/s);
    if (m) return (m[1] ? 'not ' : '') + logic(m[2], '(' + m[3] + ')', alias, params);
    const dot = part.indexOf('.');
    return condition(alias, part.slice(0, dot), part.slice(dot + 1), params);
  });
  return '(' + parts.join(kind === 'or' ? ' or ' : ' and ') + ')';
}

// filters for this level: plain keys at the top, "alias.key" inside an embed
function filters(sp, params, alias, prefix) {
  const conds = [];
  for (const [k0, v] of sp) {
    if (prefix ? !k0.startsWith(prefix) : k0.includes('.')) continue;
    const k = k0.slice(prefix.length);
    if (RESERVED.has(k) || k.includes('.')) continue;
    if (k === 'or' || k === 'and') conds.push(logic(k, v, alias, params));
    else if (k === 'not.or' || k === 'not.and') conds.push('not ' + logic(k.slice(4), v, alias, params));
    else conds.push(condition(alias, k, v, params));
  }
  return conds.length ? ' where ' + conds.join(' and ') : '';
}

function orderBy(o, alias) {
  if (!o) return '';
  return ' order by ' + o.split(',').map((part) => {
    const bits = part.trim().split('.');
    let s = colExpr(alias, bits[0]);
    for (const b of bits.slice(1)) {
      if (b === 'desc' || b === 'asc') s += ' ' + b;
      if (b === 'nullsfirst') s += ' nulls first';
      if (b === 'nullslast') s += ' nulls last';
    }
    return s;
  }).join(', ');
}

let embedN = 0;
async function columns(client, schema, name, sel, alias, sp, prefix) {
  const out = [];
  for (const item of splitTop(sel)) {
    if (item === '*') { out.push(`${alias}.*`); continue; }
    const em = item.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s);
    if (em) {
      const as = em[1] || em[2], relName = em[2];
      const r = await relation(client, schema, name, relName);
      const a = `e${++embedN}`, x = `x${embedN}`;
      const inner = await columns(client, schema, relName, em[4] || '*', a, sp, prefix + as + '.');
      const params = [];
      const extra = filters(sp, params, a, prefix + as + '.').replace(' where ', ' and ');
      if (params.length) throw Object.assign(new Error('filters on embedded resources are not supported'), { code: 'PGRST100' });
      const on = r.pairs.map(([mine, theirs]) => `${a}.${q(theirs)} = ${alias}.${q(mine)}`).join(' and ');
      const from = `${q(schema)}.${q(relName)} ${a} where ${on}${extra}`;
      out.push(r.many
        ? `coalesce((select json_agg(${x}) from (select ${inner} from ${from}${orderBy(sp.get(prefix + as + '.order'), a)}) ${x}), '[]'::json) as ${q(as)}`
        : `(select row_to_json(${x}) from (select ${inner} from ${from} limit 1) ${x}) as ${q(as)}`);
      continue;
    }
    const m = item.match(/^(?:(\w+):)?([\w>-]+?)(?:::(\w+))?$/);
    if (!m) throw Object.assign(new Error(`cannot parse select item ${item}`), { code: 'PGRST100' });
    const as = m[1] || m[2].split(/->>?/).pop();
    out.push(`${colExpr(alias, m[2])}${m[3] ? '::' + m[3] : ''} as ${q(as)}`);
  }
  return out.join(', ');
}

const relCache = new Map();
async function relation(client, schema, from, to) {
  const key = `${schema}.${from}>${to}`;
  if (relCache.has(key)) return relCache.get(key);
  const { rows } = await client.query(`
    select c.conrelid = to_regclass($1) as mine_is_child,
           array(select a.attname::text from unnest(c.conkey) with ordinality k(n, i)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i) as child_cols,
           array(select a.attname::text from unnest(c.confkey) with ordinality k(n, i)
                   join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i) as parent_cols
      from pg_constraint c
     where c.contype = 'f'
       and ((c.conrelid = to_regclass($1) and c.confrelid = to_regclass($2))
         or (c.conrelid = to_regclass($2) and c.confrelid = to_regclass($1)))
     order by array_length(c.conkey, 1) desc`, [`${q(schema)}.${q(from)}`, `${q(schema)}.${q(to)}`]);
  const fk = rows.find((r) => !(r.child_cols.length === 1 && r.child_cols[0] === 'tenant_id')) || rows[0];
  if (!fk) throw Object.assign(new Error(`no relationship between ${from} and ${to}`), { code: 'PGRST200' });
  // pairs: [column on `from`, column on `to`]
  const rel = fk.mine_is_child
    ? { many: false, pairs: fk.child_cols.map((c, i) => [c, fk.parent_cols[i]]) }
    : { many: true, pairs: fk.parent_cols.map((c, i) => [c, fk.child_cols[i]]) };
  relCache.set(key, rel);
  return rel;
}

async function primaryKey(client, schema, name) {
  const { rows } = await client.query(`
    select array(select a.attname::text from unnest(c.conkey) with ordinality k(n, i)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i) as cols
      from pg_constraint c where c.contype = 'p' and c.conrelid = to_regclass($1)`, [`${q(schema)}.${q(name)}`]);
  return rows[0]?.cols || ['id'];
}

const fnCache = new Map();
async function rpc(client, schema, fn, args) {
  const key = `${schema}.${fn}`;
  if (!fnCache.has(key)) {
    const { rows } = await client.query(`
      select p.proretset as set, p.prorettype = 'void'::regtype as void, t.typtype in ('b', 'd', 'e', 'r') as scalar,
             coalesce(p.proargnames, '{}') as names, coalesce(p.proargmodes::text[], '{}') as modes,
             array(select format_type(x, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality u(x, i) order by i) as types
        from pg_proc p join pg_type t on t.oid = p.prorettype
       where p.proname = $1 and p.pronamespace = to_regnamespace($2)`, [fn, schema]);
    fnCache.set(key, rows.map((r) => {
      const ins = {};
      r.types.forEach((ty, i) => { if (!r.modes.length || ['i', 'b', 'v'].includes(r.modes[i])) ins[r.names[i]] = ty; });
      return { ...r, ins };
    }));
  }
  const given = Object.keys(args || {});
  const cands = fnCache.get(key).filter((f) => given.every((n) => n in f.ins)).sort((a, b) => Object.keys(a.ins).length - Object.keys(b.ins).length);
  if (!cands.length) throw Object.assign(new Error(`Could not find the function ${key}(${given.join(', ')})`), { code: 'PGRST202' });
  const f = cands[0];
  const params = [];
  const call = `${q(schema)}.${q(fn)}(` + given.map((n) => {
    const ty = f.ins[n], v = args[n];
    params.push(v === null || v === undefined ? null
      : /^jsonb?$/.test(ty) || (typeof v === 'object' && !(Array.isArray(v) && ty.endsWith('[]'))) ? JSON.stringify(v) : v);
    return `${q(n)} := $${params.length}::${ty}`;
  }).join(', ') + ')';
  let sql;
  if (f.set) sql = f.scalar ? `select coalesce(json_agg(x.v), '[]'::json) as j from ${call} as x(v)` : `select coalesce(json_agg(x), '[]'::json) as j from ${call} x`;
  else if (f.void) sql = `select ${call} is null as j`;
  else if (f.scalar) sql = `select to_json(${call}) as j`;
  else sql = `select row_to_json(x) as j from ${call} x`;
  const r = await client.query(sql, params);
  return { kind: 'rpc', value: f.void ? null : r.rows[0]?.j ?? null };
}

// ── storage (files on disk) ──────────────────────────────────────────────
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
                '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
function fileBody(buf, type) {
  const b = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type || '');
  if (!b) return buf;
  const sep = Buffer.from('--' + (b[1] || b[2]));
  let at = buf.indexOf(sep), best = null;
  while (at !== -1) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next === -1) break;
    const part = buf.subarray(at + sep.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString();
    if (/content-type/i.test(head) || /filename=/i.test(head)) best = part.subarray(split + 4);
    at = next;
  }
  return best || buf;
}
async function storage(req, res, url) {
  const p = decodeURIComponent(url.pathname.slice('/storage/v1'.length));
  let m;
  if (req.method === 'GET' && (m = p.match(/^\/object\/(?:public\/|authenticated\/)?([^/]+)\/(.+)$/))) {
    const file = path.join(FILES, m[1], m[2]);
    if (!file.startsWith(FILES) || !fs.existsSync(file)) return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
    return fs.createReadStream(file).pipe(res);
  }
  if ((req.method === 'POST' || req.method === 'PUT') && (m = p.match(/^\/object\/([^/]+)\/(.+)$/)) && m[1] !== 'list' && m[1] !== 'sign') {
    const file = path.join(FILES, m[1], m[2]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fileBody(await readBody(req), req.headers['content-type']));
    return send(res, 200, { Key: `${m[1]}/${m[2]}`, Id: crypto.randomUUID() });
  }
  if (req.method === 'DELETE' && (m = p.match(/^\/object\/([^/]+)$/))) {
    const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || '{}');
    for (const name of prefixes) fs.rmSync(path.join(FILES, m[1], name), { force: true });
    return send(res, 200, prefixes.map((name) => ({ name })));
  }
  if (req.method === 'POST' && (m = p.match(/^\/object\/sign\/([^/]+)\/(.+)$/))) {
    return send(res, 200, { signedURL: `/object/public/${m[1]}/${m[2]}` });
  }
  await readBody(req);
  send(res, 200, []);
}

// ── realtime: Phoenix channels over a websocket, fed by LISTEN/NOTIFY ────
const subs = new Set();
let bindingId = 1;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/realtime/v1/websocket')) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const [joinRef, ref, topic, event, payload] = msg;
      const reply = (response = {}) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
      if (event === 'phx_join') {
        const changes = (payload?.config?.postgres_changes || []).map((c) => ({ ...c, id: bindingId++ }));
        for (const c of changes) subs.add({ ws, topic, joinRef, c });
        return reply({ postgres_changes: changes });
      }
      if (event === 'phx_leave') {
        for (const s of subs) if (s.ws === ws && s.topic === topic) subs.delete(s);
        return reply();
      }
      if (event === 'access_token') return;
      reply();
    });
    ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
  });
});

function matches(c, ev) {
  if (c.schema && c.schema !== '*' && c.schema !== ev.schema) return false;
  if (c.table && c.table !== '*' && c.table !== ev.table) return false;
  if (c.event && c.event !== '*' && c.event.toUpperCase() !== ev.type) return false;
  if (!c.filter) return true;
  const m = c.filter.match(/^(\w+)=eq\.(.*)$/);
  const row = ev.type === 'DELETE' ? ev.old : ev.record;
  return !m || String(row?.[m[1]]) === m[2];
}

async function listen() {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  await client.query('listen everwake_rt');
  client.on('notification', (n) => {
    const ev = JSON.parse(n.payload);
    for (const s of subs) {
      if (!matches(s.c, ev) || s.ws.readyState !== 1) continue;
      s.ws.send(JSON.stringify([s.joinRef, null, s.topic, 'postgres_changes', {
        ids: [s.c.id],
        data: { schema: ev.schema, table: ev.table, type: ev.type, commit_timestamp: new Date().toISOString(),
                record: ev.record, old_record: ev.old, columns: [], errors: null }
      }]));
    }
  });
}

await listen();
server.listen(PORT, () => {
  console.log(`local supabase on http://localhost:${PORT}`);
  if (process.env.PRINT_KEYS) console.log(JSON.stringify({ anon: ANON_KEY, service: SERVICE_KEY }));
});
