'use client';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { sb } from './supabase/client';

// One realtime channel for the whole dashboard (the shell opens it); a page asks to hear about
// the tables it shows and refreshes itself when one of them changes.
export type LiveTable = 'appointments' | 'alerts' | 'conversations' | 'messages' | 'tenants' | 'team_questions' | 'delay_notice_items' | 'waitlist';
export interface LiveEvent { table: LiveTable; event: 'INSERT' | 'UPDATE' | 'DELETE'; row: Record<string, unknown>; old: Record<string, unknown> }
type Listener = { tables: LiveTable[]; fn: (e: LiveEvent) => void };

const LiveCtx = createContext<{ add: (l: Listener) => () => void }>({ add: () => () => {} });

export function LiveProvider({ tenantId, children }: { tenantId: string; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  useEffect(() => {
    const db = sb();
    let ch = db.channel('clinic-live-' + tenantId);
    const tables: LiveTable[] = ['appointments', 'alerts', 'conversations', 'messages', 'team_questions', 'delay_notice_items', 'waitlist'];
    for (const table of tables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'clinic', table, filter: `tenant_id=eq.${tenantId}` }, (p) => {
        const e: LiveEvent = { table, event: p.eventType as LiveEvent['event'], row: (p.new || {}) as Record<string, unknown>, old: (p.old || {}) as Record<string, unknown> };
        listeners.current.forEach(l => { if (l.tables.includes(table)) l.fn(e); });
      });
    }
    ch = ch.on('postgres_changes', { event: 'UPDATE', schema: 'clinic', table: 'tenants', filter: `id=eq.${tenantId}` }, (p) => {
      const e: LiveEvent = { table: 'tenants', event: 'UPDATE', row: (p.new || {}) as Record<string, unknown>, old: {} };
      listeners.current.forEach(l => { if (l.tables.includes('tenants')) l.fn(e); });
    });
    ch.subscribe();
    return () => { db.removeChannel(ch); };
  }, [tenantId]);
  const add = (l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; };
  return <LiveCtx.Provider value={{ add }}>{children}</LiveCtx.Provider>;
}

// a page's refresh when its tables change; several changes close together refresh once
export function useLive(tables: LiveTable[], fn: (e: LiveEvent) => void, debounceMs = 350) {
  const { add } = useContext(LiveCtx);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = tables.join(',');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: LiveEvent | null = null;
    const off = add({ tables: key.split(',') as LiveTable[], fn: (e) => {
      last = e;
      if (debounceMs <= 0) return fnRef.current(e);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (last) fnRef.current(last); }, debounceMs);
    } });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [add, key, debounceMs]);
}
