// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Build Brief
// The clinic's rows → FACTS (only what is true right now), CLINIC (the
// catalogue snapshot: doctors, schedules, places, services and prices,
// offers, answers, the doctors' rules), the chat, the latest message.
// Two things are worked out in code, never by the model:
//   · the dates and times they mentioned (shared/dates.js)
//   · red flags (shared/triage.js) — an emergency is acted on whatever
//     the model makes of it (Persist raises the alert; Check Reply
//     makes sure the reply leads with the emergency guidance)
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js
// @include shared/clock.js
// @include shared/dates.js
// @include shared/triage.js

const ctx = row($input.first().json);
const intake = $('Intake').first().json.r;
const norm = $('Normalize Inbound').first().json;
const claim = obj(obj($('Claim Debounce Window').first().json).r);
const tenant = obj(ctx.tenant);
const tz = str(tenant.timezone) || 'Africa/Cairo';
const now = localNow(tz);
const profile = obj(ctx.profile);
const contact = obj(ctx.contact);
const state = obj(ctx.state);
const rules = obj(ctx.booking_rules);
const latest = str(claim.combined_text) || str(norm.customer_message);
const lines = [];
const P = (s) => lines.push(s);
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} minutes ago` : m < 1440 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
};
const agentName = obj(profile.agent_name);
const lang = str(contact.language) || (/[؀-ۿ]/.test(latest) ? 'ar' : /[A-Za-z]/.test(latest) ? 'en' : 'ar');

// ---- who, when ---------------------------------------------------------------
P(`NOW: ${DAY_AR[now.dow]} ${dayMonth(now.date)}/${now.date.slice(0, 4)} (${now.date}), ${now.label} — ${tz}`);
P(`YOU ARE: ${str(agentName.ar) || 'نور'} (${str(agentName.en) || 'Nour'}), the AI assistant of ${str(tenant.name_ar)} (${str(tenant.name_en)}) — you speak as ${profile.agent_gender === 'male' ? 'a man' : 'a woman'}.`);
const phone = contact.phone_hidden ? '' : localPhone(contact.phone);
P(`THE PERSON WRITING: WhatsApp name «${str(contact.display_name) || '—'}»`
  + (contact.full_name ? ` · their name on file: ${contact.full_name}` : ' · their own name: not given yet')
  + (phone ? ` · number ${phone} (their WhatsApp — never ask for a phone number)` : ' · WhatsApp hides their number')
  + ` · first wrote here: ${ago(contact.first_seen_at) || 'now'}`);

const known = arr(ctx.known_patients);
if (known.length) {
  P('PATIENTS THIS NUMBER BOOKS FOR (patient_id for the tool):');
  for (const p of known) {
    P(`  - ${p.full_name} [patient_id ${p.id}] (${p.relation === 'self' ? 'themself' : p.relation})${p.age ? ' · ' + p.age : ''}${p.sex ? ' · ' + p.sex : ''}`
      + (p.last_visit_at ? ` · last visit ${String(p.last_visit_at).slice(0, 10)}${p.last_doctor ? ' with ' + p.last_doctor : ''}` : ' · no visit yet')
      + (p.visits_count ? ` · ${p.visits_count} visit(s)` : ''));
  }
} else {
  P(`PATIENTS THIS NUMBER BOOKS FOR: none yet — a new person. A booking needs the patient's ${arr(rules.new_patient_fields).map(f => f === 'full_name' ? 'name' : f).join(' and ') || 'name'}.`);
}

// ---- their visits ------------------------------------------------------------------
const upcoming = arr(ctx.upcoming);
if (upcoming.length) {
  P('UPCOMING VISITS:');
  for (const a of upcoming) {
    P(`  - ${a.ref_no} · ${a.patient || '?'} · ${a.service || 'كشف'} · ${a.doctor} · ${a.when} · ${a.location} · ${a.status === 'confirmed' ? 'CONFIRMED' : a.status}`
      + (a.delay_minutes ? ` · the doctor is running ${a.delay_minutes} min late (was ${a.original_time})` : '')
      + (a.price_text ? ` · ${a.price_text}${a.is_follow_up ? ' (follow-up)' : ''}` : ''));
  }
}
// ---- what the doctor wants to know before the visit (asked after booking, one at a time) ---------
const pre = obj(ctx.pre_visit_pending);
if (arr(pre.questions).length) {
  P(`PRE-VISIT QUESTIONS for ${pre.ref_no || 'their next visit'} — the doctor wants these before the visit. Ask only when the chat allows (the booking is done, nothing else is pending, never in an emergency), ONE short question per reply, and save each answer with pre_visit {answers: {key: "their words"}}:`);
  for (const q of arr(pre.questions)) P(`  - ${q.key}: ${lang === 'en' ? str(q.ask_en) || str(q.ask_ar) : str(q.ask_ar)}`);
}
const past = arr(ctx.past_visits);
if (past.length) P('PAST VISITS: ' + past.map(a => `${a.date} ${a.patient || ''} ${a.service || ''} with ${a.doctor} (${a.status})`).join(' · '));

// ---- the booking in progress -------------------------------------------------------------
const draft = obj(ctx.draft);
const dd = obj(draft.data);
if (draft.data) {
  const pt = obj(dd.patient);
  const who = pt.patient_id ? (known.find(k => String(k.id) === String(pt.patient_id)) || {}).full_name || `patient ${pt.patient_id}`
            : [pt.full_name, pt.age, pt.relation].filter(Boolean).join(', ');
  const doc = arr(ctx.doctors).find(d => d.id === dd.doctor_id);
  const held = obj(draft.held);
  P(`BOOKING IN PROGRESS: for ${who || '(who? not said yet)'} · doctor ${doc ? doc.name : '(not chosen)'}`
    + (dd.reason ? ` · reason «${dd.reason}»` : '') + (dd.replacing ? ` · replaces the cancelled ${dd.replacing}` : '')
    + (held.when ? ` · HELD: ${held.when} at ${held.location} (held until ${localTime(held.hold_expires_at, tz)}) · ${held.price_text || ''}` : ' · no time chosen yet')
    + ` · summary: ${draft.summary_shown ? 'SHOWN and still matches — a yes means book' : 'not shown yet'}`);
}
const offered = arr(draft.last_offered).length ? arr(draft.last_offered) : arr(state.last_offered);
if (offered.length) {
  P('OPTIONS OFFERED LAST (they may answer with the number — update with option N):');
  for (const o of offered) P(`  ${o.option}) ${o.label_ar} — ${o.doctor}, ${o.location}${o.kind === 'queue' ? ' (queue number)' : ''}`);
}

// ---- what they are answering --------------------------------------------------------------
const pending = obj(ctx.pending);
const replying = [];
if (pending.delay) replying.push(`the clinic's message that the doctor is ${pending.delay.minutes} min late: ${pending.delay.ref_no} is now at ${pending.delay.new_time} instead of ${pending.delay.old_time} (sent ${ago(pending.delay.at)}) — 1 / OK = accept_delay · another time = reschedule · 3 = cancel`);
if (pending.reminder && !pending.delay) replying.push(`the clinic's reminder about ${pending.reminder.ref_no} (sent ${ago(pending.reminder.at)}) — 1 / coming = confirm · 2 / another time = reschedule · 3 / can't come = cancel`);
if (pending.session_cancelled) replying.push(`the clinic's message that the doctor cancelled ${pending.session_cancelled.cancelled_ref}'s session — the options in it are the OPTIONS OFFERED LAST: "1"/"2" = update with that option, then summary and book`);
if (pending.offer) replying.push(`the clinic's offer of an earlier time (${obj(pending.offer.slot).label_ar}) — yes / 1 = take_offer, then summary and book`);
if (pending.plan) replying.push(`the treatment-plan quote the clinic sent (plan ${pending.plan.plan_id}) — yes / موافق = accept_plan`);
if (replying.length) P('WHAT THEY ARE REPLYING TO (if their message answers it):\n  - ' + replying.join('\n  - '));

// ---- dates and times, worked out in code ----------------------------------------------------------
const dates = resolveDates(latest, now, { windows: arr(ctx.hours) });
if (dates.lines.length) {
  P('DATES AND TIMES THEY MENTIONED (worked out for you — use these, never count days yourself):\n  ' + dates.lines.join('\n  '));
  const args = { ...dates.args };
  if (args.time) { args.time_from = args.time; delete args.time; }
  if (Object.keys(args).length) P(`  → for find_slots: ${JSON.stringify(args)}`);
}

// ---- which speciality their words point to (several doctors) -----------------------------------
const doctors = arr(ctx.doctors);
if (doctors.length > 1) {
  const t = ' ' + normalizeArabic(latest) + ' ';
  // a word at the start of a word, also after و / ل / ب / ال ("لابني"، "وسناني"، "بالضرس")
  const has = (n) => n && new RegExp(`(?:^|\\s)(?:و|ل|ب|ف|ال|لل|بال|وال|فال)?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
  const hits = [];
  for (const [code, words] of Object.entries(obj(ctx.specialty_keywords))) {
    const w = arr(words).find(x => has(normalizeArabic(x)));
    if (w) hits.push(`${code} («${w}») → ${doctors.filter(d => d.specialty === code).map(d => d.name).join(' / ')}`);
  }
  for (const d of doctors) {
    const first = normalizeArabic(String(d.name).replace(/^(د\.?|dr\.?)\s*/i, '')).split(' ')[0];
    if (first && first.length >= 3 && has(first) && !hits.some(h => h.includes(d.name))) hits.push(`they named ${d.name}`);
  }
  if (hits.length) P('THEIR WORDS POINT TO: ' + hits.join(' · '));
}

// ---- red flags -------------------------------------------------------------------------------
const red = triage(latest, arr(ctx.specialty_triage));
if (red.level === 'emergency') {
  P(`RED FLAGS: EMERGENCY — ${red.matches.filter(m => m.level === 'emergency').map(m => `${m.why} («${m.said}»)`).join('; ')}. `
    + `Your FIRST line tells them to call the ambulance (${obj(ctx.emergency).ambulance || '123'}) or go to the nearest emergency room now, and that the doctor is being told. No booking talk before that.`);
} else if (red.level === 'urgent') {
  P(`RED FLAGS: URGENT — ${red.matches.map(m => `${m.why} («${m.said}»)`).join('; ')}. Offer the soonest time (today or tomorrow) and say that if it gets worse they go to the emergency room.`);
}
if (obj(ctx.conversation).urgency) P(`EARLIER IN THIS CHAT: flagged ${ctx.conversation.urgency} — be gentle and check how they are.`);

// ---- the clinic today ----------------------------------------------------------------------------
for (const d of arr(ctx.delays_today)) {
  P(d.kind === 'delay' ? `TODAY: ${d.doctor} is running ${d.minutes} minutes late${d.reason ? ' (' + d.reason + ')' : ''} — the patients booked today were told.`
                       : `TODAY: ${d.doctor}'s session was cancelled${d.reason ? ' (' + d.reason + ')' : ''} — the patients were offered other times.`);
}
for (const pl of arr(ctx.plans)) {
  const n = obj(pl.next);
  P(`TREATMENT PLAN for ${pl.patient} with ${pl.doctor}: ${pl.status}, total ${fmt(pl.total)} ${str(tenant.currency_symbol) || 'ج'}`
    + (n.label ? ` · next: ${n.label}${n.tooth ? ' (tooth ' + n.tooth + ')' : ''} session ${n.session}/${n.of}, from ${n.earliest} (next_plan_session)` : ''));
}
const docs = arr(ctx.documents_recent);
if (docs.length) P('FILES THEY SENT (kept on their record for the doctor): ' + docs.map(d => `${d.kind}: ${str(d.summary).slice(0, 160)}`).join(' · '));

// ---- the team -----------------------------------------------------------------------------------
const qs = arr(ctx.team_questions);
const newAnswers = [];
if (qs.length) {
  P('QUESTIONS YOU ASKED THE DOCTOR / CLINIC:');
  for (const q of qs) {
    if (q.status === 'open') P(`  - «${q.question}» (${ago(q.asked_at)}) — still waiting: never ask again, never guess`);
    else if (q.status === 'answered') {
      if (!q.told) newAnswers.push(q.id);
      P(`  - «${q.question}» → ${q.answer_kind === 'yes' ? 'YES' : q.answer_kind === 'no' ? 'NO' : ''}${q.answer ? ' «' + q.answer + '»' : ''}`
        + `${q.answered_by ? ' (' + q.answered_by + ')' : ''}${q.told ? ' — already told them' : ' — NEW: tell them now and act on it'}`);
    }
  }
}
const handback = obj(state.handback);
if (handback.at && Date.now() - new Date(handback.at).getTime() < 6 * 3600 * 1000) {
  P(`A TEAM MEMBER handled this chat until ${ago(handback.at)} — read what they wrote and continue from there.`);
}
const notes = arr(state.memory_notes);
if (notes.length) P('YOUR NOTES ABOUT THEM: ' + notes.slice(-5).join(' · '));

P(`BOOKING RULES: book at least ${num(rules.lead_minutes, 60)} minutes ahead · up to ${num(rules.days_ahead, 45)} days ahead`
  + (num(rules.cancel_hours) ? ` · please cancel ${rules.cancel_hours} hours before` : ''));
P(`THE CLINIC'S EMERGENCY WORDS: ${str(profile.emergency_text_ar)}`);
const contacts = obj(profile.contacts);
if (contacts.phone) P(`CLINIC PHONE: ${contacts.phone}`);
if (arr(profile.insurance).length) P(`INSURANCE ACCEPTED: ${arr(profile.insurance).join('، ')}`);
if (profile.about_ar) P(`ABOUT THE CLINIC: ${profile.about_ar}`);

// ---- the chat ------------------------------------------------------------------------------------
const PURPOSE = { reminder: 'reminder', delay_notice: 'delay notice', delay_followup: 'delay follow-up', session_cancelled: 'cancelled session',
                  booking_confirmed: 'booking made by the front desk', booking_moved: 'visit moved', booking_cancelled: 'visit cancelled',
                  waitlist_offer: 'earlier time offered', aftercare: 'aftercare', plan_quote: 'treatment-plan quote', plan_next: 'next session offer',
                  resume_notice: "we're back", staff_reply: null };
const history = arr(ctx.recent_messages).slice(0, -Math.max(1, num(claim.buffered_count, 1))).map(m => {
  const who = m.direction === 'inbound' ? 'them' : m.sender === 'agent' ? 'you' : m.sender === 'staff' ? 'the team'
    : `the clinic (${PURPOSE[m.purpose] || 'automatic'})`;
  return `[${localTime(m.at, tz)}] ${who}: ${str(m.text).replace(/\s+/g, ' ').slice(0, 600)}${m.reply_to ? ` (${m.reply_to})` : ''}`;
});
const safe = (s) => String(s == null ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');
const factsText = safe('================ FACTS ================\n' + lines.join('\n'));
const businessText = safe('================ CLINIC ================\n' + str(ctx.catalog_digest));
const historyText = safe(history.join('\n'));
const latestText = safe(latest);
const brief = [factsText, '', businessText, '', '================ THE CHAT SO FAR (oldest first) ================',
               historyText || '(this is the first message)', '', '================ THEIR LATEST MESSAGE ================', latestText].join('\n');

return [{
  json: {
    run_id: norm.run_id, tenant_id: intake.tenant_id, wa_id: intake.wa_id, turn_started_at: new Date().toISOString(),
    customer_message: latest, buffered_count: claim.buffered_count || 1, language_guess: lang,
    facts_text: factsText, business_text: businessText, history_text: historyText, latest_text: latestText,
    brief, brief_chars: brief.length,
    triage: red, dates: { args: dates.args, lines: dates.lines },
    emergency_text: str(profile.emergency_text_ar), emergency_text_en: str(profile.emergency_text_en),
    ambulance: str(obj(ctx.emergency).ambulance) || '123',
    team_answers_new: newAnswers,
    amounts: arr(obj(ctx.catalog_lookup).amounts),
    locations: arr(ctx.locations),
    allowed_links: arr(ctx.allowed_links).concat([profile.website, profile.instagram, profile.facebook, profile.google_maps_url,
                                                  profile.google_review_url, ctx.public_url]).concat(arr(ctx.locations).map(l => l.maps_url))
                   .map(str).filter(Boolean)
  }
}];
