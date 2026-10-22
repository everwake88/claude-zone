'use client';
import { Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Button, Card, Field, Input, Spinner, Switch, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';

type Report = { enabled: boolean; numbers: string[]; time: string };

// A summary of the last 24 hours on the owner's own WhatsApp, every day at
// the hour they choose: orders, sales, commission saved, best sellers,
// drivers, and the sales that were missed.
export default function DailyReport() {
  const { tenant, can } = useTenant();
  const { row, save, busy } = useTenantRow();
  const { busy: sending, run } = useAction();
  const t = useT();
  const [r, setR] = useState<Report>({ enabled: false, numbers: [''], time: '10:00' });
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!row) return;
    const d = row.settings?.daily_report || {};
    setR({ enabled: !!d.enabled, numbers: d.numbers?.length ? d.numbers : [''], time: d.time || '10:00' });
  }, [row]);
  const loadPreview = useCallback(async () => {
    const { data } = await sb().rpc('report_preview', { p_tenant: tenant.id });
    setPreview((data as string) || '');
  }, [tenant.id]);
  useEffect(() => { if (can.edit) loadPreview(); }, [loadPreview, can.edit]);

  if (!row) return <Spinner />;
  if (!can.edit) return <p className="text-sm text-muted">{t('Reports are for owners and managers.')}</p>;
  const numbers = r.numbers.map(n => n.trim()).filter(Boolean);
  const store = (done?: string) => save({ settings: { ...row.settings, daily_report: { enabled: r.enabled, numbers, time: r.time } } }, done);
  const sendNow = () => run(async () => {
    await store('');
    const { data, error } = await sb().rpc('send_report_now', { p_tenant: tenant.id });
    if (error) throw new Error(error.message);
    if (!data) throw new Error(t('Add a WhatsApp number to send it to.'));
    await fetch('/api/outbox/ping', { method: 'POST' }).catch(() => null);
  }, t('Sent — check WhatsApp'));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={t('Daily report on WhatsApp')}>
        <div className="space-y-4">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Switch checked={r.enabled} onChange={v => setR({ ...r, enabled: v })} label={t('Send me a report every day')} />
            {t('Send me a report every day')}
          </label>
          <Field label={t('Send it to')} hint={t('Your WhatsApp, a partner’s, a manager’s. It comes from the restaurant’s number.')}>
            <div className="space-y-2">
              {r.numbers.map((n, i) => (
                <div key={i} className="flex gap-2">
                  <Input dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={n}
                    onChange={e => setR({ ...r, numbers: r.numbers.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {r.numbers.length > 1 && <Button variant="ghost" className="text-critical" onClick={() => setR({ ...r, numbers: r.numbers.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>}
                </div>
              ))}
              {r.numbers.length < 5 && <Button size="sm" variant="ghost" onClick={() => setR({ ...r, numbers: [...r.numbers, ''] })}><Plus className="size-4" /> {t('Add a number')}</Button>}
            </div>
          </Field>
          <Field label={t('At what time?')} hint={t('It covers the 24 hours before it is sent — after closing, or the next morning, works best. If today’s time has passed when you switch it on, today’s report goes out within a minute.')}>
            <Input type="time" className="w-40" value={r.time} onChange={e => setR({ ...r, time: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="gold" busy={busy} onClick={() => store()}>{t('Save')}</Button>
            <Button variant="outline" busy={sending} disabled={!numbers.length} onClick={sendNow}><Send className="size-4 rtl:rotate-180" /> {t('Send it now')}</Button>
          </div>
        </div>
      </Card>

      <Card title={t('What it looks like (the last 24 hours)')} action={<Button size="sm" variant="ghost" onClick={loadPreview}><RefreshCw className="size-4" /></Button>}>
        {preview === null ? <Spinner /> : (
          <div className="rounded-2xl bg-[#ECE5DD] p-3">
            <p dir="rtl" className="bubble max-w-md rounded-2xl rounded-ss-md bg-white px-3 py-2 text-sm leading-relaxed shadow-sm">{preview}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
