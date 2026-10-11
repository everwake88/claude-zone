// Passwords (scrypt, built into Node) and session tokens.
// Tokens are random 256-bit strings; only their SHA-256 is stored, so a
// database leak does not leak working sessions.
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(password, salt, n = N, r = R, p = P) {
  return new Promise((resolve, reject) => {
    scrypt(String(password), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// A real hash of a throwaway password, so a login for an unknown username
// costs the same time as a wrong password and does not reveal which it was.
const dummyHash = hashPassword(randomBytes(12).toString('hex'));

export async function verifyPassword(password, stored) {
  const parts = String(stored || (await dummyHash)).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return stored != null && expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Memorable but strong enough for a first password: e.g. "mint-cobalt-4827".
const WORDS = [
  'amber', 'basil', 'cedar', 'cobalt', 'coral', 'delta', 'ember', 'fable', 'falcon', 'garnet',
  'harbor', 'indigo', 'jasmine', 'kepler', 'lotus', 'maple', 'mint', 'nova', 'olive', 'orbit',
  'pearl', 'pine', 'quartz', 'raven', 'river', 'saffron', 'sierra', 'tango', 'topaz', 'violet',
];
export function generatePassword() {
  const pick = () => WORDS[randomBytes(1)[0] % WORDS.length];
  const digits = String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
  return `${pick()}-${pick()}-${digits}`;
}
