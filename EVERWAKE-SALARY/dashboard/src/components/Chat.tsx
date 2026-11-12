import { TriangleAlert } from 'lucide-react';
import { time } from '@/lib/format';
import type { Lang } from '@/lib/i18n';

export type Msg = { id: number; direction: 'in' | 'out'; author: 'employee' | 'agent' | 'hr'; text: string; created_at: string; send_error: string | null };

// the chat as the employee saw it: their messages on one side, the agent's and HR's on the other
export function Chat({ messages, lang, hrLabel }: { messages: Msg[]; lang: Lang; hrLabel: string }) {
  return (
    <div className="wa tall" data-ui dir="rtl">
      {messages.map((m) => (
        <div key={m.id} className={`b ${m.author === 'employee' ? 'in' : m.author === 'hr' ? 'hr' : 'out'}`} dir="auto">
          {m.author === 'hr' && <span className="who-tag">{hrLabel}</span>}
          {m.text}
          <time dir="ltr">{m.send_error && <TriangleAlert aria-label={m.send_error} style={{ width: 12, height: 12, verticalAlign: '-2px', color: 'var(--negative)', marginInlineEnd: 4 }} />}{time(lang, m.created_at)}</time>
        </div>
      ))}
    </div>
  );
}
