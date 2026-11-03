// The doctor's assistant's tools. Reading runs at once, with the member's own session (row level
// security decides what they may see). Changing never runs at once: it becomes a card the member
// confirms (before → after), and only the confirm runs it, through the same functions the
// dashboard's own buttons use. A receptionist gets no clinical tools; the visit's tools exist only
// on the visit's page. Pure (the database is passed in), for `node --test`.

export interface Db { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }
export interface Page { kind: 'today' | 'patient' | 'visit' | 'inbox' | 'calendar' | 'other'; patient_id?: number; appointment_id?: number; conversation_id?: number; path?: string }
export interface Who { tenant: string; role: string; clinical: boolean; name?: string; doctor_id?: string | null; lang: 'ar' | 'en'; timezone: string; clinic?: string; page?: Page }
export interface Chip { kind: 'patient' | 'appointment' | 'conversation'; id: number; label: string }
export interface Proposal { tool: string; params: Record<string, unknown>; preview: Record<string, unknown>; summary: string }
type Json = Record<string, unknown>;

interface Base { name: string; label: { ar: string; en: string }; description: string; parameters: Json; clinical?: boolean; edit?: boolean; visitOnly?: boolean }
export interface ReadTool extends Base { kind: 'read'; run(a: Json, db: Db, w: Who): Promise<{ result: unknown; chips?: Chip[] }> }
export interface WriteTool extends Base { kind: 'write'; preview(a: Json, db: Db, w: Who): Promise<Proposal>; apply(params: Json, db: Db, w: Who): Promise<{ ok: boolean; result: unknown; summary: string }> }
export interface ClientTool extends Base { kind: 'client' }
export type Tool = ReadTool | WriteTool | ClientTool;

const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = { type: 'string' }, N = { type: 'number' }, I = { type: 'integer' }, B = { type: 'boolean' };
const date = { type: 'string', description: 'YYYY-MM-DD, in the clinic’s own days' };

async function call<T = Json>(db: Db, fn: string, args: Json): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
const hm = (iso: unknown, tz: string) => typeof iso === 'string' && iso
  ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : null;
const day = (iso: unknown, tz: string) => typeof iso === 'string' && iso ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso)) : null;
const L = (w: Who, ar: string, en: string) => (w.lang === 'en' ? en : ar);
const appt = (a: Json, tz: string) => ({ id: a.id, ref_no: a.ref_no, patient: a.patient, patient_id: a.patient_id, date: a.session_date,
  time: hm(a.est_at || a.starts_at, tz), status: a.status, service: a.service, queue_no: a.queue_no ?? undefined, delay_minutes: a.delay_minutes || undefined,
  doctor_id: a.doctor_id, conversation_id: a.conversation_id ?? undefined, reason: a.reason || undefined });
const sessions = (d: Json, tz: string) => ((d.sessions as Json[]) || []).map(s => ({ doctor: s.doctor, doctor_id: s.doctor_id, location: s.location,
  from: hm(s.starts_at, tz), to: hm(s.ends_at, tz), delay_minutes: s.delay_minutes || 0, mode: s.mode,
  appointments: ((s.appointments as Json[]) || []).map(a => appt(a, tz)) }));
const apptChips = (list: { id: unknown; patient: unknown; time: unknown }[]) =>
  list.slice(0, 6).map(a => ({ kind: 'appointment' as const, id: Number(a.id), label: `${a.time || ''} ${a.patient || ''}`.trim() }));

export const TOOLS: Tool[] = [
  // ---- reading ------------------------------------------------------------------------------
  { kind: 'read', name: 'search_patients', label: { ar: 'بيدوّر على المريض', en: 'Looking up the patient' },
    description: 'Find patients by name, phone or file number. Use it before anything about a patient you do not have an id for.',
    parameters: obj({ query: S }, ['query']),
    async run(a, db, w) {
      const rows = await call<Json[]>(db, 'patient_search', { p_tenant: w.tenant, p_q: String(a.query || ''), p_limit: 8 });
      const list = (rows || []).map(p => ({ id: p.id, full_name: p.full_name, file_no: p.file_no, phone: p.phone, age: p.age, last_visit_at: day(p.last_visit_at, w.timezone) }));
      return { result: list, chips: list.slice(0, 5).map(p => ({ kind: 'patient', id: Number(p.id), label: String(p.full_name) })) };
    } },
  { kind: 'read', name: 'patient_summary', label: { ar: 'بيقرا ملف المريض', en: 'Reading the patient’s file' },
    description: 'One patient’s file: details, allergies, conditions, medicines, recent and upcoming visits, recent notes, teeth and plans (clinical parts only for doctors and nurses).',
    parameters: obj({ patient_id: I }, ['patient_id']),
    async run(a, db, w) {
      const p = await call<Json>(db, 'patient_profile', { p_patient: Number(a.patient_id) });
      const pt = (p.patient || {}) as Json;
      const ap = ((p.appointments as Json[]) || []).map(x => appt(x, w.timezone));
      const now = new Date().toISOString().slice(0, 10);
      const result = {
        patient: { id: pt.id, full_name: pt.full_name, file_no: pt.file_no, sex: pt.sex, age: pt.age, phone: pt.phone, visits: pt.visits_count, missed: pt.no_show_count, notes: pt.notes },
        conversation_id: ((p.contacts as Json[]) || []).find(c => c.conversation_id)?.conversation_id ?? null,
        upcoming: ap.filter(x => String(x.date) >= now && !['cancelled', 'done', 'no_show'].includes(String(x.status))).slice(0, 3),
        past: ap.filter(x => String(x.date) < now || x.status === 'done').slice(0, 4),
        ...(p.clinical ? {
          allergies: ((p.allergies as Json[]) || []).filter(x => x.status !== 'inactive').map(x => [x.substance, x.reaction].filter(Boolean).join(' — ')),
          conditions: ((p.conditions as Json[]) || []).filter(x => x.status !== 'resolved').map(x => x.name),
          medications: ((p.medications as Json[]) || []).filter(x => x.status === 'active').map(x => [x.name, x.dose].filter(Boolean).join(' ')),
          notes: ((p.encounters as Json[]) || []).slice(0, 3).map(e => ({ id: e.id, date: day(e.started_at, w.timezone), status: e.status, complaint: e.chief_complaint, assessment: e.assessment, plan: e.plan, follow_up: e.follow_up_date })),
          teeth: ((p.dental_chart as Json[]) || []).filter(x => x.condition !== 'healthy').map(x => ({ tooth: x.tooth, condition: x.condition, planned: x.planned || undefined })),
          plans: ((p.plans as Json[]) || []).slice(0, 2).map(x => ({ id: x.id, title: x.title, status: x.status, total: x.total, items: ((x.items as Json[]) || []).map(i => `${i.tooth ? i.tooth + ' ' : ''}${i.label} (${i.status})`) }))
        } : { clinical: 'Medical records are for the doctors and nurses.' })
      };
      return { result, chips: [{ kind: 'patient', id: Number(pt.id), label: String(pt.full_name || '') }] };
    } },
  { kind: 'read', name: 'today', label: { ar: 'بيبص على اليوم', en: 'Looking at the day' },
    description: 'A day at the clinic (today by default): each doctor’s session, who is booked when, who is waiting, with the doctor or done, the delay, and what needs someone.',
    parameters: obj({ date, doctor_id: S }),
    async run(a, db, w) {
      const d = await call<Json>(db, 'today_board', { p_tenant: w.tenant, p_date: a.date || null, p_doctor: a.doctor_id || null });
      const s = sessions(d, w.timezone);
      return { result: { date: d.date, sessions: s, counts: d.counts, waiting_room: ((d.waiting_room as Json[]) || []).map(x => appt(x, w.timezone)),
                         alerts: ((d.alerts as Json[]) || []).slice(0, 5).map(x => ({ kind: x.kind, title: x.title, body: x.body })) },
               chips: apptChips(s.flatMap(x => x.appointments).filter(x => ['arrived', 'in_visit', 'confirmed', 'booked'].includes(String(x.status)))) };
    } },
  { kind: 'read', name: 'appointments', label: { ar: 'بيشوف المواعيد', en: 'Checking the appointments' },
    description: 'Every appointment between two days (up to 31), optionally for one doctor.',
    parameters: obj({ from: date, to: date, doctor_id: S }, ['from', 'to']),
    async run(a, db, w) {
      const d = await call<Json>(db, 'calendar_range', { p_tenant: w.tenant, p_from: a.from, p_to: a.to, p_doctor: a.doctor_id || null });
      return { result: { sessions: sessions(d, w.timezone).map(s => ({ ...s, date: undefined })), days: ((d.sessions as Json[]) || []).map(s => s.date) } };
    } },
  { kind: 'read', name: 'free_slots', label: { ar: 'بيدوّر على ميعاد فاضي', en: 'Finding a free time' },
    description: 'Free times to book: the same ones the WhatsApp assistant offers. Filter by doctor, service, days and part of the day.',
    parameters: obj({ doctor_id: S, service_id: S, patient_id: I, from: date, to: date, band: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'] } }),
    async run(a, db, w) {
      const d = await call<Json>(db, 'dashboard_slots', { p_tenant: w.tenant, p: { ...a, limit: 12, staff: true } });
      return { result: { slots: ((d.slots as Json[]) || []).slice(0, 12).map(s => ({ kind: s.kind, doctor_id: s.doctor_id, doctor: s.doctor, location_id: s.location_id,
        resource_id: s.resource_id, date: s.date, time: s.time, starts_at: s.starts_at, label: L(w, String(s.label_ar), String(s.label_en)), queue_no: s.queue_no })),
        none_because: d.none_because || null } };
    } },
  { kind: 'read', name: 'alerts', label: { ar: 'بيشوف التنبيهات', en: 'Checking the alerts' },
    description: 'What needs someone now: emergencies, patients who did not answer, questions waiting.',
    parameters: obj({}),
    async run(_a, db, w) {
      const d = await call<Json[]>(db, 'alert_list', { p_tenant: w.tenant, p_status: 'open', p_limit: 10 });
      return { result: (d || []).map(x => ({ id: x.id, kind: x.kind, severity: x.severity, title: x.title, body: x.body, at: x.created_at, patient_id: x.patient_id, conversation_id: x.conversation_id })) };
    } },
  { kind: 'read', name: 'chat_of', label: { ar: 'بيقرا المحادثة', en: 'Reading the chat' },
    description: 'The WhatsApp chat with a patient (the last 20 messages). Needs the conversation_id from patient_summary or alerts.',
    parameters: obj({ conversation_id: I }, ['conversation_id']),
    async run(a, db) {
      const d = await call<Json>(db, 'inbox_thread', { p_conversation: Number(a.conversation_id), p_limit: 20 });
      return { result: ((d.messages as Json[]) || []).slice(-20).map(m => ({ from: m.direction === 'inbound' ? 'patient' : m.sender, text: m.body, at: m.created_at })),
               chips: [{ kind: 'conversation', id: Number(a.conversation_id), label: String(((d.conversation as Json) || {}).name || '') }] };
    } },
  { kind: 'read', name: 'stats', label: { ar: 'بيحسب الأرقام', en: 'Counting' },
    description: 'The clinic’s numbers for a period: bookings, done, missed, cancelled, new patients, by source and doctor, collected, delays.',
    parameters: obj({ from: date, to: date }, ['from', 'to']),
    async run(a, db, w) { return { result: await call(db, 'assistant_stats', { p_tenant: w.tenant, p_from: a.from, p_to: a.to }) }; } },

  // ---- changing: a card to confirm, never at once -------------------------------------------
  { kind: 'write', name: 'announce_delay', label: { ar: 'تأخير', en: 'Running late' },
    description: 'The doctor is running late today: every later patient’s time moves by the minutes and they are told on WhatsApp (they can accept, pick another time or cancel).',
    parameters: obj({ minutes: I, doctor_id: S, reason: S }, ['minutes']),
    async preview(a, db, w) {
      const params = { doctor_id: a.doctor_id || w.doctor_id || null, minutes: Number(a.minutes), reason: a.reason || null };
      const p = await call<Json>(db, 'dashboard_delay', { p_tenant: w.tenant, p: { ...params, preview: true } });
      if (p.ok === false) throw new Error(String(p.error || 'NOT_POSSIBLE'));
      const items = ((p.items as Json[]) || []).map(i => ({ patient: i.patient, from: i.old_time, to: i.new_time, whatsapp: i.whatsapp }));
      return { tool: 'announce_delay', params, preview: { doctor: p.doctor, minutes: p.minutes, count: p.count, items: items.slice(0, 8) },
               summary: L(w, `تأخير ${params.minutes} دقيقة — ${p.count} مرضى هيتبلغوا بالميعاد الجديد`, `${params.minutes} min late — ${p.count} patients told their new time`) };
    },
    async apply(params, db, w) {
      const r = await call<Json>(db, 'dashboard_delay', { p_tenant: w.tenant, p: { ...params, preview: false } });
      return { ok: r.ok !== false, result: r, summary: L(w, `اتبعت لـ ${r.messaged ?? 0} مرضى`, `Sent to ${r.messaged ?? 0} patients`) };
    } },
  { kind: 'write', name: 'block_time', edit: true, label: { ar: 'وقت مقفول', en: 'Block time' },
    description: 'Time off for a doctor: a few hours or whole days. Nothing new is booked inside; bookings already there stay until moved.',
    parameters: obj({ doctor_id: S, date, to_date: date, from_time: { type: 'string', description: 'HH:MM' }, to_time: { type: 'string', description: 'HH:MM' }, reason: S }, ['date']),
    async preview(a, db, w) {
      const params = { doctor_id: a.doctor_id || w.doctor_id || null, date: a.date, to_date: a.to_date || a.date, from_time: a.from_time || null, to_time: a.to_time || null, reason: a.reason || null };
      const p = await call<Json>(db, 'dashboard_block_time', { p_tenant: w.tenant, p: { ...params, preview: true } });
      const when = `${params.date}${params.to_date !== params.date ? ' → ' + params.to_date : ''}${params.from_time ? ` ${params.from_time}–${params.to_time}` : ''}`;
      return { tool: 'block_time', params, preview: { when, bookings_inside: p.bookings_inside ?? 0 },
               summary: L(w, `قفل ${when}${p.bookings_inside ? ` — جواه ${p.bookings_inside} حجوزات` : ''}`, `Block ${when}${p.bookings_inside ? ` — ${p.bookings_inside} bookings inside` : ''}`) };
    },
    async apply(params, db, w) {
      const r = await call<Json>(db, 'dashboard_block_time', { p_tenant: w.tenant, p: params });
      return { ok: r.ok !== false, result: r, summary: L(w, 'اتقفل', 'Blocked') };
    } },
  { kind: 'write', name: 'catalog_change', edit: true, label: { ar: 'الأسعار والخدمات', en: 'Prices and services' },
    description: 'Change the services, prices, offers, questions and answers or rules the WhatsApp assistant uses. changes: [{op, …}] with op one of set_price, add_service, update_service, remove_service, add_faq, update_faq, remove_faq, add_offer, end_offer, add_rule, remove_rule (service by its name).',
    parameters: obj({ changes: { type: 'array', items: { type: 'object' } } }, ['changes']),
    async preview(a, db, w) {
      const p = await call<Json>(db, 'catalog_change', { p_tenant: w.tenant, p_changes: a.changes, p_apply: false, p_source: 'assistant' });
      if (p.ok === false) throw new Error(String(((p.problems as Json[]) || [])[0]?.problem || p.error || 'NOTHING_TO_CHANGE'));
      return { tool: 'catalog_change', params: { change_id: p.change_id }, preview: { lines: String(p.summary_ar || '').split('\n') }, summary: String(p.summary_ar || '') };
    },
    async apply(params, db, w) {
      const r = await call<Json>(db, 'catalog_apply', { p_change: Number(params.change_id) });
      return { ok: r.ok !== false, result: r, summary: L(w, 'اتغير، والمساعد على الواتساب هيقول الجديد', 'Changed; the WhatsApp assistant now says the new one') };
    } },
  { kind: 'write', name: 'book', label: { ar: 'حجز', en: 'Book' },
    description: 'Book a visit at a free time from free_slots. A known patient by patient_id, or a new one with full_name and phone.',
    parameters: obj({ patient_id: I, full_name: S, phone: S, doctor_id: S, service_id: S, location_id: S, resource_id: S, kind: { type: 'string', enum: ['slot', 'queue'] },
                      starts_at: { type: 'string', description: 'the slot’s starts_at, exactly' }, date, notify: B }, ['doctor_id', 'date']),
    async preview(a, _db, w) {
      if (!a.patient_id && !a.full_name) throw new Error('WHO_TO_BOOK');
      const params = { doctor_id: a.doctor_id, service_id: a.service_id || null, location_id: a.location_id || null, resource_id: a.resource_id || null,
        kind: a.kind || 'slot', starts_at: a.starts_at || null, date: a.date, notify: a.notify !== false,
        patient_id: a.patient_id || null, patient: a.patient_id ? null : { full_name: a.full_name, phone: a.phone || null } };
      const when = `${a.date}${a.starts_at ? ' ' + hm(a.starts_at, w.timezone) : ''}`;
      return { tool: 'book', params, preview: { patient: a.full_name || `#${a.patient_id}`, when },
               summary: L(w, `حجز ${a.full_name || ''} يوم ${when}`, `Book ${a.full_name || ''} on ${when}`).replace(/\s+/g, ' ') };
    },
    async apply(params, db, w) {
      const r = await call<Json>(db, 'staff_book', { p_tenant: w.tenant, p: params });
      const ap = (r.appointment || {}) as Json;
      return { ok: r.ok !== false && !r.error, result: r, summary: r.error ? String(r.error) : L(w, `اتحجز — ${ap.ref_no || ''}`, `Booked — ${ap.ref_no || ''}`) };
    } },
  { kind: 'write', name: 'reschedule', label: { ar: 'تغيير ميعاد', en: 'Move a visit' },
    description: 'Move a booked visit to another free time (from free_slots with ignore of this visit). The patient is told on WhatsApp unless notify is false.',
    parameters: obj({ appointment_id: I, starts_at: S, date, kind: { type: 'string', enum: ['slot', 'queue'] }, location_id: S, notify: B }, ['appointment_id', 'date']),
    async preview(a, _db, w) {
      const params = { appointment_id: Number(a.appointment_id), starts_at: a.starts_at || null, date: a.date, kind: a.kind || 'slot', location_id: a.location_id || null, notify: a.notify !== false };
      const when = `${a.date}${a.starts_at ? ' ' + hm(a.starts_at, w.timezone) : ''}`;
      return { tool: 'reschedule', params, preview: { to: when }, summary: L(w, `نقل الميعاد ليوم ${when}`, `Move it to ${when}`) };
    },
    async apply(params, db, w) {
      const { appointment_id, ...p } = params;
      const r = await call<Json>(db, 'move_appointment', { p_appt: appointment_id, p });
      return { ok: r.ok !== false && !r.error, result: r, summary: r.error ? String(r.error) : L(w, 'اتنقل', 'Moved') };
    } },
  { kind: 'write', name: 'cancel', label: { ar: 'إلغاء', en: 'Cancel' },
    description: 'Cancel a visit. The patient is told on WhatsApp unless notify is false.',
    parameters: obj({ appointment_id: I, reason: S, notify: B }, ['appointment_id']),
    async preview(a, _db, w) {
      return { tool: 'cancel', params: { appointment_id: Number(a.appointment_id), reason: a.reason || null, notify: a.notify !== false },
               preview: { reason: a.reason || null }, summary: L(w, 'إلغاء الميعاد', 'Cancel the visit') };
    },
    async apply(params, db, w) {
      const r = await call<Json>(db, 'set_appointment_status', { p_appt: params.appointment_id, p_status: 'cancelled', p_note: params.reason, p_notify: params.notify });
      return { ok: (r || {}).ok !== false, result: r, summary: L(w, 'اتلغى', 'Cancelled') };
    } },
  { kind: 'write', name: 'message_patient', label: { ar: 'رسالة للمريض', en: 'Message the patient' },
    description: 'Send the patient a WhatsApp message from the clinic, in the clinic’s voice. Needs the conversation_id.',
    parameters: obj({ conversation_id: I, text: S }, ['conversation_id', 'text']),
    async preview(a, _db, w) {
      return { tool: 'message_patient', params: { conversation_id: Number(a.conversation_id), text: String(a.text || '') },
               preview: { text: a.text }, summary: L(w, 'رسالة على الواتساب', 'A WhatsApp message') };
    },
    async apply(params, db, w) {
      const r = await call<Json>(db, 'send_staff_message', { p_conversation: params.conversation_id, p_body: params.text });
      return { ok: (r || {}).ok !== false, result: r, summary: L(w, 'اتبعتت', 'Sent') };
    } },
  { kind: 'write', name: 'update_dental_chart', clinical: true, label: { ar: 'خريطة الأسنان', en: 'Dental chart' },
    description: 'Update teeth on the patient’s dental chart, only as the doctor said: [{tooth (FDI), condition, planned, surfaces}].',
    parameters: obj({ patient_id: I, teeth: { type: 'array', items: obj({ tooth: I, condition: S, planned: S, surfaces: { type: 'array', items: S } }, ['tooth', 'condition']) } }, ['patient_id', 'teeth']),
    async preview(a, _db, w) {
      const teeth = (a.teeth as Json[]) || [];
      return { tool: 'update_dental_chart', params: { patient_id: Number(a.patient_id), teeth }, preview: { teeth },
               summary: L(w, `تحديث ${teeth.length} سنان: ${teeth.map(x => x.tooth).join('، ')}`, `Update ${teeth.length} teeth: ${teeth.map(x => x.tooth).join(', ')}`) };
    },
    async apply(params, db, w) {
      const r = await call(db, 'set_teeth', { p_patient: params.patient_id, p_teeth: params.teeth });
      return { ok: true, result: r, summary: L(w, 'الخريطة اتحدثت', 'Chart updated') };
    } },
  { kind: 'write', name: 'build_treatment_plan', clinical: true, label: { ar: 'خطة علاج', en: 'Treatment plan' },
    description: 'A treatment plan for the patient, from what the doctor said: title and items [{tooth, label, price, sessions}]. Prices from the clinic’s services when the doctor did not say one.',
    parameters: obj({ patient_id: I, title: S, items: { type: 'array', items: obj({ tooth: I, label: S, price: N, sessions: I, service_id: S }, ['label']) } }, ['patient_id', 'items']),
    async preview(a, _db, w) {
      const items = (a.items as Json[]) || [];
      const total = items.reduce((n, i) => n + (Number(i.price) || 0), 0);
      return { tool: 'build_treatment_plan', params: { patient_id: Number(a.patient_id), title: a.title || L(w, 'خطة العلاج', 'Treatment plan'), items, doctor_id: w.doctor_id || null },
               preview: { items, total }, summary: L(w, `خطة علاج — ${items.length} بنود${total ? ` · ${total}` : ''}`, `Treatment plan — ${items.length} items${total ? ` · ${total}` : ''}`) };
    },
    async apply(params, db, w) {
      const { patient_id, ...p } = params;
      const r = await call(db, 'save_plan', { p_patient: patient_id, p });
      return { ok: true, result: r, summary: L(w, 'الخطة اتحفظت', 'Plan saved') };
    } },

  // ---- the open visit (on its page only): filled on the screen, signed by the doctor ----------
  { kind: 'client', name: 'fill_visit_fields', clinical: true, visitOnly: true, label: { ar: 'بيملا الكشف', en: 'Filling the visit' },
    description: 'Fill fields of the visit open on the screen, from what the doctor just said: fields [{key: "section.field", value}], and chief_complaint, assessment, plan, follow_up (YYYY-MM-DD). The doctor still reviews and signs.',
    parameters: obj({ fields: { type: 'array', items: obj({ key: S, value: {} }, ['key', 'value']) }, chief_complaint: S, assessment: S, plan: S, follow_up: date }) },
  { kind: 'client', name: 'draft_prescription', clinical: true, visitOnly: true, label: { ar: 'روشتة', en: 'Prescription' },
    description: 'Put the medicines the DOCTOR just dictated on the open visit’s prescription: lines [{name, dose, frequency, duration}]. Never add or complete a medicine yourself.',
    parameters: obj({ lines: { type: 'array', items: obj({ name: S, dose: S, frequency: S, duration: S }, ['name']) } }, ['lines']) }
];

// what this member may use on this page
export function toolsFor(w: Pick<Who, 'role' | 'clinical' | 'page'>, all: Tool[] = TOOLS): Tool[] {
  const editor = ['owner', 'manager', 'doctor'].includes(w.role);
  return all.filter(t => (!t.clinical || w.clinical) && (!t.edit || editor) && (!t.visitOnly || w.page?.kind === 'visit'));
}

// the tools as the model sees them
export const asFunctions = (list: Tool[]) =>
  list.map(t => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters, strict: false }));

// The confirm card's button: the change runs now, through the same functions, and its result is
// recorded with the card.
export async function applyProposal(tool: string, params: Json, db: Db, w: Who): Promise<{ ok: boolean; result: unknown; summary: string }> {
  const t = toolsFor(w).find(x => x.name === tool);
  if (!t || t.kind !== 'write') return { ok: false, result: null, summary: 'NOT_ALLOWED' };
  return t.apply(params, db, w);
}

export function instructions(w: Who, today: string): string {
  const page = w.page;
  return `You are the assistant inside ${w.clinic ? `the ${w.clinic} clinic’s` : 'a clinic’s'} dashboard (Everwake Clinic), talking with ${w.name || 'a member of the team'} (${w.role}${w.clinical ? ', clinical' : ''}).
Today is ${today} (${w.timezone}). Answer in ${w.lang === 'en' ? 'English' : 'Egyptian Arabic, warm and short, as colleagues talk'}; match the language they write in.

How you work:
- Look things up with the tools; never guess a name, a time, a price or a number. Times are the clinic’s own.
- Keep answers short: the answer first, then at most 3–5 lines. Names and times exactly as the tools gave them.
- Anything that changes something (a delay, a booking, a message, a price, the chart, a plan) is a CARD the member confirms. Your call only prepares it. Say what the card will do and that it waits for their confirm; never say it is done.
- You never diagnose and never prescribe on your own. A prescription, a dose or a diagnosis is only what the doctor said, in their words. Questions of medical judgement go back to the doctor.
- Medical records are only for doctors and nurses${w.clinical ? '' : ' — this member is not one, so you have no clinical tools; say so kindly if asked'}.
- If a tool says something is not allowed or not possible, say it plainly with what they can do instead.
${page?.kind === 'patient' ? `- They are looking at patient ${page.patient_id}'s file: "this patient" means patient_id ${page.patient_id}.\n` : ''}${page?.kind === 'visit' ? `- They are in the visit of appointment ${page.appointment_id}${page.patient_id ? ` (patient_id ${page.patient_id})` : ''}. What the doctor dictates goes into the open form with fill_visit_fields and draft_prescription (keys are "section.field" from the form).\n` : ''}${page?.kind === 'inbox' && page.conversation_id ? `- They have the chat ${page.conversation_id} open.\n` : ''}`;
}
