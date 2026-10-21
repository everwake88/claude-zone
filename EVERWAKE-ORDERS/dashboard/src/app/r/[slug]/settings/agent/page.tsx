'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Button, Card, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';
import type { Profile } from '@/lib/types';

// Who the agent is and what it knows about the restaurant. This is the
// knowledge that changes between restaurants; the agent's skills do not.
export default function AgentSettings() {
  const { can } = useTenant();
  const { row, save, busy } = useTenantRow();
  const t = useT();
  const [p, setP] = useState<Profile>({});
  const [names, setNames] = useState({ name_ar: '', name_en: '', timezone: '', default_language: 'ar' as 'ar' | 'en' });

  useEffect(() => {
    if (!row) return;
    setP(row.profile || {});
    setNames({ name_ar: row.name_ar, name_en: row.name_en, timezone: row.timezone, default_language: row.default_language });
  }, [row]);
  if (!row) return <Spinner />;
  const ro = !can.edit;
  const facts = p.brand_facts || [];

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={t('The agent')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Its name (Arabic)')} hint={t('Customers see it in the first reply.')}><Input dir="rtl" disabled={ro} value={p.agent_name?.ar || ''} onChange={e => setP({ ...p, agent_name: { ...p.agent_name, ar: e.target.value } })} /></Field>
          <Field label={t('Its name (English)')}><Input disabled={ro} value={p.agent_name?.en || ''} onChange={e => setP({ ...p, agent_name: { ...p.agent_name, en: e.target.value } })} /></Field>
          <Field label={t('Tone and house style')} hint={t('How it should sound — e.g. warm Egyptian host, short replies, proud of the charcoal grill.')} className="sm:col-span-2">
            <Textarea disabled={ro} rows={2} value={p.tone || ''} onChange={e => setP({ ...p, tone: e.target.value })} />
          </Field>
          <Field label={t('Language for customers who have not written yet')}>
            <Select disabled={ro} value={names.default_language} onChange={e => setNames({ ...names, default_language: e.target.value as 'ar' | 'en' })}>
              <option value="ar">{t('Arabic')}</option><option value="en">{t('English')}</option>
            </Select>
          </Field>
          <Field label={t('Time zone')} hint={t('Opening hours are read in this zone.')}><Input disabled={ro} value={names.timezone} onChange={e => setNames({ ...names, timezone: e.target.value })} /></Field>
        </div>
      </Card>

      <Card title={t('The restaurant')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Name (Arabic)')}><Input dir="rtl" disabled={ro} value={names.name_ar} onChange={e => setNames({ ...names, name_ar: e.target.value })} /></Field>
          <Field label={t('Name (English)')}><Input disabled={ro} value={names.name_en} onChange={e => setNames({ ...names, name_en: e.target.value })} /></Field>
          <Field label={t('What the restaurant is (Arabic)')} hint={t('Two or three sentences: the food, the story, what it is known for.')} className="sm:col-span-2">
            <Textarea dir="rtl" disabled={ro} rows={3} value={p.about_ar || ''} onChange={e => setP({ ...p, about_ar: e.target.value })} />
          </Field>
          <Field label={t('The same in English (optional)')} className="sm:col-span-2"><Textarea disabled={ro} rows={2} value={p.about_en || ''} onChange={e => setP({ ...p, about_en: e.target.value })} /></Field>
          <Field label={t('Cuisine')}><Input disabled={ro} value={p.cuisine || ''} onChange={e => setP({ ...p, cuisine: e.target.value })} placeholder={t('Egyptian grill, seafood, burgers…')} /></Field>
        </div>
      </Card>

      <Card title={t('Facts the agent may rely on')} action={!ro && <Button size="sm" variant="ghost" onClick={() => setP({ ...p, brand_facts: [...facts, ''] })}><Plus className="size-4" /> {t('Add')}</Button>}>
        <p className="mb-3 text-sm text-muted">{t('Short true statements — "all grills are charcoal", "we cater parties with a day\'s notice". The agent never invents anything that is not here or in the menu.')}</p>
        <div className="space-y-2">
          {facts.map((f, i) => (
            <div key={i} className="flex gap-2">
              <Input dir="auto" disabled={ro} value={f} onChange={e => setP({ ...p, brand_facts: facts.map((x, j) => j === i ? e.target.value : x) })} />
              {!ro && <Button variant="ghost" className="text-critical" onClick={() => setP({ ...p, brand_facts: facts.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>}
            </div>
          ))}
          {facts.length === 0 && <p className="text-sm text-muted">{t('None yet.')}</p>}
        </div>
      </Card>

      <Card title={t('Contacts and links the agent may share')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Hotline')}><Input dir="ltr" disabled={ro} value={p.contacts?.hotline || ''} onChange={e => setP({ ...p, contacts: { ...p.contacts, hotline: e.target.value } })} /></Field>
          <Field label={t('Complaints number')}><Input dir="ltr" disabled={ro} value={p.contacts?.complaints || ''} onChange={e => setP({ ...p, contacts: { ...p.contacts, complaints: e.target.value } })} /></Field>
          <Field label={t('Website')}><Input dir="ltr" disabled={ro} value={p.website || ''} onChange={e => setP({ ...p, website: e.target.value })} /></Field>
          <Field label={t('Instagram')}><Input dir="ltr" disabled={ro} value={p.instagram || ''} onChange={e => setP({ ...p, instagram: e.target.value })} placeholder="instagram.com/…" /></Field>
          <Field label={t('Facebook')}><Input dir="ltr" disabled={ro} value={p.facebook || ''} onChange={e => setP({ ...p, facebook: e.target.value })} /></Field>
          <Field label={t('Google Maps (the brand page)')}><Input dir="ltr" disabled={ro} value={p.google_maps_url || ''} onChange={e => setP({ ...p, google_maps_url: e.target.value })} /></Field>
        </div>
        <p className="mt-3 text-xs text-muted">{t('Any other link in a reply is blocked by the safety check, so the agent can never send a customer somewhere you did not choose.')}</p>
      </Card>

      {!ro && (
        <div className="xl:col-span-2">
          <Button variant="gold" busy={busy} onClick={() => save({ ...names, profile: { ...p, brand_facts: facts.map(f => f.trim()).filter(Boolean) } })}>{t('Save')}</Button>
        </div>
      )}
    </div>
  );
}
