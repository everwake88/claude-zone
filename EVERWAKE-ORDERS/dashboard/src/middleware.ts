import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './lib/env';
import { LANG_COOKIE } from './lib/lang-cookie';

// customers' pages and the outside callers need no sign-in, so they skip the session work entirely:
// payment pages and Paymob's notices, ordering from a QR code, the restaurant's own system (an API key),
// the engine's AI calls on their way to OpenAI (the AI meter)
const OPEN = ['/login', '/auth', '/api/health', '/p/', '/api/pay/', '/q/', '/api/q/', '/api/v1/'];

// Keeps the Supabase session fresh and sends anyone who is not signed in to
// /login. Drivers' pages have their own sign-in.
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // drivers: their own sign-in (a cookie from a WhatsApp link), Arabic unless they chose otherwise
  if (path.startsWith('/driver') || path.startsWith('/d/') || path.startsWith('/api/driver')) {
    if (!request.cookies.get(LANG_COOKIE)) {
      request.cookies.set(LANG_COOKIE, 'ar');
      const res = NextResponse.next({ request });
      res.cookies.set(LANG_COOKIE, 'ar', { path: '/', maxAge: 31536000, sameSite: 'lax' });
      return res;
    }
    return NextResponse.next({ request });
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
  // the session's token checked against the project's public signing key, here and without a call to
  // Supabase on every click (the key is fetched once and kept); an expired session is refreshed first.
  // What a user may see is still decided by the database, which checks the token on every query.
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
