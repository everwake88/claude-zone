// The visit's transcript as segments the form can point at: from the 20-second chunks' texts
// (always there), or from the diarised pass (who said what). Times are seconds from the start.
// Pure, for `node --test`.

export interface Segment { id: string; speaker: string | null; start: number; end: number; text: string; seq?: number }
export interface Chunk { seq: number; ms: number; text: string; path?: string }

// one chunk's text into sentences, each with its share of the chunk's time
export function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?؟。…])\s+|(?<=،)\s+(?=\S{2,}\s+\S)/u)
    .map(s => s.trim()).filter(Boolean)
    .reduce<string[]>((out, s) => {
      // a very short piece joins the one before it ("آه." "ماشي.")
      if (out.length && (s.length < 8 || out[out.length - 1].length < 8)) out[out.length - 1] += ' ' + s; else out.push(s);
      return out;
    }, []);
}

export function segmentsFromChunks(chunks: Chunk[]): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  for (const c of [...chunks].sort((a, b) => a.seq - b.seq)) {
    const dur = Math.max(0, c.ms) / 1000;
    const parts = splitSentences(c.text || '');
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let at = t;
    parts.forEach((p, i) => {
      const len = (dur * p.length) / total;
      out.push({ id: `s${c.seq}_${i}`, speaker: null, start: round(at), end: round(at + len), text: p, seq: c.seq });
      at += len;
    });
    t += dur;
  }
  return out;
}

// a chunk's diarised segments (speaker "A", "B" within that chunk), shifted to the visit's clock.
// Labels are per chunk ("3:A"), so the extraction can say which of them is the doctor.
export function segmentsFromDiarized(perChunk: { seq: number; ms: number; segments: { speaker?: string | null; start?: number; end?: number; text?: string }[] }[]): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  for (const c of [...perChunk].sort((a, b) => a.seq - b.seq)) {
    c.segments.forEach((s, i) => {
      const text = (s.text || '').trim();
      if (!text) return;
      out.push({ id: `s${c.seq}_${i}`, speaker: s.speaker ? `${c.seq}:${s.speaker}` : null,
                 start: round(t + (s.start || 0)), end: round(t + (s.end || s.start || 0)), text, seq: c.seq });
    });
    t += Math.max(0, c.ms) / 1000;
  }
  return out;
}

// the extraction said which label is the doctor: "3:A" → doctor. A label it did not name keeps
// the role of the same letter in the chunk before (voices rarely swap letters mid-visit).
export function applySpeakers(segments: Segment[], roles: { label: string; role: string }[]): Segment[] {
  const map = new Map(roles.map(r => [r.label, r.role]));
  const byLetter = new Map<string, string>();
  return segments.map(s => {
    if (!s.speaker) return s;
    const letter = s.speaker.split(':').pop() || s.speaker;
    const role = map.get(s.speaker) || map.get(letter) || byLetter.get(letter) || null;
    if (role) byLetter.set(letter, role);
    return { ...s, speaker: role };
  });
}

// the transcript as the model reads it: one line per segment, with its id and speaker
export function transcriptText(segments: Segment[]): string {
  return segments.map(s => `[${s.id}${s.speaker ? ' · ' + s.speaker : ''} · ${clock(s.start)}] ${s.text}`).join('\n');
}

// the last words so far, to keep the next chunk's spelling consistent
export function tail(text: string, chars = 220): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= chars) return s;
  const cut = s.slice(-chars - 1);
  const sp = cut.indexOf(' ');
  return (sp >= 0 ? cut.slice(sp + 1) : cut).trim();
}

export const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const round = (n: number) => Math.round(n * 100) / 100;

// the chunk a moment is in, and where in that chunk's own audio file it is
export function locate(chunks: Chunk[], at: number): { seq: number; offset: number } | null {
  let t = 0;
  for (const c of [...chunks].sort((a, b) => a.seq - b.seq)) {
    const d = c.ms / 1000;
    if (at < t + d) return { seq: c.seq, offset: Math.max(0, at - t) };
    t += d;
  }
  const last = [...chunks].sort((a, b) => a.seq - b.seq).pop();
  return last ? { seq: last.seq, offset: Math.max(0, last.ms / 1000 - 1) } : null;
}
