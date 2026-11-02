'use client';
import { MessageCircle, Phone, Siren } from 'lucide-react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chime, notify } from '@/lib/alerts';
import { phone, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import type { Alert } from '@/lib/types';
import { useTenant } from '../tenant';

// A patient's words that sound like an emergency: across the top of every page, with a chime,
// until someone on the team says they have seen it. The assistant has already told the patient
// where to go; this is for the doctor to call them.
export function EmergencyBanner({ onChange }: { onChange?: (n: number) => void }) {
  const { tenant, base } = useTenant();
  const t = useT();
  const [list, setList] = useState<Alert[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const known = useRef<Set<number> | null>(null);

  const load = useCallback(async () => {
    const { data } = await sb().rpc('alert_list', { p_tenant: tenant.id, p_status: 'open', p_kind: 'emergency' });
    const rows = (data || []) as Alert[];
    if (known.current) {
      const fresh = rows.filter(r => !known.current!.has(r.id));
      if (fresh.length) { chime(); notify(t('Possible emergency'), fresh[0].body || fresh[0].title); }
    }
    known.current = new Set(rows.map(r => r.id));
    setList(rows);
    onChange?.(rows.length);
  }, [tenant.id, t, onChange]);
  useEffect(() => { load(); }, [load]);
  useLive(['alerts'], load, 0);
  // the chime comes back every 90 seconds while one is open
  useEffect(() => {
    if (!list.length) return;
    const timer = setInterval(chime, 90_000);
    return () => clearInterval(timer);
  }, [list.length]);

  const ack = async (id: number) => {
    setBusy(id);
    await sb().rpc('acknowledge_alert', { p_alert: id, p_resolve: false });
    setBusy(null);
    load();
  };
  const top = list[0];

  return (
    <AnimatePresence initial={false}>
      {top && (
        <motion.div key="emergency" role="alert"
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}
          transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
          className="bg-critical text-white lg:rounded-t-[15px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 lg:px-6">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/15">
              <Siren className="c-breathe size-[18px]" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">
                {t('Possible emergency')}{top.who ? <> — <bdi>{top.who}</bdi></> : null}
                <span className="ms-2 font-normal text-white/75">{timeAgo(top.created_at)}</span>
                {list.length > 1 && <Link href={`${base}/alerts`} className="ms-2 font-normal underline">{t('+{n} more', { n: list.length - 1 })}</Link>}
              </p>
              {top.body && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-white/90" dir="auto">“{top.body}”</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:ps-12">
              {top.phone && (
                <a href={`tel:+${top.phone}`} className="press inline-flex h-8 items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium ring-1 ring-inset ring-white/40 hover:bg-white/10">
                  <Phone className="size-4" aria-hidden /><bdi dir="ltr" className="max-sm:sr-only">{phone(top.phone)}</bdi>
                </a>
              )}
              {top.conversation_id && (
                <Link href={`${base}/inbox?c=${top.conversation_id}`}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium ring-1 ring-inset ring-white/40 hover:bg-white/10">
                  <MessageCircle className="size-4" aria-hidden />{t('Open the chat')}
                </Link>
              )}
              <button onClick={() => ack(top.id)} disabled={busy === top.id}
                className="press inline-flex h-8 items-center rounded-[7px] bg-white px-3 text-[13px] font-semibold text-critical-ink hover:bg-white/90 disabled:opacity-60">
                {t('Seen — I’m on it')}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
