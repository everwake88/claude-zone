// Films the dashboard for the launch video, scene by scene:
//   node capture.mjs            every scene, in order
//   node capture.mjs menu zones only these
// Frames and a scene.json for each land in shots/<scene>/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, R, OUT, Scene, dashboard, db, done, launch, phone, point, settle, tenant } from './lib.mjs';
import { DRIVER_TOKEN, prepare, placeOrder } from './demo-data.mjs';
import { writeManifest } from './manifest.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FONTS = path.resolve(HERE, '../fonts');
const STORAGE = process.env.STORAGE_DIR || '/var/tmp/ewdemo/storage';
const STATE = path.join(OUT, 'state.json');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const keep = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const media = (p) => `http://localhost:54321/storage/v1/object/public/media/${p}`;

const fontCss = ['400', '500', '600'].map((w) =>
  `@font-face{font-family:"IBM Plex Sans Arabic";font-weight:${w};src:url(file://${FONTS}/ibm-plex-sans-arabic-arabic-${w}-normal.woff2)}`).join('');

// render a bit of HTML to an image file
async function render(html, file, { width, height, scale = 2, type = 'png' }) {
  const b = await launch();
  const page = await b.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}*{margin:0}body{width:${width}px;height:${height}px;overflow:hidden;background:transparent}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, type, omitBackground: type === 'png', ...(type === 'jpeg' ? { quality: 92 } : {}) });
  await page.close();
}

const scenes = {
  // the logo and the menu pictures the dashboard designs from the live menu
  async brand() {
    fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
    const logo = path.join(OUT, 'assets', 'grill-house-logo.png');
    await render(fs.readFileSync(path.join(HERE, 'assets/grill-house-logo.svg'), 'utf8').replace('width="512" height="512"', 'width="512" height="512" style="display:block"'),
                 logo, { width: 512, height: 512, scale: 1 });
    state.prepared = await prepare();
    keep();

    const s = new Scene('brand');
    const { page } = await dashboard();
    await page.goto(`${R}/settings/brand`);
    await settle(page);
    await s.shot(page, 'before');
    await page.setInputFiles('input[type=file]', logo);
    await page.waitForTimeout(2500);
    await settle(page);
    await s.shot(page, 'logo');

    await page.goto(`${R}/menu/pages`);
    await settle(page);
    await s.shot(page, 'pages-empty');
    await s.aim(page, 'design', page.getByRole('button', { name: 'Design the pictures' }), { click: true });
    await page.waitForTimeout(5000);
    await settle(page, 1500);
    await s.shot(page, 'designed');
    await s.shot(page, 'designed-full', { fullPage: true });
    const use = page.getByRole('button', { name: 'Use these as the menu pictures' });
    await use.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await s.shot(page, 'picture');
    await s.aim(page, 'use', use, { click: true });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page, 800);
    await s.shot(page, 'saved');
    s.save();

    // the saved picture, for the customer's photo of the printed menu
    const pic = await db.query(`select url from everwake.menu_media where tenant_id = $1 order by position, created_at limit 1`, [state.prepared.tenant]);
    const file = path.join(STORAGE, 'media', decodeURIComponent(new URL(pic.rows[0].url).pathname.split('/public/media/')[1]));
    fs.copyFileSync(file, path.join(OUT, 'assets', 'menu-page.jpg'));
  },

  // what the customer sends: a voice note, and a phone photo of the printed menu with a dish circled
  async media() {
    const A = path.join(OUT, 'assets');
    const T = (await tenant()).id;
    fs.mkdirSync(path.join(STORAGE, 'media', T, 'chat'), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=14:c=pink:a=0.02', '-c:a', 'libopus',
                            path.join(STORAGE, 'media', T, 'chat', 'voice-nadeen.ogg')]);
    const menu = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(A, 'menu-page.jpg')).toString('base64');
    const pos = JSON.parse(fs.readFileSync(path.join(HERE, 'assets/circle.json'), 'utf8'));
    await render(`
      <div style="position:relative;width:900px;height:1200px;overflow:hidden;
                  background:radial-gradient(120% 90% at 40% 30%, #8a5a36 0%, #5e3b22 55%, #3b2414 100%)">
        <div style="position:absolute;inset:0;opacity:.18;background:repeating-linear-gradient(97deg, #000 0 2px, transparent 2px 23px),
                    repeating-linear-gradient(95deg, #fff 0 1px, transparent 1px 41px)"></div>
        <div style="position:absolute;left:110px;top:70px;width:690px;transform:perspective(1600px) rotateX(9deg) rotateZ(-4deg);
                    box-shadow:0 30px 60px rgba(0,0,0,.55);background:#fff">
          <img src="${menu}" style="display:block;width:100%">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">
            <path d="M ${pos.x - pos.rx} ${pos.y} C ${pos.x - pos.rx} ${pos.y - pos.ry * 1.25}, ${pos.x + pos.rx * 1.05} ${pos.y - pos.ry * 1.2}, ${pos.x + pos.rx} ${pos.y - pos.ry * 0.1}
                     S ${pos.x - pos.rx * 0.6} ${pos.y + pos.ry * 1.35}, ${pos.x - pos.rx * 0.95} ${pos.y - pos.ry * 0.55}"
                  fill="none" stroke="#1d4fb8" stroke-width="5" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity=".9"/>
          </svg>
        </div>
        <div style="position:absolute;inset:0;background:radial-gradient(70% 60% at 45% 40%, rgba(255,220,170,.18), transparent 70%),
                    linear-gradient(180deg, rgba(0,0,0,0) 60%, rgba(0,0,0,.35))"></div>
      </div>`, path.join(STORAGE, 'media', T, 'chat', 'photo-nadeen.jpg'), { width: 900, height: 1200, scale: 1, type: 'jpeg' });
    fs.copyFileSync(path.join(STORAGE, 'media', T, 'chat', 'photo-nadeen.jpg'), path.join(A, 'photo-nadeen.jpg'));
    state.voiceUrl = media(`${T}/chat/voice-nadeen.ogg`);
    state.photoUrl = media(`${T}/chat/photo-nadeen.jpg`);
    keep();
  },

  // the board: Nadeen's order rings in live, is opened, accepted and sent out with a driver
  async orders() {
    const s = new Scene('orders');
    const { page } = await dashboard();
    await page.goto(`${R}/orders`);
    await settle(page, 1500);
    await s.shot(page, 'board');
    const placed = await placeOrder({ voiceUrl: state.voiceUrl, photoUrl: state.photoUrl });
    state.order = placed;
    keep();
    const card = () => page.locator('article', { hasText: placed.no });
    await card().waitFor({ timeout: 10000 });
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(250); await s.shot(page, `ring-${i}`); }
    await page.waitForTimeout(1200);
    await s.shot(page, 'arrived', { focus: await point(page, card()) });
    await s.aim(page, 'open', card().getByText(placed.no), { click: true });
    await page.waitForTimeout(900);
    await s.shot(page, 'details');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (await page.getByText('Open the chat').isVisible()) { await page.mouse.click(700, 120); await page.waitForTimeout(500); }
    await s.aim(page, 'accept', card().getByRole('button', { name: 'Accept', exact: true }), { click: true });
    await page.waitForTimeout(700);
    await s.shot(page, 'accept-dialog');
    await s.aim(page, 'eta', page.getByRole('button', { name: '45 دقيقة' }), { click: true });
    await page.waitForTimeout(400);
    await s.aim(page, 'accept-tell', page.getByRole('button', { name: 'Accept and tell the customer' }), { click: true });
    await page.waitForTimeout(1800);
    await s.shot(page, 'accepted', { focus: await point(page, card()) });
    const select = card().locator('select');
    await s.aim(page, 'driver', select);
    await select.selectOption(state.prepared.driver);
    await page.waitForTimeout(1500);
    await s.shot(page, 'driver-set', { focus: await point(page, card()) });
    await s.aim(page, 'out', card().getByRole('button', { name: 'Out for delivery' }), { click: true });
    await page.waitForTimeout(800);
    const dialog = page.locator('[role=dialog]');
    if (await dialog.count() && await dialog.first().isVisible()) {
      await s.shot(page, 'out-dialog');
      await s.aim(page, 'out-confirm', dialog.getByRole('button').last(), { click: true });
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1000);
    await s.shot(page, 'on-the-way', { focus: await point(page, card()) });
    s.save({ order: placed.no });
  },

  async overview() {
    const s = new Scene('overview');
    const { page } = await dashboard();
    await page.goto(R);
    await settle(page, 1000);
    await s.shot(page, 'top');
    s.save();
  },

  // Nadeen's chat as the team sees it: what the agent heard and saw
  async inbox() {
    const s = new Scene('inbox');
    const { page } = await dashboard();
    await page.goto(`${R}/inbox`);
    await settle(page, 1000);
    await s.shot(page, 'list');
    await s.aim(page, 'open', page.getByText('نادين', { exact: false }).first(), { click: true });
    await settle(page, 1200);
    const pane = page.locator('div.space-y-2.overflow-y-auto').first();
    await s.shot(page, 'bottom');
    const height = await pane.evaluate((el) => el.scrollHeight - el.clientHeight);
    for (let y = 0, i = 0; y <= height; y += 420, i++) {
      await pane.evaluate((el, top) => { el.scrollTop = top; }, y);
      await page.waitForTimeout(250);
      await s.shot(page, `scroll-${i}`);
    }
    s.save();
  },

  // a question the agent asked the team, answered with one tap
  async question() {
    const s = new Scene('question');
    const { page } = await dashboard();
    await page.goto(`${R}/inbox`);
    await settle(page, 1000);
    await s.aim(page, 'open', page.getByText('مروان منصور', { exact: true }).first(), { click: true });
    await settle(page, 1200);
    await s.shot(page, 'card');
    await s.aim(page, 'yes', page.getByRole('button', { name: 'Yes', exact: true }).first(), { click: true });
    await page.waitForTimeout(1500);
    await s.shot(page, 'answered');
    s.save();
  },

  // the manager takes over an unhappy customer's chat, then hands it back
  async takeover() {
    const s = new Scene('takeover');
    await db.query(`update everwake.customers set staff_notes = null where display_name = 'يوسف حسن'`);
    await db.query(`update everwake.conversations set mode = 'agent', human_since = null where customer_id in
                      (select id from everwake.customers where display_name = 'يوسف حسن')`);
    const { page } = await dashboard();
    await page.goto(`${R}/inbox`);
    await settle(page, 1000);
    await s.aim(page, 'open', page.getByText('يوسف حسن', { exact: true }).first(), { click: true });
    await settle(page, 1200);
    await s.shot(page, 'chat');
    const reply = 'حقك علينا يا يوسف 🙏 أنا مدير الفرع. هنبعتلك الطلب من جديد سخن خلال 30 دقيقة، وعلى حسابنا.';
    const box = page.getByPlaceholder('Write to the customer…');
    await s.aim(page, 'focus', box, { click: true });
    for (const n of [12, 30, 52, 76, reply.length]) {
      await box.fill(reply.slice(0, n));
      await s.shot(page, `type-${n}`, { cursor: null });
    }
    await s.aim(page, 'send', page.getByRole('button', { name: 'Send', exact: true }), { click: true });
    await page.waitForTimeout(1800);
    await s.shot(page, 'sent');
    await s.aim(page, 'hand-back', page.getByRole('button', { name: 'Hand back to the agent' }), { click: true });
    await page.waitForTimeout(1500);
    await s.shot(page, 'handed-back');
    s.save();
  },

  async bookings() {
    const s = new Scene('bookings');
    const { page } = await dashboard();
    await page.goto(`${R}/reservations`);
    await settle(page, 1000);
    await s.shot(page, 'list');
    await s.aim(page, 'confirm', page.getByRole('button', { name: 'Confirm', exact: true }).first(), { click: true });
    await page.waitForTimeout(1500);
    await s.shot(page, 'confirmed');
    s.save();
  },

  async customers() {
    const s = new Scene('customers');
    const { page } = await dashboard();
    await page.goto(`${R}/customers`);
    await settle(page, 1000);
    await s.shot(page, 'list');
    await s.aim(page, 'open', page.getByText('مروان منصور', { exact: true }).first(), { click: true });
    await page.waitForTimeout(1200);
    await s.shot(page, 'customer');
    s.save();
  },

  // the menu: a dish's choices and branch prices, out of stock for today, a branch's own menu
  async menu() {
    const s = new Scene('menu');
    await db.query(`update everwake.menu_items set is_available = true, sold_out_until = null where name_ar = 'ملوخية'`);
    const { page } = await dashboard();
    await page.goto(`${R}/menu`);
    await settle(page, 1000);
    await s.shot(page, 'list');
    const row = (name) => page.locator('tr', { hasText: name }).first();
    await s.aim(page, 'stock', row('ملوخية').getByRole('button', { name: /Available/ }), { click: true });
    await page.waitForTimeout(600);
    await s.shot(page, 'stock-menu');
    await s.aim(page, 'today', page.getByRole('button', { name: /For today/ }).first(), { click: true });
    await page.waitForTimeout(1200);
    await s.shot(page, 'sold-out', { focus: await point(page, row('ملوخية')) });
    await s.aim(page, 'edit', row('فرخة مشوية').getByRole('button').last(), { click: true });
    await page.waitForTimeout(1200);
    await s.shot(page, 'editor');
    for (const tab of ['Choices', 'Branches', 'Photos']) {
      await s.aim(page, `tab-${tab.toLowerCase()}`, page.getByText(new RegExp(`^${tab}( \\(\\d+\\))?$`)).last(), { click: true });
      await page.waitForTimeout(700);
      await s.shot(page, `editor-${tab.toLowerCase()}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const which = page.locator('select').first();
    await s.aim(page, 'branch', which);
    const nasr = await which.locator('option', { hasText: 'Nasr City' }).first().getAttribute('value').catch(() => null);
    if (nasr) { await which.selectOption(nasr); await settle(page, 1200); await s.shot(page, 'branch-menu'); }
    s.save();
  },

  async pages() {
    const s = new Scene('pages');
    const { page } = await dashboard();
    for (const [name, url] of [['import', '/menu/import'], ['photos', '/menu/photos'], ['branches', '/branches'], ['zones', '/zones'],
                               ['drivers', '/drivers'], ['offers', '/offers'], ['settings', '/settings'], ['agent', '/settings/agent'],
                               ['knowledge', '/settings/knowledge'], ['ordering', '/settings/ordering'], ['messages', '/settings/messages'],
                               ['payments', '/settings/payments'], ['whatsapp', '/settings/whatsapp'], ['report', '/settings/report'],
                               ['team', '/settings/team']]) {
      await page.goto(R + url);
      await settle(page, 1500);
      await s.shot(page, name);
      await s.shot(page, `${name}-full`, { fullPage: true });
    }
    s.save();
  },

  async growth() {
    const s = new Scene('growth');
    const { page } = await dashboard();
    await page.goto(`${R}/growth`);
    await settle(page, 1500);
    await s.shot(page, 'top');
    await s.shot(page, 'full', { fullPage: true });
    s.save();
  },

  async analytics() {
    const s = new Scene('analytics');
    const { page } = await dashboard();
    await page.goto(`${R}/analytics`);
    await settle(page, 2000);
    await s.shot(page, 'sales');
    await s.shot(page, 'sales-full', { fullPage: true });
    await s.aim(page, 'missed', page.getByRole('button', { name: 'Missed sales' }), { click: true });
    await settle(page, 1500);
    await s.shot(page, 'missed-sales');
    await s.shot(page, 'missed-full', { fullPage: true });
    s.save();
  },

  // a branch pauses for a while; a click on the map shows which zone, branch and fee the agent uses
  async places() {
    const s = new Scene('places');
    await db.query(`update everwake.branches set busy_until = null, busy_reason = null, accepting_orders = true`);
    const { page } = await dashboard();
    await page.goto(`${R}/zones`);
    await settle(page, 2500);
    await s.shot(page, 'zones');
    await s.aim(page, 'test', page.getByRole('button', { name: 'Test an address' }), { click: true });
    await page.waitForTimeout(600);
    const map = await point(page, '.leaflet-container');
    for (const [name, fx, fy] of [['pin-1', 0.6, 0.45], ['pin-2', 0.07, 0.92]]) {
      const at = { x: Math.round(map.left + map.w * fx), y: Math.round(map.top + map.h * fy) };
      await s.shot(page, `${name}-aim`, { cursor: at });
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(1200);
      await s.shot(page, name, { cursor: at });
    }
    await page.goto(`${R}/branches`);
    await settle(page, 1000);
    await s.shot(page, 'branches');
    await s.aim(page, 'busy-button', page.getByRole('button', { name: 'Too busy' }).first(), { click: true });
    await page.waitForTimeout(800);
    await s.shot(page, 'busy-options');
    await s.aim(page, 'busy-pick', page.getByRole('button', { name: '30 min', exact: true }), { click: true });
    await page.waitForTimeout(1200);
    await s.shot(page, 'busy');
    s.save();
  },

  // a menu from a spreadsheet, read in the browser and shown for checking before anything changes
  async import() {
    const s = new Scene('import');
    const { page } = await dashboard();
    await page.goto(`${R}/menu/import`);
    await settle(page, 1000);
    await s.shot(page, 'start');
    await s.aim(page, 'sheet', page.getByText('Spreadsheet', { exact: true }), { click: true });
    await page.waitForTimeout(500);
    await s.shot(page, 'sheet-tab');
    await page.setInputFiles('input[accept=".csv,text/csv"]', path.join(HERE, 'assets/new-dishes.csv'));
    await page.waitForTimeout(500);
    await s.aim(page, 'load', page.getByRole('button', { name: 'Load the spreadsheet' }), { click: true });
    await page.waitForTimeout(2500);
    await settle(page, 800);
    await s.shot(page, 'review');
    await s.shot(page, 'review-full', { fullPage: true });
    s.save();
  },

  // the same dashboard in Arabic
  async arabic() {
    const s = new Scene('arabic');
    const { page } = await dashboard({ lang: 'ar' });
    for (const [name, url] of [['orders', '/orders'], ['overview', ''], ['menu', '/menu'], ['analytics', '/analytics']]) {
      await page.goto(R + url);
      await settle(page, 1500);
      await s.shot(page, name);
    }
    s.save();
  },

  // the kitchen is full: the agent goes OFF, then back ON
  async switch() {
    const s = new Scene('switch');
    const { page } = await dashboard();
    await page.goto(`${R}/orders`);
    await settle(page, 1200);
    await s.aim(page, 'on', page.getByRole('button', { name: /Agent ON/ }).first(), { click: true });
    await page.waitForTimeout(700);
    await s.shot(page, 'ask-off');
    await page.getByPlaceholder(/Kitchen full/).fill('المطبخ مليان — طلبات كتير من الفروع');
    await s.shot(page, 'why', { cursor: null });
    await s.aim(page, 'switch-off', page.getByRole('button', { name: 'Switch OFF' }), { click: true });
    await page.waitForTimeout(1500);
    await s.shot(page, 'off');
    await s.aim(page, 'off-button', page.getByRole('button', { name: /Agent OFF/ }).first(), { click: true });
    await page.waitForTimeout(700);
    await s.shot(page, 'ask-on');
    await s.aim(page, 'switch-on', page.getByRole('button', { name: 'Switch ON' }), { click: true });
    await page.waitForTimeout(1500);
    await s.shot(page, 'on-again');
    s.save();
  },

  // the customer's payment page and the driver's app, on phones
  async phones() {
    const s = new Scene('phones');
    const pay = await phone();
    await pay.page.goto(`${BASE}/p/${state.order.ref}`);
    await settle(pay.page, 800);
    await s.shot(pay.page, 'paid');
    // location needs a secure page, and http://localhost is one (no address bar shows on the phone)
    const drv = await phone({ cookies: [{ name: 'ew_driver', value: DRIVER_TOKEN, domain: 'localhost' }, { name: 'ew_lang', value: 'ar', domain: 'localhost' }],
                              geolocation: { latitude: 30.0251, longitude: 31.4668 } });
    await drv.page.goto('http://localhost/driver');
    await settle(drv.page, 2500);
    await s.shot(drv.page, 'driver');
    await s.shot(drv.page, 'driver-full', { fullPage: true });
    s.save();
  }
};

const order = Object.keys(scenes);
const pick = process.argv.slice(2).length ? process.argv.slice(2) : order;
for (const name of pick) {
  console.log(`scene ${name}`);
  await scenes[name]();
}
writeManifest(OUT);
await done();
