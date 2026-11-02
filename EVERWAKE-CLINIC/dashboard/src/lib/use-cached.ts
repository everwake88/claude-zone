'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// What a page showed last time, kept while the dashboard is open: coming back to a page shows it at
// once, and the fresh copy replaces it a moment later (no spinner on the second visit).
// The key names the data and everything it depends on (the restaurant, the period…).
const store = new Map<string, unknown>();

export function useCached<T>(key: string | null, fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | undefined>(() => (key ? (store.get(key) as T | undefined) : undefined));
  const [loading, setLoading] = useState(false);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(async () => {
    const k = keyRef.current;
    if (!k) return;
    setLoading(true);
    try {
      const v = await fetchRef.current();
      store.set(k, v);
      if (keyRef.current === k) setData(v);       // an answer for a period no longer shown is kept, not shown
    } finally {
      if (keyRef.current === k) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // a new key: what was kept for it right away (or nothing), then the fresh copy
    setData(key ? (store.get(key) as T | undefined) : undefined);
    if (key) refresh().catch(() => { /* the page shows what it has; the next refresh tries again */ });
  }, [key, refresh]);

  // a change made on the page (a switch flipped) shown at once and kept for the next visit
  const put = useCallback((v: T) => { if (keyRef.current) store.set(keyRef.current, v); setData(v); }, []);

  return { data, loading, refresh, put };
}
