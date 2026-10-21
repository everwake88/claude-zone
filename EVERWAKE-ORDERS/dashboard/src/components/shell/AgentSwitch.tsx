'use client';
import { Bot, BotOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase/client';
import { timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { Button, Checkbox, Field, Modal, Textarea, useAction } from '../ui';
import { useTenant } from '../tenant';

interface PauseStatus { agent_enabled: boolean; pause: null | { id: number; started_at: string; reason: string | null; waiting: number } }

// The agent ON / OFF switch, always in the top bar.
// OFF: every customer who writes gets one warm apology and is remembered.
// ON:  everyone remembered gets "we're back, you can order now".
export function AgentSwitch() {
  const { tenant, setAgentEnabled } = useTenant();
  const [status, setStatus] = useState<PauseStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [notifyBack, setNotifyBack] = useState(true);
  const { busy, run } = useAction();
  const t = useT();

  const load = async () => {
    const { data } = await sb().rpc('pause_status', { p_tenant: tenant.id });
    if (data) { setStatus(data as PauseStatus); setAgentEnabled((data as PauseStatus).agent_enabled); }
  };
  useEffect(() => {
    load();
    const ch = sb().channel('agent-switch-' + tenant.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'everwake', table: 'tenants', filter: `id=eq.${tenant.id}` }, () => load())
      .subscribe();
    const t = setInterval(load, 30000);
    return () => { clearInterval(t); sb().removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  const on = status ? status.agent_enabled : tenant.agent_enabled;
  const waiting = status?.pause?.waiting ?? 0;

  const apply = async () => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('set_agent_enabled', {
        p_tenant: tenant.id, p_enabled: !on, p_reason: reason || null, p_notify: notifyBack });
      if (error) throw new Error(error.message);
      if (on === false) await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
      return data as { notified?: number };
    }, on ? t('The agent is OFF. Customers get a warm apology and will hear when you are back.') : undefined);
    if (r !== undefined) {
      setOpen(false); setReason('');
      await load();
    }
  };

  return (
    <>
      <button onClick={() => setOpen(true)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
          on ? 'border-positive/30 bg-positive-wash text-positive' : 'border-critical/30 bg-critical-wash text-critical'}`}>
        {on ? <Bot className="size-4" /> : <BotOff className="size-4" />}
        <span>{on ? t('Agent ON') : t('Agent OFF')}</span>
        {!on && waiting > 0 && <span className="rounded-full bg-critical px-1.5 text-xs text-white">{t('{n} waiting', { n: waiting })}</span>}
      </button>

      <Modal open={open} onClose={() => setOpen(false)}
        title={on ? t('Switch the agent OFF?') : t('Switch the agent back ON?')}
        footer={<>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('Cancel')}</Button>
          <Button variant={on ? 'danger' : 'positive'} busy={busy} onClick={apply}>{on ? t('Switch OFF') : t('Switch ON')}</Button>
        </>}>
        {on ? (
          <div className="space-y-4 text-sm">
            <p className="text-muted">{t('Use this when you are too busy to take more WhatsApp orders. While it is off, everyone who writes gets one warm apology (Settings → Messages) and is remembered. Conversations a person already took over are not affected.')}</p>
            <Field label={t('Why (only your team sees this)')}>
              <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder={t('Kitchen full, Friday rush…')} />
            </Field>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-muted">
              {t('Off since {when}', { when: timeAgo(status?.pause?.started_at) })}{status?.pause?.reason ? ` — ${status.pause.reason}` : ''}.{' '}
              {waiting === 1 ? t('1 person wrote while it was off.') : t('{n} people wrote while it was off.', { n: waiting })}
            </p>
            <Checkbox checked={notifyBack} onChange={setNotifyBack}
              label={t('Send them the "we\'re back, you can order now" message')} />
          </div>
        )}
      </Modal>
    </>
  );
}
