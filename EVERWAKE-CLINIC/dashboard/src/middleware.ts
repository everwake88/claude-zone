import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './lib/env';
import { LANG_COOKIE } from './lib/lang-cookie';

// Patients' pages (the link in a reminder: /a/<token>) and the health check need no sign-in,
// so they skip the session work entirely. Everything else needs a signed-in member.
const OPEN = ['/login', '/auth', '/api/health', '/a/', '/api/a/'];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // a patient's page opens in Arabic unless they chose English
  if (path.startsWith('/a/') && !request.cookies.get(LANG_COOKIE)) {
    request.cookies.set(LANG_COOKIE, 'ar');
    const res = NextResponse.next({ request });
    res.cookies.set(LANG_COOKIE, 'ar', { path: '/', maxAge: 31536000, sameSite: 'lax' });
    return res;
  }
  let response = NextResponse.next({ request });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return response;
  const open = OPEN.some(p => path.startsWith(p));
  // the open pages still refresh a signed-in session (the login page needs it), but only when there is one
  if (open && !request.cookies.getAll().some(c => c.name.startsWith('sb-'))) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });
  // the token checked against the project's public signing key, here and without a call to Supabase
  // on every click; what a member may see is still decided by the database on every query
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims && !open) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3)$).*)']
};
