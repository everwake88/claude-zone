// Films the real desk (demo mode, Everwake skin) for desk.html: each step
// saves a screenshot to shots/. Run with the desk on DESK_URL and its
// ingest secret in DESK_SECRET.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SALE, COMPLAINT, MORE, REPLY, TRANSFER_NOTE } from './story.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.DESK_URL || 'http://localhost:8090';
const SECRET = process.env.DESK_SECRET || 'film-secret';
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const VP = { width: 1200, height: 1500 }, DPR = 1.8;   // 2160×2700: twice the 4:5 frame
const only = process.argv.slice(2);

const browser = await chromium.launch();
async function signIn(user, vp = VP, dpr = DPR) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, timezoneId: 'Africa/Cairo', locale: 'en-GB' });
  await ctx.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '::-webkit-scrollbar{width:0;height:0} *{scrollbar-width:none} html{caret-color:transparent}';
      document.head.appendChild(s);
    });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  page error:', e.message));
  await p.goto(BASE);
  await p.waitForSelector('input[type=password]');
  await p.locator('input:not([type=password])').first().fill(user);
  await p.fill('input[type=password]', 'demo1234');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  return p;
}
const shot = async (p, name) => { await p.screenshot({ path: OUT + name + '.png' }); console.log('  ' + name); };
// where things are on each screenshot (CSS pixels), for the film's camera and cursor
const BOXES = fs.existsSync(OUT + 'boxes.json') ? JSON.parse(fs.readFileSync(OUT + 'boxes.json', 'utf8')) : {};
async function mark(p, shotName, marks) {
  const out = (BOXES[shotName] ||= {});
  for (const [name, loc, up = 0] of marks) {
    let l = loc;
    for (let i = 0; i < up; i++) l = l.locator('xpath=..');
    const b = await l.boundingBox().catch(() => null);
    if (b) out[name] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    else console.log('    (no box for ' + name + ')');
  }
}
const ingest = async (body) => {
  const r = await fetch(BASE + '/api/ingest/handoff', { method: 'POST', headers: { 'content-type': 'application/json', 'x-desk-secret': SECRET }, body: JSON.stringify(body) });
  return r.json();
};
const ready = async (p) => { await p.getByRole('button', { name: /I’m ready/ }).first().click(); await p.waitForTimeout(800); };
// each run gets fresh customers, so an earlier run's open chats are not reused
const RUN = Date.now().toString(36);
const fresh = (c) => ({ ...c, external_id: c.external_id.replace(/^(film-[a-z]+-\d+|\d+)/, (m) => m + RUN) });
// a supervisor hands a chat to someone (as the Live board's Reassign does)
async function assign(sup, convId, userId) {
  return sup.evaluate(async ([c, u]) => {
    const r = await fetch(`/api/conversations/${c}/assign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('desk.token') }, body: JSON.stringify({ to: u }) });
    return r.status;
  }, [convId, userId]);
}

if (!only.length || only.includes('agent')) {
  const sup = await signIn('heba.farouk');
  const team = await sup.evaluate(async () => (await (await fetch('/api/team', { headers: { authorization: 'Bearer ' + localStorage.getItem('desk.token') } })).json()));
  const nourId = team.team.find((u) => u.full_name === 'Nour Ali').id;
  console.log('  nour id', nourId);
  const a = await signIn('nour.ali');
  await shot(a, 'a0-not-ready');
  await mark(a, 'a0-not-ready', [['ready', a.getByRole('button', { name: /I’m ready/ }).last()], ['readyTop', a.getByRole('button', { name: /^Ready/ }).first()]]);
  await ready(a);
  // the sale arrives first, while she has the most room
  const sale = await ingest(fresh(SALE));
  console.log('  sale', JSON.stringify(sale));
  await a.waitForTimeout(900);
  await shot(a, 'a1-sale-arrives');
  await mark(a, 'a1-sale-arrives', [['toast', a.locator('.toast').first()], ['item', a.getByText('Ahmed Samir').first(), 2]]);
  // the rest of her shift, handed to her
  for (const c of [COMPLAINT, ...MORE]) {
    const r = await ingest(fresh(c));
    if (r.conversation_id) console.log('  ', c.customer_name, await assign(sup, r.conversation_id, nourId));
    await a.waitForTimeout(700);
  }
  await a.waitForTimeout(2500);
  await shot(a, 'a2-queue');
  await mark(a, 'a2-queue', [['queue', a.locator('[aria-label="My chats"]').first()], ['item', a.getByText('Ahmed Samir').first(), 2], ['toasts', a.locator('.toasts').first()]]);
  // close the arrival notices before opening a chat
  for (const x of await a.locator('.toast button[aria-label="Dismiss"]').all()) await x.click().catch(() => {});
  await a.waitForTimeout(600);
  await a.getByText('Ahmed Samir').first().click();
  await a.waitForTimeout(1500);
  await shot(a, 'a3-sale-open');
  await mark(a, 'a3-sale-open', [['note', a.getByText(/hand-off note/i).first(), 1], ['head', a.getByRole('button', { name: /^Transfer/ }).first(), 1], ['composer', a.locator('textarea').first(), 1], ['firstAi', a.getByText(/ده الـ Lenovo LOQ/).first()], ['lastAi', a.getByText(/زميلي من فريق المبيعات/).last()]]);
  const box = a.locator('textarea').first();
  await box.click();
  const half = Math.floor(REPLY.length * 0.45);
  await box.type(REPLY.slice(0, half), { delay: 18 });
  await shot(a, 'a4-typing');
  await box.type(REPLY.slice(half), { delay: 18 });
  await shot(a, 'a5-typed');
  await a.keyboard.press('Enter');
  await a.waitForTimeout(1800);
  await shot(a, 'a6-sent');
  await mark(a, 'a6-sent', [['reply', a.getByText(/معاك نور من Volta/).last(), 1], ['composer', a.locator('textarea').first(), 1]]);
  await a.getByRole('button', { name: /Team/ }).first().click();
  await a.waitForTimeout(800);
  await shot(a, 'a7-team');
  await mark(a, 'a7-team', [['team', a.getByText(/Your team right now/).first(), 1], ['button', a.getByRole('button', { name: /Team/ }).first()]]);
  await a.keyboard.press('Escape');
  // now a teammate comes in, and Nour asks him to take the complaint
  const y = await signIn('youssef.kamal');
  await ready(y);
  await a.getByText('Mariam Khaled').first().click();
  await a.waitForTimeout(1200);
  await shot(a, 'a8-complaint');
  await a.getByRole('button', { name: /^Transfer/ }).first().click();
  await a.waitForTimeout(800);
  await shot(a, 'a9-transfer');
  await mark(a, 'a9-transfer', [['transfer', a.getByRole('button', { name: /^Transfer/ }).first()], ['dialog', a.getByRole('dialog').first()]]);
  await a.getByText('Youssef Kamal').first().click();
  await a.waitForTimeout(400);
  await a.getByPlaceholder(/Angry about/).fill(TRANSFER_NOTE);
  await shot(a, 'a10-transfer-filled');
  await mark(a, 'a10-transfer-filled', [['dialog', a.getByRole('dialog').first()], ['youssef', a.getByText('Youssef Kamal').first(), 2], ['send', a.getByRole('button', { name: /Send request/ }).first()], ['note', a.getByPlaceholder(/Angry about/)]]);
  await a.getByRole('button', { name: /Send request/ }).first().click();
  await a.waitForTimeout(1500);
  await shot(a, 'a11-requested');
  await shot(y, 'y1-request');
  await mark(y, 'y1-request', [['card', y.getByText(/asks for help/).first(), 2], ['accept', y.getByRole('button', { name: /^Accept/ }).first()], ['toast', y.locator('.toast').first()]]);
  await y.getByRole('button', { name: /^Accept/ }).first().click();
  await y.waitForTimeout(1800);
  await shot(y, 'y2-accepted');
  await mark(y, 'y2-accepted', [['note', y.getByText(/hand-off note/i).first(), 1], ['events', y.getByText(/You took over the chat/).first(), 1]]);
  await shot(a, 'a12-after');
}

if (!only.length || only.includes('super')) {
  const s = await signIn('heba.farouk');
  await s.getByRole('link', { name: /Live/ }).first().click();
  await s.waitForTimeout(2500);
  await shot(s, 's1-live');
  await mark(s, 's1-live', [['kpis', s.getByText('Ready agents').first(), 2], ['team', s.getByText(/ready · .* not ready/).first(), 1]]);
  await s.getByRole('link', { name: /Reports/ }).first().click();
  await s.waitForTimeout(3500);
  await shot(s, 's2-reports');
  await mark(s, 's2-reports', [['kpis', s.getByText('Chats handled').first(), 2], ['bysource', s.getByText('By source').first(), 1], ['team', s.getByText('Team performance').first(), 1]]);
  await s.mouse.move(600, 900);
  for (let i = 1; i <= 4; i++) { await s.mouse.wheel(0, 1100); await s.waitForTimeout(700); await shot(s, `s3-reports-${i}`); }
  // Track a chat that was late by minutes, not one that waited overnight
  // the late chat (under an hour) that changed hands the most
  const rows = s.locator('tr', { has: s.getByRole('button', { name: /^Track/ }) });
  let best = null, most = 0;
  for (const r of await rows.all()) {
    const txt = (await r.innerText()).replace(/\s+/g, ' ');
    const m = txt.match(/ (\d+)m (?:\d+m )?(?:\d+s )?(\d+) /);
    if (!m || /\dh/.test(txt) || +m[1] > 45) continue;
    if (+m[2] > most) { most = +m[2]; best = r; }
  }
  if (best) console.log('  tracking:', (await best.innerText()).replace(/\s+/g, ' '));
  await (best ? best.getByRole('button', { name: /^Track/ }) : s.getByRole('button', { name: /^Track/ }).last()).click();
  await s.waitForTimeout(2500);
  await shot(s, 's4-journey');
  await mark(s, 's4-journey', [['panel', s.getByText('Chat journey').first(), 2], ['stats', s.getByText('Agents who held it').first(), 2], ['waits', s.getByText(/late by/).first(), 1], ['first', s.getByText(/Timed out/).first(), 2]]);
  const panel = s.locator('[class*=journey], aside, .drawer').last();
  await s.mouse.move(1000, 900);
  await s.mouse.wheel(0, 700); await s.waitForTimeout(700);
  await shot(s, 's5-journey-more');
  await mark(s, 's5-journey-more', [['everything', s.getByText('Everything that happened').first(), 1], ['replied', s.getByText(/^Replied$/).first(), 2]]);
}

if (!only.length || only.includes('admin')) {
  const ad = await signIn('admin');
  const st = ad.getByRole('link', { name: /Settings/ }).first();
  if (await st.count()) { await st.click(); await ad.waitForTimeout(2000); await shot(ad, 'd1-settings'); }
}
fs.writeFileSync(OUT + 'boxes.json', JSON.stringify(BOXES, null, 1));
fs.writeFileSync(OUT + 'boxes.js', 'window.BOXES = ' + JSON.stringify(BOXES) + ';\n');
await browser.close();
