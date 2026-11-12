import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, verify } from './lib/session';

// Every page but the sign-in needs an HR session. The path rides along (x-pathname)
// so the language switch can bring the person back to the page they were on.
export async function middleware(req: NextRequest) {
  const session = await verify(req.cookies.get(COOKIE)?.value);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  const headers = new Headers(req.headers);
  headers.set('x-pathname', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ['/((?!login|_next|favicon|icon|.*\\.(?:svg|png|ico|woff2?)$).*)'] };
