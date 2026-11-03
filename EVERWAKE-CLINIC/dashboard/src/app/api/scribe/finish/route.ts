import { type NextRequest } from 'next/server';
import { MODELS, hasKey, jsonCall, sse, transcribe, type Usage } from '@/lib/ai';
import { EXTRACT_SYSTEM, VERIFY_SCHEMA, VERIFY_SYSTEM, extractInput, transcribeHint, verifyInput, type ScribeCtx } from '@/lib/scribe/prompts';
import { extractionSchema, readExtraction } from '@/lib/scribe/schema';
import { applySpeakers, segmentsFromChunks, segmentsFromDiarized, type Segment } from '@/lib/scribe/transcript';
import { applyFlags, verifyExtraction, type Flag } from '@/lib/scribe/verify';
import { serverClient } from '@/lib/supabase/server';
import type { VisitContext } from '@/components/visit/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// The doctor pressed Stop. In named stages, streamed to the screen:
//   transcript  who said what (a diarised pass over each piece; the pieces' own words if it fails)
//   extract     the doctor's form filled, a quote behind every value
//   verify      every quote looked up in the transcript, then an independent model check;
//               whatever is not supported is emptied and flagged
// then saved for review. Nothing reaches the record until the doctor signs.
export async function POST(req: NextRequest) {
  const { recording_id, lang } = await req.json().catch(() => ({})) as { recording_id?: number; lang?: 'ar' | 'en' };
  const db = await serverClient();
  return sse(async (send) => {
    if (!hasKey()) throw new Error('NEEDS_OPENAI_KEY');
    const { data: r0 } = await db.from('recordings').select('id, appointment_id, chunks, audio_deleted_at, status').eq('id', Number(recording_id)).maybeSingle();
    const rec = r0 as { id: number; appointment_id: number; chunks: { seq: number; ms: number; text: string; path?: string }[]; audio_deleted_at: string | null; status: string } | null;
    if (!rec) throw new Error('Recording not found');
    if (rec.status === 'signed') throw new Error('ALREADY_SIGNED');
    const { data: c0, error: ce } = await db.rpc('visit_context', { p_appt: rec.appointment_id });
    if (ce) throw new Error(ce.message);
    const ctx = c0 as VisitContext;
    const models: Record<string, string> = {};
    const usage: Record<string, Usage | null> = {};
    try {
      // ---- 1. who said what -----------------------------------------------------------------
      send('stage', { key: 'transcript' });
      const chunks = [...rec.chunks].sort((a, b) => a.seq - b.seq);
      const audio = async (path: string) => {
        const { data, error } = await db.storage.from('clinic-recordings').download(path);
        if (error || !data) throw new Error(error?.message || 'audio missing');
        return data;
      };
      // a piece that was not heard while recording is heard now
      for (const c of chunks) {
        if (!c.text && c.path && !rec.audio_deleted_at && c.ms > 600) {
          try {
            c.text = (await transcribe(await audio(c.path), { model: MODELS.scribeTranscribe,
              prompt: transcribeHint({ patient: ctx.patient?.full_name, specialty: ctx.doctor?.specialty, terms: ctx.terms }), filename: c.path.split('/').pop() })).text.trim();
            await db.rpc('recording_chunk', { p_rec: rec.id, p: c });
          } catch { /* the rest of the visit still counts */ }
        }
      }
      models.transcribe = MODELS.scribeTranscribe;
      let segments: Segment[] = [];
      let diarized = false;
      if (MODELS.scribeDiarize !== 'off' && !rec.audio_deleted_at && chunks.every(c => c.path)) {
        try {
          const per = [];
          for (const c of chunks) {
            const d = await transcribe(await audio(c.path!), { model: MODELS.scribeDiarize, diarize: true, filename: c.path!.split('/').pop() });
            per.push({ seq: c.seq, ms: c.ms, segments: d.segments || [{ speaker: null, start: 0, end: c.ms / 1000, text: d.text }] });
          }
          segments = segmentsFromDiarized(per);
          diarized = segments.length > 0;
          models.diarize = MODELS.scribeDiarize;
        } catch { diarized = false; }
      }
      if (!diarized) segments = segmentsFromChunks(chunks);
      if (!segments.length) throw new Error('NOTHING_HEARD');
      send('transcript', { segments, diarized });

      // ---- 2. the form, filled with evidence ------------------------------------------------
      send('stage', { key: 'extract' });
      const ap = ctx.appointment;
      const sc: ScribeCtx = {
        date: ap.session_date, lang: lang === 'en' ? 'en' : 'ar',
        doctor: ctx.doctor?.name || '', specialty: ctx.doctor?.specialty || '',
        patient: { name: ctx.patient?.full_name || ap.patient || '', age: ctx.patient?.age, sex: ctx.patient?.sex },
        onFile: { allergies: ctx.record.allergies.map(a => a.substance), medications: ctx.record.medications.map(m => m.name), conditions: ctx.record.conditions.map(c => c.name) },
        preVisit: ap.pre_visit || {}, template: ctx.template
      };
      const ex = await jsonCall<unknown>({ model: MODELS.scribeExtract, system: EXTRACT_SYSTEM, user: extractInput(sc, segments),
        schema: extractionSchema(ctx.template), name: 'visit_note', timeout: 150_000 });
      models.extract = MODELS.scribeExtract; usage.extract = ex.usage;
      let x = readExtraction(ex.data, ctx.template);
      if (diarized && x.speakers.length) segments = applySpeakers(segments, x.speakers);
      await db.rpc('recording_transcript', { p_rec: rec.id, p: { segments, diarized, language: 'ar' } });

      // ---- 3. checking every field ----------------------------------------------------------
      send('stage', { key: 'verify' });
      const checked = verifyExtraction(x, segments);
      x = checked.extraction;
      let verification = checked.verification;
      try {
        const v = await jsonCall<{ flags: Flag[] }>({ model: MODELS.scribeVerify, system: VERIFY_SYSTEM, user: verifyInput(x, segments),
          schema: VERIFY_SCHEMA, name: 'scribe_check', timeout: 90_000 });
        models.verify = MODELS.scribeVerify; usage.verify = v.usage;
        const applied = applyFlags(x, verification, v.data.flags || []);
        x = applied.extraction; verification = { ...applied.verification, model_check: 'done' };
      } catch {
        verification = { ...verification, model_check: 'skipped' };
      }

      // ---- saved for the doctor's review ----------------------------------------------------
      const { data: saved, error: se } = await db.rpc('scribe_save', { p_rec: rec.id, p: {
        models, extraction: x, verification, usage,
        outputs: { soap: x.soap, summary_ar: x.summary_ar, prescription: x.prescription } } });
      if (se) throw new Error(se.message);
      send('done', { run_id: (saved as { run_id: number }).run_id, supported: verification.supported.length, flagged: verification.unsupported.length + verification.flags.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.rpc('recording_failed', { p_rec: rec.id, p_error: msg });
      throw e;
    }
  });
}
