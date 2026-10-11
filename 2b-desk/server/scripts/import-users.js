// Create many accounts at once from a CSV file:
//
//   employee_id,full_name,username,role,max_chats
//   2B-001,Ahmed Hassan,ahmed.hassan,agent,
//   2B-S01,Heba Farouk,heba.farouk,supervisor,
//
// role and max_chats are optional (agent, team default). Existing usernames
// are skipped. Each new person gets a generated first password; the list is
// written to credentials-<date>.csv next to the input file. Hand the
// passwords out, then delete that file.
//
//   npm run users:import -- path/to/agents.csv
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword, generatePassword } from '../src/auth.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run users:import -- path/to/agents.csv');
  process.exit(1);
}

// Small CSV reader: commas, optional double quotes, a header row.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const header = rows.shift().map((h) => h.trim().toLowerCase());
const col = (name) => header.indexOf(name);
for (const need of ['employee_id', 'full_name', 'username']) {
  if (col(need) < 0) {
    console.error(`The first row must contain the column "${need}".`);
    process.exit(1);
  }
}

const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
const out = [['employee_id', 'full_name', 'username', 'password']];
let created = 0;
let skipped = 0;
try {
  await migrate(db, { info: () => {} });
  for (const r of rows) {
    const get = (name) => (col(name) >= 0 ? String(r[col(name)] ?? '').trim() : '');
    const username = get('username').toLowerCase();
    const role = get('role') || 'agent';
    const maxChats = get('max_chats') ? Number(get('max_chats')) : null;
    if (!/^[a-z0-9._-]{3,40}$/.test(username) || !get('full_name') || !get('employee_id') || !['agent', 'supervisor', 'admin'].includes(role)) {
      console.warn(`  skipped (check the row): ${r.join(',')}`);
      skipped++;
      continue;
    }
    const exists = await db.one('SELECT 1 AS x FROM desk.users WHERE lower(username) = $1 OR lower(employee_id) = lower($2)', [username, get('employee_id')]);
    if (exists) {
      console.log(`  exists, skipped: ${username}`);
      skipped++;
      continue;
    }
    const password = generatePassword();
    await db.q(
      `INSERT INTO desk.users (employee_id, username, full_name, role, password_hash, max_chats) VALUES ($1, $2, $3, $4, $5, $6)`,
      [get('employee_id'), username, get('full_name'), role, await hashPassword(password), maxChats],
    );
    out.push([get('employee_id'), get('full_name'), username, password]);
    created++;
  }
} finally {
  await db.end();
}
if (created) {
  const target = path.join(path.dirname(path.resolve(file)), `credentials-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(target, out.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n', { mode: 0o600 });
  console.log(`\nCreated ${created} account(s), skipped ${skipped}. First passwords: ${target}`);
  console.log('Give each person their password, then delete that file.');
} else {
  console.log(`Nothing created (${skipped} skipped).`);
}
