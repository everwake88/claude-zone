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

// A patient's words that sound like an emergency: a calm red card at the top of every page, with
// a chime, until someone on the team says they have seen it. The assistant has already told the
// patient where to go; this is for the doctor to call them.
export function EmergencyBanner() {
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
  }, [tenant.id, t]);
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
        <motion.section key="emergency" role="alert"
          initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6, transition: { duration: 0.16 } }}
          transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
          className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[20px] border border-critical/25 bg-critical-soft px-4 py-3.5 sm:px-5">
          <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-critical text-white">
            <span className="c-live absolute inset-0 rounded-full [--pulse:var(--color-critical)]" aria-hidden />
            <Siren className="relative size-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-critical-ink">
              {t('Possible emergency')}{top.who ? <> · <bdi>{top.who}</bdi></> : null}
              <span className="ms-2 text-[12.5px] font-normal text-critical-ink/75">{timeAgo(top.created_at)}</span>
              {list.length > 1 && <Link href={`${base}/alerts`} className="ms-2 text-[12.5px] font-medium underline">{t('+{n} more', { n: list.length - 1 })}</Link>}
            </p>
            {top.body && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-critical-ink/90"><bdi>“{top.body}”</bdi></p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:ps-14">
            {top.phone && (
              <a href={`tel:+${top.phone}`} className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-sheet px-3.5 text-[13px] font-medium text-critical-ink ring-1 ring-inset ring-critical/25 hover:bg-white">
                <Phone className="size-4" aria-hidden /><bdi dir="ltr" className="max-sm:sr-only">{phone(top.phone)}</bdi>
              </a>
            )}
            {top.conversation_id && (
              <Link href={`${base}/inbox?c=${top.conversation_id}`}
                className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-sheet px-3.5 text-[13px] font-medium text-critical-ink ring-1 ring-inset ring-critical/25 hover:bg-white">
                <MessageCircle className="size-4" aria-hidden />{t('Open the chat')}
              </Link>
            )}
            <button onClick={() => ack(top.id)} disabled={busy === top.id}
              className="press inline-flex h-9 items-center rounded-full bg-critical px-4 text-[13px] font-semibold text-white hover:bg-critical-ink disabled:opacity-60">
              {t('Seen — I’m on it')}
            </button>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
