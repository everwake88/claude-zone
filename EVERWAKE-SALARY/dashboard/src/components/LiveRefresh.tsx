'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

// Keeps the page current while it is open: fresh data every `every` seconds, only while the tab is
// visible, and at once when you come back to it. New rows and messages slide in by themselves.
//
// `stamp` is the moment the server drew the page. On this version of Next.js a refresh whose reply
// streams in several parts is sometimes dropped, so after asking for one it checks that a newer page
// really arrived, and asks again (a few seconds apart, three times at most) if not.
const CHECK_AFTER = 4000;
const TRIES = 3;

export function LiveRefresh({ every = 20, label, stamp }: { every?: number; label: string; stamp: number }) {
  const router = useRouter();
  const seen = useRef(stamp);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  // a newer page arrived: nothing left to check
  useEffect(() => {
    seen.current = stamp;
    if (retry.current) { clearTimeout(retry.current); retry.current = null; }
  }, [stamp]);

  useEffect(() => {
    const refresh = (tries = TRIES) => {
      const before = seen.current;
      if (retry.current) clearTimeout(retry.current);
      router.refresh();
      retry.current = setTimeout(() => {
        retry.current = null;
        if (seen.current === before && tries > 1 && document.visibilityState === 'visible') refresh(tries - 1);
      }, CHECK_AFTER);
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => refresh(), every * 1000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.visibilityState === 'visible') { refresh(); start(); } else stop(); };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      if (retry.current) clearTimeout(retry.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [router, every]);

  return <span className="live" title={label}><i aria-hidden="true" />{label}</span>;
}
