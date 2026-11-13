import 'server-only';
import { q, one } from './db';
import { dateTime } from './format';
import type { Lang } from './i18n';

// Everything the Agent instructions page shows, in one object: the page renders it first, and every
// save, word rule, removal or restore sends back a fresh copy, so the page updates from the answer
// itself instead of asking the router to refresh.
export type InstrVersion = { id: string; when: string; who: string; note: string | null; restored: string | null;
                             isDefault: boolean; chars: number; body: string };
export type Rule = { id: string; say: string | null; avoid: string };
export type InstrData = { versions: InstrVersion[]; rules: Rule[]; live: string };
export type InstrResult = { ok?: boolean; error?: string; message?: string; data?: InstrData };

export async function loadInstructions(lang: Lang): Promise<InstrData> {
  const [rows, rules, live] = await Promise.all([
    q<{ id: string; note: string | null; saved_at: string; name: string | null; restored_at: string | null;
        is_default: boolean; chars: number; body: string }>(
      `select i.id::text, i.note, i.saved_at, u.name, r.saved_at as restored_at,
              i.body = salary.default_instructions() as is_default, length(i.body)::int as chars, i.body
         from salary.agent_instructions i
         left join salary.hr_users u on u.id = i.saved_by
         left join salary.agent_instructions r on r.id = i.restored_from
        order by i.id desc limit 12`),
    q<Rule>('select id::text, say, avoid from salary.word_rules order by id'),
    one<{ text: string }>('select salary.instructions_text() as text')
  ]);
  return {
    versions: rows.map((v) => ({
      id: v.id, when: dateTime(lang, v.saved_at), who: v.name || 'Everwake', note: v.note,
      restored: v.restored_at ? dateTime(lang, v.restored_at) : null, isDefault: v.is_default, chars: v.chars, body: v.body
    })),
    rules,
    live: live?.text ?? ''
  };
}
