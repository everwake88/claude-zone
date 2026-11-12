// The HR sign-in: a signed cookie (HS256) holding who signed in. Edge-safe (used by middleware).
import { SignJWT, jwtVerify } from 'jose';

export const COOKIE = 'ew_salary_session';
export const MAX_AGE = 60 * 60 * 12; // a working day
export type Session = { uid: string; name: string; email: string; role: 'admin' | 'hr' };

const key = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(s);
};

export async function sign(s: Session): Promise<string> {
  return new SignJWT({ ...s }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(`${MAX_AGE}s`).sign(key());
}
export async function verify(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return { uid: String(payload.uid), name: String(payload.name), email: String(payload.email), role: payload.role === 'admin' ? 'admin' : 'hr' };
  } catch { return null; }
}
