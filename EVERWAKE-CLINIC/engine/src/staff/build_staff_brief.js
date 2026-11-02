// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Build Staff Brief
// A member of the clinic's team (usually the doctor) wrote from their own
// number. FACTS: who they are, today's and tomorrow's lists, delays today,
// what is waiting for their yes, the dates they mentioned (worked out in
// code), and the catalogue for changes to prices and services.
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js
// @include shared/clock.js
// @include shared/dates.js

const ctx = row($input.first().json);
const intake = $('Intake').first().json.r;
const norm = $('Normalize Inbound').first().json;
const claim = obj(obj($('Claim Debounce Window').first().json).r);
const tz = str(obj(ctx.tenant).timezone) || 'Africa/Cairo';
const now = localNow(tz);
const latest = str(claim.combined_text) || str(norm.customer_message);
const staff = obj(ctx.staff);
const L = [];
L.push(`NOW: ${DAY_AR[now.dow]} ${now.date}, ${now.label}`);
L.push(`YOU ARE TALKING TO: ${str(staff.name)} — ${str(staff.role)} at ${str(obj(ctx.tenant).name_ar)}${ctx.doctor ? ` (their own schedule: ${ctx.doctor.name})` : ''}`);
const list = (day) => arr(obj(day).appointments).map(a => `  ${a.queue_no ? '#' + a.queue_no + ' ~' : ''}${a.time} · ${a.patient || '?'} · ${a.service || ''} · ${a.status}${a.delay ? ` (+${a.delay}m)` : ''}${a.new ? ' · new' : ''}`);
const today = list(ctx.today), tomorrow = list(ctx.tomorrow);
L.push(`TODAY (${now.date}): ${today.length ? '\n' + today.join('\n') : 'no bookings'}`);
L.push(`TOMORROW: ${tomorrow.length ? '\n' + tomorrow.join('\n') : 'no bookings'}`);
for (const s of arr(obj(ctx.today).sessions)) L.push(`SESSION TODAY: ${s.doctor} at ${s.location} ${s.from}–${s.to} (${s.mode})`);
for (const d of arr(ctx.delays_today)) L.push(`ALREADY SENT TODAY: ${d.kind === 'delay' ? `${d.doctor} ${d.minutes} min late` : `${d.doctor}'s session cancelled`} — replies: ${JSON.stringify(d.tally || {})}`);
const pend = obj(ctx.pending);
if (pend.action) L.push(`WAITING FOR THEIR YES: ${pend.action} (${pend.action === 'catalog' ? 'change ' + pend.change_id : JSON.stringify(pend.params || {})}) — a yes = staff_action confirm; no = discard`);
if (ctx.last_change) L.push(`LAST PRICE/SERVICE CHANGE FROM WHATSAPP: ${ctx.last_change.status} — ${str(ctx.last_change.summary).replace(/\n/g, ' · ')}`);
if (ctx.open_alerts) L.push(`OPEN ALERTS ON THE DASHBOARD: ${ctx.open_alerts}`);
L.push(`DOCTORS: ${arr(ctx.doctors).map(d => `${d.name} (${d.specialty})`).join(' · ')} · PLACES: ${arr(ctx.locations).join('، ')}`);
const dates = resolveDates(latest, now, {});
if (dates.lines.length) L.push('DATES THEY MENTIONED (worked out — use these):\n  ' + dates.lines.join('\n  '));
const history = arr(ctx.recent_messages).slice(0, -Math.max(1, num(claim.buffered_count, 1)))
  .map(m => `[${localTime(m.at, tz)}] ${m.direction === 'inbound' ? 'them' : 'you'}: ${str(m.text).slice(0, 400)}`);
const safe = (s) => String(s == null ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');
const prompt = [safe('================ FACTS ================\n' + L.join('\n')), '',
                safe('================ THE CATALOGUE (for price and service changes) ================\n' + str(ctx.catalog_digest)), '',
                '================ THE CHAT SO FAR ================', safe(history.join('\n')) || '(first message)', '',
                '================ THEIR LATEST MESSAGE ================', safe(latest)].join('\n');
return [{ json: { run_id: norm.run_id, tenant_id: intake.tenant_id, wa_id: intake.wa_id, staff: intake.staff,
                  staff_json: JSON.stringify(intake.staff || {}), customer_message: latest, buffered_count: claim.buffered_count || 1,
                  turn_started_at: new Date().toISOString(), staff_prompt: prompt } }];
