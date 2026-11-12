#!/usr/bin/env node
// The first HR admin (or any account), from your own machine:
//   DATABASE_URL=postgres://… npm run create-user -- hr@company.com "Mona Ibrahim" admin
// It asks for the password (at least 10 characters) without showing it.
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline';

const [email, name = '', role = 'admin'] = process.argv.slice(2);
if (!email || !process.env.DATABASE_URL) {
  console.error('usage: DATABASE_URL=… npm run create-user -- <email> "<name>" [admin|hr]');
  process.exit(1);
}
const ask = (q) => new Promise((res) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
  rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); res(a); });
});
const password = process.env.HR_PASSWORD || await ask('Password: ');
if (password.length < 10) { console.error('The password needs at least 10 characters.'); process.exit(1); }
const ssl = process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
await db.connect();
await db.query(`insert into salary.hr_users (email, name, role, password_hash) values ($1, $2, $3, $4)
                on conflict (lower(email)) do update set name = excluded.name, role = excluded.role, password_hash = excluded.password_hash, active = true`,
  [email.toLowerCase(), name, role === 'hr' ? 'hr' : 'admin', await bcrypt.hash(password, 10)]);
await db.end();
console.log(`${email} can sign in now (${role === 'hr' ? 'hr' : 'admin'}).`);
