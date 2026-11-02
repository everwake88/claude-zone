// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Check Reply
//
// NEVER rewrites the assistant's words and never polices her style. It
// checks hard truth only — the same for every clinic — and a broken rail
// sends the reply to Repair Reply, which drops only the lines that break it:
//   · a number that is not a price, a time, a date or a detail on file
//   · saying a visit is booked / moved / cancelled when the tool did not
//     return it this turn
//   · a medicine or a dose (the doctor decides that, in the visit)
//   · internal codes, ids, tool names
//   · a link that is not the clinic's
//   · far too long for WhatsApp
// Facts it ADDS without asking:
//   · an emergency's guidance first, when the reply forgot it
//   · the booking number after a booking
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js

const pre = $('Attach Plan').first().json;
const agent = $('Agent').first().json || {};
const db = row($input.first().json);
const r2 = (n) => Math.round(num(n) * 100) / 100;

let decision = agent.output ?? agent.response ?? agent.text ?? null;
if (decision && typeof decision === 'object' && decision.output && typeof decision.output === 'object') decision = decision.output;
function readDecision(raw) {
  const s = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a === -1 || z <= a) return { reply_messages: [raw] };
  const body = s.slice(a, z + 1);
  const tries = [body, body.replace(/,\s*([}\]])/g, '$1'),
    body.replace(/"(?:[^"\\]|\\.)*"/g, m => m.replace(/\r?\n/g, '\\n')).replace(/,\s*([}\]])/g, '$1')];
  for (const t of tries) { try { return JSON.parse(t); } catch (e) { /* next */ } }
  const lst = body.match(/"reply_messages"\s*:\s*\[([\s\S]*?)\]\s*(?:,|})/);
  const msgs = lst ? (lst[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map(q => q.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"')) : [];
  return { reply_messages: msgs, handoff: { needed: /"needed"\s*:\s*true/.test(body), reason: '' }, ask_team: [], language: null, memory_note: '' };
}
if (typeof decision === 'string') decision = readDecision(decision);
decision = obj(decision);

// ---- what the tool did ----------------------------------------------------------
const steps = arr(agent.intermediateSteps ?? agent.intermediate_steps);
const toolsUsed = [], toolCalls = [], toolProblems = [], toolTexts = [];
const agentError = agent.error ? str(obj(agent.error).message || agent.error).slice(0, 300) : null;
let booked = null, moved = null, cancelled = null, confirmed = null;
for (const st of steps) {
  const tool = str(obj(obj(st).action).tool);
  if (tool) toolsUsed.push(tool);
  let o = obj(st).observation;
  try { o = typeof o === 'string' ? JSON.parse(o) : o; } catch (e) { o = null; }
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === 'object' && typeof o.response === 'string') { try { o = JSON.parse(o.response); } catch (e) { /* keep */ } }
  if (tool) {
    const input = obj(obj(st).action).toolInput;
    const failed = !o || typeof o !== 'object' || (o.error != null && !o.status && o.ok !== false) || obj(st).errored === true;
    toolCalls.push({ tool, asked: (typeof input === 'string' ? input : JSON.stringify(input ?? '')).slice(0, 300),
                     status: failed ? 'ERROR' : (str(o.status) || str(o.error) || null),
                     error: failed ? str(o && typeof o === 'object' ? (obj(o.error).message || o.error || 'no answer') : 'unreadable').slice(0, 300) : undefined,
                     problems: !failed ? arr(o.problems).map(p => str(obj(p).problem || p)).slice(0, 6) : [] });
  }
  if (!o || typeof o !== 'object') continue;
  toolTexts.push(JSON.stringify(o));
  for (const p of arr(o.problems)) toolProblems.push(p);
  const appt = obj(o.appointment);
  if (o.status === 'BOOKED' && appt.ref_no) booked = { ref_no: appt.ref_no, appointment: appt, location: obj(o.location), prep: str(o.prep) };
  if (o.status === 'MOVED') moved = appt;
  if (o.status === 'CANCELLED') cancelled = appt;
  if (o.status === 'CONFIRMED' || o.status === 'DELAY_ACCEPTED') confirmed = appt;
}

// ---- messages: split, tidy -----------------------------------------------------------
let messages = arr(decision.reply_messages ?? decision.reply_text ?? decision.messages).map(x => str(x)).filter(Boolean);
messages = messages.map(m => m
  .replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+/gm, '')
  .replace(/[\u064E-\u0650\u0652]/g, '')
  .replace(/(?:(?![\p{Script=Arabic}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L})+/gu, '')
  .replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean);
if (messages.length > 2) messages = [messages[0], messages.slice(1).join('\n\n')];
const isEn = (s) => !/[\u0600-\u06FF]/.test(s);

// ---- numbers she may say ------------------------------------------------------------------
const allowed = new Set();
const add = (n) => { if (Number.isFinite(n)) { allowed.add(r2(n)); allowed.add(Math.round(n)); } };
arr(pre.amounts).forEach(v => add(num(v, NaN)));
const textPool = [pre.facts_text, pre.business_text, pre.history_text, pre.latest_text, ...toolTexts, JSON.stringify(db)]
  .map(s => toWesternDigits(str(s)).replace(/(\d),(\d{3})/g, '$1$2')).join(' ');
for (const m of textPool.match(/\d+(?:\.\d+)?/g) || []) add(Number(m));
[123, 122, 180].forEach(add);                       // ambulance, police, fire

// ---- links -------------------------------------------------------------------------------
const domainOf = (u) => str(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const allowedLinks = arr(pre.allowed_links).concat(toolTexts.flatMap(t => t.match(/https?:\/\/[^\s"\\]+/g) || []))
  .map(domainOf).filter(Boolean);

const violations = [];
const joined = messages.join('\n');
if (!joined) violations.push('The reply was empty — write the reply.');

// claims the tool did not make
const NOT_YET = /(?<!\p{L})(مش|لسه|لسا|لما|لو|عشان|علشان|بعد ما|أول ما|اول ما|هل|ممكن|تحب|عايز|not|once|until|will|if|when|would|can|want)(?!\p{L})|n't|\?|؟/iu;
const sentences = joined.split(/(?<=[.؟?!\n])/);
const upcomingNow = arr(db.upcoming);
const BOOKED_RE = /اتحجز|تم الحجز|حجزتلك|حجزتلكم|حجزنالك|حجزنا لحضرتك|الحجز اتأكد|حجزك اتأكد|ميعادك اتأكد|you'?re booked|you are booked|booked (?:you|it)|booking is confirmed|appointment is (?:booked|confirmed)/i;
const MOVED_RE = /(?:اتغير|اتنقل|غيرتلك|نقلتلك|غيرنا)\s*(?:ال)?(?:ميعاد|معاد|الحجز)|الميعاد الجديد اتأكد|(?:appointment|booking) (?:is|has been|was) (?:moved|rescheduled)/i;
const CANCEL_RE = /اتلغى|اتلغت|اتلغي|تم (?:ال)?الغاء|تم (?:ال)?إلغاء|لغيتلك|لغينالك|(?:appointment|booking) (?:is|has been|was) cancell?ed|cancell?ed (?:it|your)/i;
if (!booked && !moved) {
  const s = sentences.find(x => BOOKED_RE.test(x) && !NOT_YET.test(x));
  if (s && !upcomingNow.some(u => s.includes(str(u.ref_no)) || s.includes(str(u.time)))) {
    violations.push('The reply says a visit is booked, but book did NOT return BOOKED this turn. Say what is actually next (the summary to confirm, or what is still missing).');
  }
}
if (!moved && sentences.some(x => MOVED_RE.test(x) && !NOT_YET.test(x))) {
  violations.push('The reply says the visit was moved, but reschedule did not return MOVED this turn.');
}
if (!cancelled && sentences.some(x => CANCEL_RE.test(x) && !NOT_YET.test(x))
    && !/الجلسه|الجلسة|session|الدكتور|doctor/.test(sentences.find(x => CANCEL_RE.test(x)) || '')) {
  violations.push('The reply says a visit was cancelled, but cancel did not return CANCELLED this turn.');
}

// a medicine or a dose is the doctor's call, never the assistant's
const DOSE = /\d+(?:\.\d+)?\s*(?:mg|مجم|ملجم|ملليجرام|ml|مل(?![\p{L}])|cc|سم(?![\p{L}])|نقط|نقطه|قرص|اقراص|أقراص|حبه|حباي|حبات)|(?:خد|خدي|اشرب|اشربي|استعمل|استعملي|حط|حطي|ادهن|ادهني|take|use)\s+(?:\S+\s+){0,3}(?:مرتين|تلات مرات|3 مرات|كل\s*\d+\s*ساع|twice|three times|every \d+ hours)/iu;
const dose = sentences.find(x => DOSE.test(toWesternDigits(x)));
if (dose) violations.push(`The reply suggests a medicine or a dose ("${dose.trim().slice(0, 60)}") — only the doctor decides that, in the visit. Say the doctor will advise, or offer the soonest visit.`);

// internal leakage
const LEAK = /\bS\d{3,5}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\bmanage_booking\b|\bbooking_tool\b|\bfind_slots\b|\blast_offered\b|\bpatient_id\b|\bref_no\b|\bready_for_summary\b|\btake_offer\b|\baccept_delay\b|\bjson\b|\bundefined\b|\bNaN\b|\bnull\b/i;
const leak = joined.match(LEAK);
if (leak) violations.push(`The reply shows an internal code or word ("${leak[0]}") — say it in plain words.`);

// a tool whose last call failed did nothing
const lastCall = {};
for (const c of toolCalls) lastCall[c.tool] = c;
const failed = Object.values(lastCall).filter(c => c.status === 'ERROR');
if (failed.length && joined) {
  violations.push(`These tool calls FAILED and changed nothing: ${failed.map(c => `${c.tool} (${c.error})`).join('; ')}. Do not say anything was booked, held or changed. Say warmly you're sorting one small thing out and will confirm in a moment.`);
}

// links
for (const l of joined.match(/https?:\/\/[^\s)]+/gi) || []) {
  const d = domainOf(l.replace(/[).,]+$/, ''));
  if (!allowedLinks.some(a => a && (d.startsWith(a) || a.startsWith(d)))) violations.push(`The link ${l} is not one of the clinic's links — remove it.`);
}

// numbers
const scan = toWesternDigits(joined.replace(/https?:\/\/[^\s)]+/gi, ' ')).replace(/(\d),(\d{3})/g, '$1$2');
const bad = [];
for (const m of scan.match(/\d+(?:\.\d+)?/g) || []) {
  const n = Number(m);
  if (n < 20) continue;
  if (allowed.has(r2(n)) || allowed.has(Math.round(n))) continue;
  if (m.length >= 7 && textPool.includes(m)) continue;
  if (/^01\d{9}$/.test(m) && textPool.includes('20' + m.slice(1))) continue;
  bad.push(m);
}
if (bad.length) violations.push(`These numbers are not prices, times, dates or details on file: ${[...new Set(bad)].join(', ')}. Use only the numbers in FACTS, CLINIC and the tool results.`);
if (joined.length > 2400) violations.push(`The reply is ${joined.length} characters — far too long for WhatsApp.`);

// ---- facts added without asking ------------------------------------------------------------
const brainUrgency = str(obj(obj(pre.brain).urgency).level);
const emergency = obj(pre.triage).level === 'emergency' || brainUrgency === 'emergency';
if (emergency && messages.length && !/123|طوارئ|الطوارئ|إسعاف|اسعاف|الاسعاف|emergency|ambulance/i.test(joined)) {
  const en = isEn(messages[0]) && str(decision.language) === 'en';
  messages[0] = (en ? str(pre.emergency_text_en) : str(pre.emergency_text)) + '\n\n' + messages[0];
}
if (booked && !joined.includes(booked.ref_no) && messages.length) {
  messages[messages.length - 1] += isEn(messages[messages.length - 1]) ? `\nBooking number: ${booked.ref_no}` : `\nرقم الحجز: ${booked.ref_no}`;
}

const urgency = emergency ? 'emergency' : (obj(pre.triage).level === 'urgent' || brainUrgency === 'urgent') ? 'urgent' : null;
const handoff = obj(decision.handoff);
const askTeam = (Array.isArray(decision.ask_team) ? decision.ask_team : [decision.ask_team]).map(q => str(q)).filter(Boolean).slice(0, 2).map(q => q.slice(0, 500));
return [{
  json: {
    ...pre,
    decision: { reply_messages: messages, ask_team: askTeam,
                handoff: { needed: handoff.needed === true || String(handoff.needed) === 'true', reason: str(handoff.reason) },
                language: str(decision.language) || pre.language_guess || null, memory_note: str(decision.memory_note) },
    tools_used: toolsUsed, tool_problems: toolProblems, tool_calls: toolCalls, agent_error: agentError,
    booked_ref: booked ? booked.ref_no : null, booked_location: booked ? booked.location : null,
    moved_ref: moved ? str(moved.ref_no) : null, cancelled_ref: cancelled ? str(cancelled.ref_no) : null,
    confirmed_ref: confirmed ? str(confirmed.ref_no) : null,
    final: !!(booked || moved || cancelled || confirmed),
    urgency, emergency,
    allowed_numbers: [...allowed], allowed_links: allowedLinks,
    violations, needs_rewrite: violations.length > 0, agent_tokens: obj(agent.tokenUsage)
  }
}];
