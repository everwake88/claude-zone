import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './lib/env';
import { LANG_COOKIE } from './lib/lang-cookie';

// Keeps the Supabase session fresh on every request and sends anyone who
// is not signed in to /login. Drivers' pages have their own sign-in.
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
  const { data: { user } } = await supabase.auth.getUser();

  // customers' payment pages and Paymob's notices need no sign-in (the link route checks its own callers)
  const open = path.startsWith('/login') || path.startsWith('/auth') || path.startsWith('/api/health')
    || path.startsWith('/p/') || path.startsWith('/api/pay/')
    // ordering in the branch from a QR code (customers), and the restaurant's own system (an API key)
    || path.startsWith('/q/') || path.startsWith('/api/q/') || path.startsWith('/api/v1/');
  if (!user && !open) {
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
