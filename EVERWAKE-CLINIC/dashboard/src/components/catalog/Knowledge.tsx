'use client';
import { BookOpenText, Plus, ScrollText, ShieldCheck, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { AgentRule, Knowledge as KnowledgeRow } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { DocDot } from '../booking/pickers';
import { Button, Card, Field, Input, PageTitle, Select, Skeleton, Textarea } from '../ui';
import { useTenant } from '../tenant';
import { useCatalog } from './Services';

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// What the assistant may say beyond prices: answers to common questions and the clinic's policies,
// and the doctors' rules — the ones checked in code (it cannot break them) and a short note it reads.
export function Knowledge() {
  const { tenant, can } = useTenant();
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  const { busy, change } = useCatalog();
  const { data, refresh } = useCached<{ k: KnowledgeRow[]; r: AgentRule[] }>(`knowledge:${tenant.id}`, async () => {
    const db = sb();
    const [k, r] = await Promise.all([
      db.from('knowledge_entries').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort', { ascending: true }),
      db.from('agent_rules').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('created_at', { ascending: true })
    ]);
    return { k: (k.data || []) as KnowledgeRow[], r: (r.data || []) as AgentRule[] };
  });
  const [edit, setEdit] = useState<string | null>(null);
  const [form, setForm] = useState({ topic: '', content_ar: '' });
  const [rule, setRule] = useState<{ kind: string; text_ar: string; doctor: string; time: string; max_age: string; days: number[] }>({ kind: 'note', text_ar: '', doctor: '', time: '21:00', max_age: '6', days: [] });
  const docs = doctors.filter(d => d.is_active);

  const saveFaq = async (old?: KnowledgeRow) => {
    const r = await change([{ op: old ? 'update_faq' : 'add_faq', topic: old ? old.topic : form.topic, content_ar: form.content_ar }], old ? t('Answer saved.') : t('Answer added.'));
    if (r) { setEdit(null); setForm({ topic: '', content_ar: '' }); refresh(); }
  };
  const removeFaq = async (k: KnowledgeRow) => { const r = await change([{ op: 'remove_faq', topic: k.topic }], t('Answer removed.')); if (r) refresh(); };
  const addRule = async () => {
    const d = doctors.find(x => x.id === rule.doctor);
    const params = rule.kind === 'new_patients_until' ? { time: rule.time } : rule.kind === 'age_doctor' ? { max_age: Number(rule.max_age) } : rule.kind === 'no_booking_days' ? { days: rule.days } : {};
    const auto = rule.kind === 'new_patients_until' ? t('No new patients after {t}', { t: rule.time })
      : rule.kind === 'age_doctor' ? t('Children under {n} only with {doc}', { n: rule.max_age, doc: docName(d, lang) })
      : rule.kind === 'no_booking_days' ? t('No bookings by the assistant on {days}', { days: rule.days.map(x => t(DAY_LABEL[x])).join('، ') }) : '';
    const r = await change([{ op: 'add_rule', kind: rule.kind, doctor: d?.code || null, params, text_ar: rule.text_ar || auto }], t('Rule added.'));
    if (r) { setRule({ kind: 'note', text_ar: '', doctor: '', time: '21:00', max_age: '6', days: [] }); setEdit(null); refresh(); }
  };
  const removeRule = async (r: AgentRule) => { const x = await change([{ op: 'remove_rule', text: r.text_ar || r.kind }], t('Rule removed.')); if (x) refresh(); };

  return (
    <div className="space-y-5">
      <PageTitle title={t('Knowledge & rules')} finding={t('The assistant answers from this, word for word, and follows the rules. Change anything here or from your WhatsApp.')} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card pad={false} title={<span className="inline-flex items-center gap-2"><BookOpenText className="size-4 text-accent" aria-hidden />{t('Answers to common questions')}</span>}
          sub={t('Parking, insurance, payment, what to bring, the cancellation policy…')}
          action={can.edit && edit !== 'new' ? <Button size="sm" variant="ghost" onClick={() => { setEdit('new'); setForm({ topic: '', content_ar: '' }); }}><Plus className="size-3.5" aria-hidden />{t('Add')}</Button> : undefined}>
          {!data ? <div className="p-4"><Skeleton className="h-40" /></div> : (
            <ul className="divide-y divide-rule">
              <AnimatePresence initial={false}>
                {edit === 'new' && (
                  <motion.li key="new" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <FaqForm form={form} setForm={setForm} busy={busy} onCancel={() => setEdit(null)} onSave={() => saveFaq()} />
                  </motion.li>
                )}
                {data.k.map(k => (
                  <motion.li key={k.id} layout exit={{ opacity: 0, height: 0 }} className="group">
                    {edit === k.id ? <FaqForm form={form} setForm={setForm} busy={busy} lockTopic onCancel={() => setEdit(null)} onSave={() => saveFaq(k)} /> : (
                      <div className="flex items-start gap-3 px-5 py-3">
                        <button disabled={!can.edit} onClick={() => { setEdit(k.id); setForm({ topic: k.topic, content_ar: k.content_ar || '' }); }} className="min-w-0 flex-1 text-start">
                          <p className="text-[13.5px] font-semibold"><bdi>{k.topic}</bdi></p>
                          <p className="mt-0.5 text-[13px] leading-relaxed text-muted"><bdi>{k.content_ar || k.content_en}</bdi></p>
                        </button>
                        {can.edit && <button onClick={() => removeFaq(k)} className="press shrink-0 rounded-lg p-1.5 text-muted opacity-100 hover:bg-raised hover:text-critical sm:opacity-0 sm:group-hover:opacity-100" aria-label={t('Remove')}><Trash2 className="size-3.5" /></button>}
                      </div>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
              {data.k.length === 0 && edit !== 'new' && <li className="px-4 py-4 text-[13px] text-muted">{t('No answers yet. Add what patients ask most.')}</li>}
            </ul>
          )}
        </Card>

        <div className="min-w-0 space-y-5">
          <Card pad={false} title={<span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 text-accent" aria-hidden />{t('Doctors’ rules')}</span>}
            sub={t('Checked in code: the assistant cannot book against them. The desk still can.')}
            action={can.edit && edit !== 'rule' ? <Button size="sm" variant="ghost" onClick={() => setEdit('rule')}><Plus className="size-3.5" aria-hidden />{t('Add')}</Button> : undefined}>
            {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
              <ul className="divide-y divide-rule">
                {data.r.filter(r => r.kind !== 'note').map(r => {
                  const d = doctors.find(x => x.id === r.doctor_id);
                  return (
                    <li key={r.id} className="group flex items-start gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium"><bdi>{r.text_ar}</bdi></p>
                        {d && <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted"><DocDot color={d.color} />{docName(d, lang)}</p>}
                      </div>
                      {can.edit && <button onClick={() => removeRule(r)} className="press shrink-0 rounded-lg p-1.5 text-muted hover:bg-raised hover:text-critical sm:opacity-0 sm:group-hover:opacity-100" aria-label={t('Remove')}><Trash2 className="size-3.5" /></button>}
                    </li>
                  );
                })}
                {data.r.filter(r => r.kind !== 'note').length === 0 && edit !== 'rule' && <li className="px-5 py-3 text-[13px] text-muted">{t('No rules yet.')}</li>}
              </ul>
            )}
            {edit === 'rule' && (
              <form className="c-fade space-y-3 border-t border-rule bg-raised/60 p-4" onSubmit={e => { e.preventDefault(); addRule(); }}>
                <Field label={t('Rule')}>
                  <Select value={rule.kind} onChange={e => setRule(r => ({ ...r, kind: e.target.value }))}>
                    <option value="note">{t('A note the assistant reads')}</option>
                    <option value="new_patients_until">{t('No new patients after a time')}</option>
                    <option value="age_doctor">{t('Young children only with one doctor')}</option>
                    <option value="no_booking_days">{t('No bookings by the assistant on some days')}</option>
                  </Select>
                </Field>
                {rule.kind !== 'note' && docs.length > 0 && (
                  <Field label={t('Doctor')}><Select value={rule.doctor} onChange={e => setRule(r => ({ ...r, doctor: e.target.value }))}>
                    {rule.kind !== 'age_doctor' && <option value="">{t('Every doctor')}</option>}
                    {docs.map(d => <option key={d.id} value={d.id}>{docName(d, lang)}</option>)}
                  </Select></Field>
                )}
                {rule.kind === 'new_patients_until' && <Field label={t('Last new patient at')}><Input type="time" value={rule.time} onChange={e => setRule(r => ({ ...r, time: e.target.value }))} /></Field>}
                {rule.kind === 'age_doctor' && <Field label={t('Children under (years)')}><Input inputMode="decimal" value={rule.max_age} onChange={e => setRule(r => ({ ...r, max_age: e.target.value }))} /></Field>}
                {rule.kind === 'no_booking_days' && (
                  <div className="flex flex-wrap gap-1.5">
                    {[6, 0, 1, 2, 3, 4, 5].map(d => { const on = rule.days.includes(d); return (
                      <button key={d} type="button" aria-pressed={on} onClick={() => setRule(r => ({ ...r, days: on ? r.days.filter(x => x !== d) : [...r.days, d] }))}
                        className={cx('press h-8 w-12 rounded-full text-[12.5px]', on ? 'bg-accent text-white' : 'bg-sheet ring-1 ring-inset ring-border')}>{t(DAY_LABEL[d])}</button>); })}
                  </div>
                )}
                {rule.kind === 'note' && <Field label={t('What the assistant should do')}><Textarea rows={2} value={rule.text_ar} onChange={e => setRule(r => ({ ...r, text_ar: e.target.value }))} placeholder="مع كشف الزرعة قول إن أشعة البانوراما عليها خصم 50%" /></Field>}
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('Cancel')}</Button>
                  <Button size="sm" type="submit" busy={busy} disabled={(rule.kind === 'note' && !rule.text_ar.trim()) || (rule.kind === 'age_doctor' && !rule.doctor)}>{t('Add the rule')}</Button>
                </div>
              </form>
            )}
          </Card>

          <Card pad={false} title={<span className="inline-flex items-center gap-2"><ScrollText className="size-4 text-accent" aria-hidden />{t('Notes the assistant reads')}</span>}
            sub={t('Short instructions under its fixed safety rules: it never diagnoses or prescribes.')}>
            <ul className="divide-y divide-rule">
              {(data?.r || []).filter(r => r.kind === 'note').map(r => (
                <li key={r.id} className="group flex items-start gap-3 px-5 py-3">
                  <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed"><bdi>{r.text_ar}</bdi></p>
                  {can.edit && <button onClick={() => removeRule(r)} className="press shrink-0 rounded-lg p-1.5 text-muted hover:bg-raised hover:text-critical sm:opacity-0 sm:group-hover:opacity-100" aria-label={t('Remove')}><Trash2 className="size-3.5" /></button>}
                </li>
              ))}
              {data && !data.r.some(r => r.kind === 'note') && <li className="px-5 py-3 text-[13px] text-muted">{t('No notes yet.')}</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FaqForm({ form, setForm, busy, onCancel, onSave, lockTopic }:
  { form: { topic: string; content_ar: string }; setForm: (f: { topic: string; content_ar: string }) => void; busy: boolean; onCancel: () => void; onSave: () => void; lockTopic?: boolean }) {
  const { t } = useLang();
  return (
    <form className="space-y-2.5 bg-raised/60 px-5 py-3" onSubmit={e => { e.preventDefault(); if (form.topic.trim() && form.content_ar.trim()) onSave(); }}>
      <Input autoFocus={!lockTopic} disabled={lockTopic} value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })} placeholder={t('Topic, e.g. Parking')} aria-label={t('Topic')} />
      <Textarea autoFocus={lockTopic} rows={3} value={form.content_ar} onChange={e => setForm({ ...form, content_ar: e.target.value })} placeholder="في جراج قدام العيادة…" aria-label={t('The answer')} />
      <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onCancel}>{t('Cancel')}</Button><Button size="sm" type="submit" busy={busy}>{t('Save')}</Button></div>
    </form>
  );
}
