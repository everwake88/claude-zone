import type { Metadata } from 'next';
import { Alexandria } from 'next/font/google';
import { getT } from '@/lib/auth';
import './globals.css';

// Alexandria: one geometric face for Arabic and English, drawn by an Egyptian designer,
// with tabular figures (self-hosted by Next at build time)
const alex = Alexandria({ subsets: ['arabic', 'latin'], variable: '--font-alex', display: 'swap' });

export const metadata: Metadata = { title: 'Salary assistant · HR', robots: { index: false, follow: false } };

// The dashboard's page data (refreshes, navigations, form answers) is handed to React only once it
// has arrived in full. On this Next.js / React version a refresh whose reply streams in over several
// parts was sometimes dropped without a word (the 20-second live refresh missed about half its
// updates in testing); a reply that arrives whole always lands. Replies here are small and fast.
const WHOLE_REPLIES = `(function () {
  var f = window.fetch;
  if (!f || f.__whole) return;
  function isPageData(init) {
    var h = init && init.headers;
    if (!h) return false;
    if (typeof h.has === 'function') return h.has('rsc') || h.has('next-action');
    for (var k in h) { var l = k.toLowerCase(); if (l === 'rsc' || l === 'next-action') return true; }
    return false;
  }
  var whole = function (input, init) {
    var p = f.apply(this, arguments);
    if (!isPageData(init)) return p;
    return p.then(function (res) {
      if (!res.body) return res;
      return res.arrayBuffer().then(function (buf) {
        var r = new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
        Object.defineProperty(r, 'url', { value: res.url });
        Object.defineProperty(r, 'redirected', { value: res.redirected });
        return r;
      });
    });
  };
  whole.__whole = true;
  window.fetch = whole;
})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, dir } = await getT();
  return (
    <html lang={lang} dir={dir} className={alex.variable}>
      <head><script dangerouslySetInnerHTML={{ __html: WHOLE_REPLIES }} /></head>
      <body>{children}</body>
    </html>
  );
}
