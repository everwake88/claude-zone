'use client';
import { useCallback, useEffect, useState } from 'react';
import { cx, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { PING } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import { Button, Checkbox, Dialog, Field, Switch, Textarea, useAction } from '../ui';
import { useTenant } from '../tenant';

interface Pause { id: number; started_at: string; reason: string | null; contacts_count: number }

// The WhatsApp assistant on or off, at the foot of the sidebar.
// Off: everyone who writes gets one warm apology and is remembered. Back on: they hear "we're back".
export function AgentSwitch({ compact, dark }: { compact?: boolean; dark?: boolean }) {
  const { tenant, setAgentEnabled } = useTenant();
  const [pause, setPause] = useState<Pause | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [notifyBack, setNotifyBack] = useState(true);
  const { busy, run } = useAction();
  const t = useT();
  const on = tenant.agent_enabled;

  const load = useCallback(async () => {
    const db = sb();
    const [{ data: row }, { data: p }] = await Promise.all([
      db.from('tenants').select('agent_enabled').eq('id', tenant.id).maybeSingle(),
      db.from('agent_pauses').select('id, started_at, reason, contacts_count').eq('tenant_id', tenant.id).is('ended_at', null)
        .order('started_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    if (row) setAgentEnabled((row as { agent_enabled: boolean }).agent_enabled);
    setPause((p as Pause | null) || null);
  }, [tenant.id, setAgentEnabled]);
  useEffect(() => { load(); }, [load]);
  useLive(['tenants', 'conversations'], load, 800);

  const apply = async () => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('set_agent_enabled', { p_tenant: tenant.id, p_enabled: !on, p_reason: reason || null, p_notify: notifyBack });
      if (error) throw new Error(error.message);
      if (!on) fetch(PING, { method: 'POST' }).catch(() => null);
      return data as { notified?: number };
    }, on ? t('The assistant is paused. Patients who write get a short apology and hear from you when it is back.') : t('The assistant is answering again.'));
    if (r !== undefined) { setOpen(false); setReason(''); await load(); }
  };
  const waiting = pause?.contacts_count || 0;

  return (
    <>
      {compact ? (
        <button onClick={() => setOpen(true)} aria-label={on ? t('Assistant on') : t('Assistant paused')}
          className={cx('press flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium', on ? 'bg-positive-soft text-positive-ink' : 'bg-critical-soft text-critical-ink')}>
          <span className={cx('size-2 rounded-full', on ? 'c-live bg-positive [--pulse:var(--color-positive)]' : 'bg-critical')} aria-hidden />
          {on ? t('On') : t('Paused')}
        </button>
      ) : (
        <div className={cx('flex items-center gap-3 rounded-2xl px-3.5 py-3', dark ? 'bg-navy-raised' : 'border border-border bg-sheet')}>
          <span className={cx('size-2 shrink-0 rounded-full', on ? 'c-live bg-positive [--pulse:var(--color-positive)]' : 'bg-critical')} aria-hidden />
          <button onClick={() => setOpen(true)} className="min-w-0 flex-1 text-start">
            <span className={cx('block text-[13px] font-medium leading-tight', dark && 'text-white')}>{t('WhatsApp assistant')}</span>
            <span className={cx('block truncate text-xs', on ? (dark ? 'text-on-navy-muted' : 'text-muted') : (dark ? 'text-[#f0a49c]' : 'text-critical'))}>
              {on ? t('Answering patients') : waiting ? t('Paused · {n} wrote meanwhile', { n: waiting }) : t('Paused')}
            </span>
          </button>
          <Switch checked={on} onChange={() => setOpen(true)} label={t('WhatsApp assistant')} tone={dark ? 'gold' : 'navy'} />
        </div>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} tone={on ? 'critical' : undefined}
        title={on ? t('Pause the assistant?') : t('Switch the assistant back on?')}
        footer={<>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('Cancel')}</Button>
          <Button variant={on ? 'danger' : 'positive'} busy={busy} onClick={apply}>{on ? t('Pause it') : t('Switch it on')}</Button>
        </>}>
        {on ? (
          <div className="space-y-4">
            <p className="text-muted">{t('While it is paused, everyone who writes gets one short apology and is remembered. Chats a person already took over are not affected, and reminders still go out.')}</p>
            <Field label={t('Why (only your team sees this)')}>
              <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder={t('The clinic is closed for the Eid holiday…')} />
            </Field>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-muted">
              {t('Paused since {when}', { when: timeAgo(pause?.started_at) })}{pause?.reason ? ` — ${pause.reason}` : ''}.{' '}
              {waiting === 1 ? t('1 person wrote meanwhile.') : t('{n} people wrote meanwhile.', { n: waiting })}
            </p>
            <Checkbox checked={notifyBack} onChange={setNotifyBack} label={t('Tell them the clinic is answering again')} />
          </div>
        )}
      </Dialog>
    </>
  );
}
