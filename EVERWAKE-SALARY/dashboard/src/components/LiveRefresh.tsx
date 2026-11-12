'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Keeps the page current while it is open: fresh data every `every` seconds, only while the tab is
// visible, and at once when you come back to it. New rows and messages slide in by themselves.
export function LiveRefresh({ every = 20, label }: { every?: number; label: string }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => router.refresh(), every * 1000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.visibilityState === 'visible') { router.refresh(); start(); } else stop(); };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [router, every]);
  return <span className="live" title={label}><i aria-hidden="true" />{label}</span>;
}
