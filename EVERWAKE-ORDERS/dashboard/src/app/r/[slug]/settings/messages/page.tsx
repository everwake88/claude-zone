'use client';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Button, Card, Field, Spinner, Tabs, Textarea } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';

const GROUPS: { title: string; hint: string; keys: [string, string][] }[] = [
  { title: 'While the agent is OFF', hint: 'Sent once to each person who writes while you have switched the agent off.', keys: [['pause_apology', 'The apology']] },
  { title: 'When the agent is back ON', hint: 'Sent to everyone who wrote while it was off.', keys: [['resume_notice', '"We are back"']] },
  { title: 'Order updates', hint: 'Sent when you move an order on the board. Leave one empty to send nothing at that step.', keys: [
    ['status_accepted', 'Accepted'], ['status_ready', 'Ready for pickup'], ['status_out_for_delivery', 'Out for delivery'],
    ['status_delivered', 'Delivered'], ['status_rejected', 'Rejected'], ['status_cancelled', 'Cancelled']] }
];
const SAMPLE = { name: 'منى', order_no: 'NG-1024', branch: 'الزمالك', eta: ' الوقت المتوقع حوالي 45 دقيقة.', reason: ' الفرع زحمة جداً.' };
const render = (t: string) => Object.entries(SAMPLE).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), t || '').replace(/\s+([،,.!؟?])/g, '$1').replace(/\s{2,}/g, ' ').trim();

// The automatic WhatsApp messages, in the restaurant's own words.
export default function MessagesSettings() {
  const { can } = useTenant();
  const { row, save, busy } = useTenantRow();
  const t = useT();
  const [tpl, setTpl] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<'ar' | 'en'>('ar');

  useEffect(() => {
    if (!row) return;
    sb().rpc('default_settings').then(({ data }) => {
      const d = ((data as { templates: Record<string, string> }) || { templates: {} }).templates;
      setDefaults(d);
      setTpl({ ...d, ...(row.settings.templates || {}) });
    });
  }, [row]);
  if (!row) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t('Placeholders:')} <code>{'{name}'}</code> {t('first name')} · <code>{'{order_no}'}</code> · <code>{'{branch}'}</code> · <code>{'{eta}'}</code> · <code>{'{reason}'}</code>. {t('A customer gets the language they wrote in.')}</p>
        <Tabs value={lang} onChange={setLang} tabs={[{ value: 'ar', label: t('Arabic') }, { value: 'en', label: t('English') }]} />
      </div>
      {GROUPS.map(g => (
        <Card key={g.title} title={t(g.title)}>
          <p className="mb-3 text-sm text-muted">{t(g.hint)}</p>
          <div className="space-y-4">
            {g.keys.map(([k, label]) => {
              const key = `${k}_${lang}`;
              return (
                <div key={key} className="grid gap-3 lg:grid-cols-2">
                  <Field label={t(label)}>
                    <Textarea dir={lang === 'ar' ? 'rtl' : 'ltr'} rows={3} disabled={!can.edit} value={tpl[key] ?? ''} onChange={e => setTpl({ ...tpl, [key]: e.target.value })} />
                  </Field>
                  <div>
                    <p className="mb-1.5 flex items-center justify-between text-sm font-medium">{t('Preview')}
                      {can.edit && tpl[key] !== defaults[key] && <button className="flex items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => setTpl({ ...tpl, [key]: defaults[key] || '' })}><RotateCcw className="size-3" /> {t('Default')}</button>}
                    </p>
                    <div className="rounded-2xl rounded-ee-md bg-[#d9fdd3] px-3.5 py-2 text-sm shadow-sm" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                      {render(tpl[key]) || <span className="text-muted">{t('(nothing is sent)')}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
      {can.edit && <Button variant="gold" busy={busy} onClick={() => save({ settings: { ...row.settings, templates: tpl } }, t('Messages saved'))}>{t('Save')}</Button>}
    </div>
  );
}
