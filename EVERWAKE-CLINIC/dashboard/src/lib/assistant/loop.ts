// One turn with the assistant: the model streams its words and asks for tools; reading tools run
// and their answers go back to it; changing tools only become cards to confirm; the visit's tools
// go to the screen. The model is passed in, so the loop is tested with a scripted one.
// Pure, for `node --test`.
import type { Chip, Db, Proposal, Tool, Who } from './tools';
import { asFunctions } from './tools.ts';

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'call'; call_id: string; name: string; arguments: string }
  | { type: 'done'; items: unknown[] };
export type Model = (req: { instructions: string; input: unknown[]; tools: ReturnType<typeof asFunctions> }) => AsyncIterable<ModelEvent>;

export type Emit = (event: 'text' | 'tool' | 'action' | 'client', data: unknown) => void;
export interface Part { type: 'tool' | 'action' | 'client'; name: string; label?: string; chips?: Chip[]; action_id?: number; summary?: string; ok?: boolean }
export interface Turn { role: 'user' | 'assistant'; content: string }

const MAX_OUT = 12_000;

export async function runTurn({ model, tools, who, db, history, instructions, emit, propose, maxSteps = 6 }:
  { model: Model; tools: Tool[]; who: Who; db: Db; history: Turn[]; instructions: string; emit: Emit;
    propose: (p: Proposal) => Promise<number>; maxSteps?: number }): Promise<{ text: string; parts: Part[] }> {
  const input: unknown[] = history.map(m => ({ role: m.role, content: m.content }));
  const fns = asFunctions(tools);
  const parts: Part[] = [];
  let text = '';
  for (let step = 0; step < maxSteps; step++) {
    const calls: { call_id: string; name: string; arguments: string }[] = [];
    let items: unknown[] = [];
    let said = '';
    for await (const ev of model({ instructions, input, tools: fns })) {
      if (ev.type === 'text') { said += ev.delta; emit('text', { delta: ev.delta }); }
      else if (ev.type === 'call') calls.push(ev);
      else if (ev.type === 'done') items = ev.items;
    }
    if (said) text += (text ? '\n\n' : '') + said;
    input.push(...(items.length ? items : calls.map(c => ({ type: 'function_call', ...c }))));
    if (!calls.length) break;
    for (const c of calls) {
      const out = await runCall(c, tools, who, db, emit, propose, parts);
      input.push({ type: 'function_call_output', call_id: c.call_id, output: clip(JSON.stringify(out)) });
    }
    if (step === maxSteps - 1) text += (text ? '\n\n' : '') + (who.lang === 'en' ? 'That took too many steps; ask me again more simply.' : 'ده أخد خطوات كتير؛ اسألني تاني بشكل أبسط.');
  }
  return { text, parts };
}

async function runCall(c: { call_id: string; name: string; arguments: string }, tools: Tool[], who: Who, db: Db, emit: Emit,
                       propose: (p: Proposal) => Promise<number>, parts: Part[]): Promise<unknown> {
  const tool = tools.find(t => t.name === c.name);
  if (!tool) return { error: 'NOT_AVAILABLE', note: 'This member cannot use that here. Say so plainly.' };
  let args: Record<string, unknown>;
  try { args = c.arguments ? JSON.parse(c.arguments) : {}; } catch { return { error: 'BAD_ARGUMENTS' }; }
  const label = tool.label[who.lang];
  if (tool.kind === 'read') {
    emit('tool', { id: c.call_id, name: tool.name, label, status: 'running' });
    try {
      const { result, chips } = await tool.run(args, db, who);
      emit('tool', { id: c.call_id, name: tool.name, label, status: 'done', chips: chips || [] });
      parts.push({ type: 'tool', name: tool.name, label, chips: chips || [], ok: true });
      return result;
    } catch (e) {
      emit('tool', { id: c.call_id, name: tool.name, label, status: 'failed' });
      parts.push({ type: 'tool', name: tool.name, label, ok: false });
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (tool.kind === 'write') {
    try {
      const p = await tool.preview(args, db, who);
      const id = await propose(p);
      emit('action', { id, tool: tool.name, label, summary: p.summary, preview: p.preview, status: 'proposed' });
      parts.push({ type: 'action', name: tool.name, label, action_id: id, summary: p.summary });
      return { status: 'WAITING_FOR_CONFIRM', summary: p.summary, preview: p.preview,
               note: 'A card is on their screen. It is NOT done until they press Confirm. Tell them what it will do, in one line.' };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), note: 'Nothing was prepared. Say why plainly.' };
    }
  }
  emit('client', { type: tool.name, payload: args });
  parts.push({ type: 'client', name: tool.name, label });
  return { status: 'SHOWN_ON_SCREEN', note: 'It is in the open visit form now; the doctor reviews and signs.' };
}

const clip = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '…(cut)' : s);

// the page the member is on, from the address
export function pageOf(path: string): { kind: 'today' | 'patient' | 'visit' | 'inbox' | 'calendar' | 'other'; patient_id?: number; appointment_id?: number; conversation_id?: number; path: string } {
  const m = /^\/c\/[^/]+(\/.*)?$/.exec(path.split('?')[0]);
  const rest = m?.[1] || '';
  const qs = new URLSearchParams(path.split('?')[1] || '');
  let x: RegExpExecArray | null;
  if ((x = /^\/patients\/(\d+)/.exec(rest))) return { kind: 'patient', patient_id: Number(x[1]), path };
  if ((x = /^\/visit\/(\d+)/.exec(rest))) return { kind: 'visit', appointment_id: Number(x[1]), path };
  if (rest.startsWith('/inbox')) return { kind: 'inbox', conversation_id: Number(qs.get('c')) || undefined, path };
  if (rest.startsWith('/calendar')) return { kind: 'calendar', path };
  if (!rest || rest === '/') return { kind: 'today', path };
  return { kind: 'other', path };
}
