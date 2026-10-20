'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Spinner, Switch, Textarea, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { sb } from '@/lib/supabase/client';
import type { Knowledge } from '@/lib/types';

const IDEAS = ['Parking', 'Catering and parties', 'Allergens', 'Kids menu', 'Reservations', 'Halal', 'Vegetarian options', 'Payment on delivery'];

// Answers to the questions customers ask that are not about the menu.
// The agent uses them word for word in meaning, and invents nothing else.
export default function KnowledgePage() {
  const { tenant, can } = useTenant();
  const [list, setList] = useState<Knowledge[] | null>(null);
  const [draft, setDraft] = useState<Partial<Knowledge> | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const { data } = await sb().from('knowledge_entries').select('*').eq('tenant_id', tenant.id).order('sort');
    setList((data || []) as Knowledge[]);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const save = (k: Partial<Knowledge>) => run(async () => {
    if (!k.topic?.trim() || !(k.content_ar || k.content_en)?.trim()) throw new Error('Write the topic and the answer');
    const row = { tenant_id: tenant.id, topic: k.topic.trim(), content_ar: k.content_ar || null, content_en: k.content_en || null,
                  is_active: k.is_active !== false, sort: k.sort ?? ((list?.length || 0) + 1) * 10 };
    const { error } = k.id ? await sb().from('knowledge_entries').update(row).eq('id', k.id) : await sb().from('knowledge_entries').insert(row);
    if (error) throw new Error(error.message);
    setDraft(null); await load();
  }, 'Saved — the agent knows on the next message');
  const remove = (k: Knowledge) => run(async () => {
    await sb().from('knowledge_entries').delete().eq('id', k.id); await load();
  });

  if (!list) return <Spinner />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">The questions customers ask that are not about the menu. Write the answer once; the agent gives it in its own words, and says &quot;the branch will confirm&quot; for anything that is not here.</p>
      {list.length === 0 && !draft && <Empty title="No answers yet">Ideas: {IDEAS.join(' · ')}.</Empty>}
      {list.map(k => (
        <Card key={k.id}>
          <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto]">
            <Input defaultValue={k.topic} disabled={!can.edit} onBlur={e => e.target.value !== k.topic && save({ ...k, topic: e.target.value })} />
            <Textarea dir="auto" rows={2} defaultValue={k.content_ar || k.content_en || ''} disabled={!can.edit}
              onBlur={e => e.target.value !== (k.content_ar || '') && save({ ...k, content_ar: e.target.value })} />
            <div className="flex items-start gap-2">
              <Switch checked={k.is_active} disabled={!can.edit} onChange={v => save({ ...k, is_active: v })} label="Active" />
              {can.edit && <Button size="sm" variant="ghost" className="text-critical" onClick={() => remove(k)}><Trash2 className="size-4" /></Button>}
            </div>
          </div>
        </Card>
      ))}
      {draft ? (
        <Card title="New answer">
          <div className="space-y-3">
            <Field label="Topic"><Input value={draft.topic || ''} onChange={e => setDraft({ ...draft, topic: e.target.value })} placeholder="Parking" /></Field>
            <Field label="The answer"><Textarea dir="auto" rows={3} value={draft.content_ar || ''} onChange={e => setDraft({ ...draft, content_ar: e.target.value })} /></Field>
            <div className="flex gap-2"><Button variant="gold" busy={busy} onClick={() => save(draft)}>Save</Button><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button></div>
          </div>
        </Card>
      ) : can.edit && <Button variant="outline" onClick={() => setDraft({})}><Plus className="size-4" /> Add an answer</Button>}
    </div>
  );
}
