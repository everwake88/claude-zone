// Shared pieces for filming the dashboard: the browser (the dashboard is
// served on this machine but opened as orders.everwake.tech, so every
// address on screen is the real one), sign-in, and a recorder that saves
// each frame with where the cursor points, for the video to animate.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const BASE = 'http://orders.everwake.tech';
// FILM_LANG=ar films the dashboard in Arabic; L() turns a button's English
// name into what is on screen, from the dashboard's own dictionary
export const LANG = process.env.FILM_LANG || 'en';
const AR = {};
const dict = fs.readFileSync(new URL('../../dashboard/src/lib/i18n-ar.ts', import.meta.url), 'utf8');
for (const m of dict.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) AR[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`);
export const L = (en) => (LANG === 'ar' && AR[en]) || en;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const LR = (en, flags = '') => new RegExp(esc(L(en)), flags);
export const SLUG = 'grill_house';
export const R = `${BASE}/r/${SLUG}`;
export const OUT = path.resolve(process.env.SHOTS_DIR || 'shots');
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres@localhost/everwake?host=/tmp&port=5433' });

const GUIDES = ['branches', 'customers', 'growth', 'menu', 'offers', 'orders', 'reservations', 'zones'];

let browser;
export async function launch() {
  browser ??= await chromium.launch({ args: ['--host-resolver-rules=MAP orders.everwake.tech 127.0.0.1', '--unsafely-treat-insecure-origin-as-secure=http://orders.everwake.tech', '--font-render-hinting=none'] });
  return browser;
}

// a signed-in dashboard tab. `guides`: page guides to leave open.
export async function dashboard({ width = 1600, height = 1000, scale = 1.5, lang = LANG, guides = [] } = {}) {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'Africa/Cairo' });
  await ctx.addCookies([{ name: 'ew_lang', value: lang, domain: 'orders.everwake.tech', path: '/' }]);
  const closed = GUIDES.filter((g) => !guides.includes(g));
  await ctx.addInitScript((ids) => {
    // plain http is not a secure context, which hides crypto.randomUUID (uploads name files with it)
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,
        (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
    }
    for (const id of ids) try { localStorage.setItem(`ew_guide_${id}`, 'closed'); } catch {}
    addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      // the top bar's backdrop blur makes it the box its dialogs are fixed to, which clips them (a dashboard bug, reported)
      s.textContent = '::-webkit-scrollbar{width:0;height:0} *{scrollbar-width:none} html{caret-color:transparent} header.sticky{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
      document.head.appendChild(s);
    });
  }, closed);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', 'demo@everwake.tech');
  await page.fill('input[type=password]', 'demo-password');
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return { ctx, page };
}

// a phone-sized tab with no sign-in (customer and driver pages)
export async function phone({ cookies = [], geolocation } = {}) {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
                                   locale: 'ar-EG', timezoneId: 'Africa/Cairo', ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}) });
  if (cookies.length) await ctx.addCookies(cookies.map((c) => ({ domain: 'orders.everwake.tech', path: '/', ...c })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  return { ctx, page };
}

export async function settle(page, ms = 600) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

// centre of an element, in CSS pixels of the viewport
export async function point(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  const b = await loc.boundingBox();
  if (!b) throw new Error('not on screen: ' + target);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w: Math.round(b.width), h: Math.round(b.height),
           left: Math.round(b.x), top: Math.round(b.y) };
}

// Frames for one scene: shots/<scene>/NN-name.jpg plus a manifest the
// video reads (what each frame is, where the cursor is, what it clicks).
export class Scene {
  constructor(name) {
    this.name = name;
    this.dir = path.join(OUT, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = [];
  }
  async shot(page, name, extra = {}) {
    const file = `${String(this.frames.length).padStart(2, '0')}-${name}.jpg`;
    await page.screenshot({ path: path.join(this.dir, file), type: 'jpeg', quality: 92, fullPage: !!extra.fullPage });
    const vp = page.viewportSize();
    this.frames.push({ file, name, w: vp.width, h: vp.height, ...extra, fullPage: undefined });
    console.log(`  ${this.name}/${file}`);
    return file;
  }
  // a frame with the cursor on `target`; click it afterwards if asked
  async aim(page, name, target, { click = false, ...extra } = {}) {
    const p = await point(page, target);
    await this.shot(page, name, { cursor: { x: p.x, y: p.y }, box: p, click, ...extra });
    if (click) await (typeof target === 'string' ? page.locator(target).first() : target).click();
    return p;
  }
  save(meta = {}) {
    fs.writeFileSync(path.join(this.dir, 'scene.json'), JSON.stringify({ name: this.name, ...meta, frames: this.frames }, null, 1));
  }
}

export async function tenant() {
  const { rows } = await db.query(`select id, order_seq, order_no_prefix from everwake.tenants where slug = $1`, [SLUG]);
  return rows[0];
}

export async function done() {
  await browser?.close();
  await db.end();
}
