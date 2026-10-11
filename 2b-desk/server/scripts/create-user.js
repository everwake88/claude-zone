// Create one desk account from the command line.
//   npm run users:create -- --name "Nour Ali" --username nour.ali --employee 2B-006 [--role agent|supervisor|admin] [--password ...] [--max-chats 25]
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword, generatePassword } from '../src/auth.js';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = arg('name');
const username = (arg('username') || '').toLowerCase();
const employee = arg('employee');
const role = arg('role') || 'agent';
const maxChats = arg('max-chats') ? Number(arg('max-chats')) : null;
if (!name || !username || !employee) {
  console.error('Usage: npm run users:create -- --name "Full Name" --username user.name --employee 2B-001 [--role agent|supervisor|admin] [--password ...]');
  process.exit(1);
}
if (!['agent', 'supervisor', 'admin'].includes(role)) {
  console.error('--role must be agent, supervisor or admin');
  process.exit(1);
}
if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
  console.error('--username: 3–40 characters, letters, numbers, dot, dash or underscore');
  process.exit(1);
}
const password = arg('password') || generatePassword();
if (password.length < 8) {
  console.error('--password needs at least 8 characters');
  process.exit(1);
}

const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
try {
  await migrate(db, { info: () => {} });
  await db.q(
    `INSERT INTO desk.users (employee_id, username, full_name, role, password_hash, max_chats) VALUES ($1, $2, $3, $4, $5, $6)`,
    [employee, username, name, role, await hashPassword(password), maxChats],
  );
  console.log(`Created ${role} ${name} (${employee})`);
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}`);
} catch (err) {
  console.error(err.code === '23505' ? 'That username or employee ID already exists.' : err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
