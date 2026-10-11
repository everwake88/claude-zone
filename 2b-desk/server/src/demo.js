// Demo mode: virtual customers and virtual agents, driven through the real
// engine, so the dashboard can be explored before WhatsApp / Meta are wired.
// Used by `npm run demo:seed` (a simulated day of history) and by the server
// when DEMO_MODE=true (keeps the floor alive in real time).
//
// Never enable this against the production database.
export const DEMO_PASSWORD = 'demo1234';

// People you can sign in as yourself while the simulation runs.
export const HUMANS = {
  agent: { username: 'nour.ali', full_name: 'Nour Ali', employee_id: '2B-006', role: 'agent' },
  supervisor: { username: 'heba.farouk', full_name: 'Heba Farouk', employee_id: '2B-S01', role: 'supervisor' },
  admin: { username: 'admin', full_name: 'Desk Admin', employee_id: '2B-A01', role: 'admin' },
};

const AGENT_NAMES = [
  'Ahmed Hassan', 'Sara Mahmoud', 'Omar Khaled', 'Mona Adel', 'Youssef Ibrahim', 'Nour Ali', 'Karim Mostafa',
  'Hana Samir', 'Mahmoud Tarek', 'Salma Fathy', 'Ali Gamal', 'Rana Wael', 'Mostafa Said', 'Dina Reda',
  'Tamer Hossam', 'Yasmin Sherif', 'Hossam Nabil', 'Mariam Ashraf', 'Khaled Fawzy', 'Aya Mohamed',
  'Amr Saleh', 'Nada Emad', 'Sherif Magdy', 'Reem Osama', 'Islam Hany',
];

export function demoPeople() {
  const people = AGENT_NAMES.map((full_name, i) => ({
    full_name,
    username: full_name.toLowerCase().replace(/\s+/g, '.'),
    employee_id: `2B-${String(i + 1).padStart(3, '0')}`,
    role: 'agent',
  }));
  people.push(HUMANS.supervisor, { username: 'waleed.kamal', full_name: 'Waleed Kamal', employee_id: '2B-S02', role: 'supervisor' }, HUMANS.admin);
  return people;
}

const CUSTOMERS = [
  'محمد علي', 'Mostafa Hassan', 'سارة أحمد', 'Youssef Adel', 'نور الدين', 'Ahmed Samir', 'Mariam Khaled', 'عمر طارق',
  'Hana Mahmoud', 'Karim Fathy', 'سلمى إبراهيم', 'Ali Mostafa', 'Rana Sherif', 'محمود جمال', 'Dina Wael', 'Hossam Reda',
  'ياسمين عادل', 'Tamer Said', 'Mohamed Abdelaziz', 'رحاب سمير', 'Islam Fawzy', 'Nadine Hany', 'خالد منصور', 'Farah Nabil',
  'Bassem Lotfy', 'مي عبد الله', 'Ziad Hamdy', 'Laila Osman', 'Amr Shawky', 'هبة فاروق',
];

const OPENERS = {
  sales: [
    'عايز اللابتوب Lenovo LOQ ده بالتقسيط، ينفع؟',
    'السعر النهائي كام للـ iPhone 15 Pro؟ عايز أحجزه النهارده',
    'عندكم PS5 Slim متاح في فرع مدينة نصر؟ هعدي آخده',
    'عايز أطلب شاشة Samsung 27 بوصة توصيل للبيت في المعادي',
    'لو أخدت اللابتوب والماوس مع بعض في خصم؟',
    'ابعتلي لينك الدفع للـ Galaxy S24 لو سمحت',
  ],
  complaint: [
    'الأوردر وصل والشاشة مكسورة 😡 عايز حل',
    'بقالي أسبوع مستني الأوردر ومحدش بيرد عليا',
    'اللابتوب بيسخن جدا من أول يوم وعايز أرجعه',
    'اتخصم مني المبلغ مرتين على الفيزا!',
    'المندوب كان قليل الذوق جدا مع والدتي',
  ],
  followup: [
    'عايز أعرف الأوردر رقم 48213 وصل فين؟',
    'الشحنة اتأخرت عن الميعاد، امتى هتوصل؟',
    'طلبت امبارح وماوصلنيش رسالة تأكيد',
    'الاستبدال اللي اتفقنا عليه عمل إيه؟',
    'Order 51877 still shows "processing", any update?',
  ],
  inquiry: [
    'الضمان على الموبايلات كام سنة؟',
    'مواعيد فرع الهرم إيه يوم الجمعة؟',
    'هل في عروض على السماعات اللاسلكي؟',
    'Do you have the Logitech MX Master 3S in stock?',
    'ينفع أبدل جهاز قديم بجديد عندكم؟',
  ],
};

const AI_BRIDGE = {
  sales: 'تمام 👌 هحولك لزميلي من فريق المبيعات يكمل معاك الحجز حالا.',
  complaint: 'متأسفين جدا على ده 🙏 هحولك لزميلي من خدمة العملاء يحلها معاك فورا.',
  followup: 'ثواني وهحولك لزميلي يتابع الأوردر معاك.',
  inquiry: 'هحولك لزميلي يجاوبك بالتفصيل.',
};

const SUMMARIES = {
  sales: ['Ready to buy; asked about installments over 12 months.', 'Wants to reserve the item today and pick it up from the branch.', 'Asked for the payment link; budget around 45,000 EGP.'],
  complaint: ['Item arrived damaged; customer is upset and wants a replacement.', 'Charged twice on the card; needs a refund check.', 'Delivery delayed a week; customer is frustrated.'],
  followup: ['Asking for the status of an existing order.', 'Waiting for a replacement agreed last week.', 'No confirmation message after ordering yesterday.'],
  inquiry: ['General question the AI could not answer confidently.', 'Asked to speak to a person.'],
};

const AGENT_REPLIES = [
  'أهلا بحضرتك 👋 معاك {agent} من 2B، ثواني أراجع الطلب.',
  'تمام يا فندم، ممكن رقم الأوردر لو سمحت؟',
  'الطلب في الشحن وهيوصل خلال 48 ساعة إن شاء الله.',
  'متاح بالتقسيط على 12 شهر بدون فوايد 🙌 أبعتلك اللينك؟',
  'متأسفين جدا على التجربة دي، هنعملك استبدال فوري والمندوب هيكلمك النهارده.',
  'تم مراجعة الخصم، والمبلغ هيرجع على الكارت خلال 3-5 أيام عمل.',
  'أيوه موجود في الفرع، اتحجزلك باسم حضرتك لحد بكرة.',
  'أي خدمة تانية أقدر أساعدك فيها؟',
];

const CUSTOMER_FOLLOWUPS = [
  'تمام شكرا', 'طيب امتى بالظبط؟', 'رقم الأوردر 48213', 'ماشي ابعتلي اللينك', 'حلو جدا 👍', 'لسه موصلش', 'ok thanks', 'يعني هستنى قد إيه؟',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Minutes after local midnight, in the configured time zone.
function localMinutes(d, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value);
}

export function createSimulation({
  desk, db, clock, log = console, seed = 7, arrivalScale = 1, alwaysOn = false,
  humans = Object.values(HUMANS).map((h) => h.username),
}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + rnd() * (b - a);
  const agents = new Map(); // userId -> virtual agent
  const plans = new Map(); // convId -> plan
  let customerSeq = Math.floor(rnd() * 1e6);
  let tz = 'Africa/Cairo';

  async function load() {
    const s = await db.one(`SELECT value FROM desk.settings WHERE key = 'timezone'`);
    if (s) tz = s.value;
    const users = await db.q(`SELECT * FROM desk.users WHERE role = 'agent' AND is_active ORDER BY employee_id`);
    users.forEach((u, i) => {
      if (humans.includes(u.username)) return;
      // Most agents are quick; a few are slow, which is what produces timeouts.
      const kind = i % 8 === 3 ? 'slow' : i % 5 === 1 ? 'steady' : 'quick';
      const morning = i % 2 === 0;
      agents.set(u.id, {
        user: u,
        auth: null,
        kind,
        median: { quick: 60_000, steady: 150_000, slow: 480_000 }[kind],
        shift: morning ? [9 * 60 + Math.floor(rnd() * 25), 17 * 60 + Math.floor(rnd() * 30)] : [13 * 60 + Math.floor(rnd() * 25), 22 * 60 + Math.floor(rnd() * 40)],
        breakAt: (morning ? 12 * 60 : 17 * 60) + Math.floor(rnd() * 90),
        breakLen: 12 + Math.floor(rnd() * 22),
        // Live demo: a few people have the day off, the rest take short staggered breaks.
        dayOff: i % 6 === 5,
        breakEvery: 45 + Math.floor(rnd() * 40),
        breakOffset: Math.floor(rnd() * 60),
      });
    });
  }

  function sampleDelay(a, load, urgent) {
    // Log-normal-ish around the median, slower when the queue is full. A chat
    // that arrives flagged (moved for no reply) gets jumped on — except by the
    // slow ones.
    const z = (rnd() + rnd() + rnd() - 1.5) * 1.2;
    const median = urgent ? { quick: 24_000, steady: 45_000, slow: 200_000 }[a.kind] : a.median;
    return median * Math.exp(z) * (1 + load / 40);
  }

  async function shiftStep(at) {
    const m = localMinutes(at, tz);
    const epochMin = Math.floor(at.getTime() / 60_000);
    for (const a of agents.values()) {
      const [start, end] = a.shift;
      const inShift = alwaysOn ? !a.dayOff : m >= start && m < end;
      const onBreak = alwaysOn
        ? (epochMin + a.breakOffset) % a.breakEvery < 5
        : m >= a.breakAt && m < a.breakAt + a.breakLen;
      if (inShift && !a.auth) {
        const { token } = await desk.login({ username: a.user.username, password: DEMO_PASSWORD, ip: '10.0.0.' + (a.user.id % 250), userAgent: 'demo' });
        a.auth = await desk.authenticate(token);
      }
      if (!inShift && a.auth) {
        await desk.logout(a.auth);
        a.auth = null;
        continue;
      }
      if (!a.auth) continue;
      await desk.touch(a.auth);
      const st = await db.one('SELECT status FROM desk.agent_state WHERE user_id = $1', [a.user.id]);
      const want = onBreak ? 'not_ready' : 'ready';
      if (st?.status !== want) await desk.setStatus(a.auth, want);
    }
  }

  function arrivalsPerMinute(at) {
    if (alwaysOn) return 1.1 * arrivalScale;
    const h = localMinutes(at, tz) / 60;
    // Busy around lunch and in the evening, quiet early morning.
    const curve = h < 9 ? 0.02 : h < 11 ? 0.9 : h < 15 ? 1.5 : h < 18 ? 1.1 : h < 21.5 ? 1.35 : 0.04;
    return curve * arrivalScale;
  }

  async function arrive(at) {
    const r = rnd();
    const category = r < 0.36 ? 'sales' : r < 0.6 ? 'followup' : r < 0.78 ? 'complaint' : 'inquiry';
    const c = rnd();
    const channel = c < 0.56 ? 'whatsapp' : c < 0.8 ? 'instagram' : 'messenger';
    customerSeq += 1;
    const phone = `2010${String(10000000 + ((customerSeq * 7919) % 89999999)).padStart(8, '0')}`;
    const external_id = channel === 'whatsapp' ? `${phone}@s.whatsapp.net` : `${channel === 'instagram' ? 'IG' : 'PS'}${customerSeq}${Math.floor(rnd() * 1e6)}`;
    const opener = pick(OPENERS[category]);
    const history = [{ role: 'customer', text: opener }];
    if (rnd() < 0.5) history.unshift({ role: 'customer', text: 'السلام عليكم' }, { role: 'assistant', text: 'وعليكم السلام 👋 أنا مساعد 2B الذكي، أقدر أساعدك إزاي؟' });
    history.push({ role: 'assistant', text: AI_BRIDGE[category] });
    await desk.ingestMessage({ channel, external_id, text: opener });
    await desk.ingestHandoff({
      channel, external_id, customer_name: pick(CUSTOMERS), phone: channel === 'whatsapp' ? phone : null,
      customer_ref: String(100000 + customerSeq), category, summary: pick(SUMMARIES[category]), history,
    });
  }

  async function agentStep(at) {
    const rows = await db.q(
      `SELECT c.id, c.assigned_to, c.waiting_since, c.assigned_at, c.last_agent_at, c.last_customer_at, c.status,
              (SELECT count(*) FROM desk.messages m WHERE m.conversation_id = c.id AND m.sender = 'agent')::int AS replies,
              (SELECT count(*) FROM desk.conversations x WHERE x.status = 'assigned' AND x.assigned_to = c.assigned_to)::int AS load,
              (SELECT how FROM desk.assignments a WHERE a.conversation_id = c.id AND a.ended_at IS NULL) AS how
         FROM desk.conversations c WHERE c.status = 'assigned'`,
    );
    for (const c of rows) {
      const a = agents.get(c.assigned_to);
      let plan = plans.get(c.id);
      if (!plan) {
        plan = { rounds: 0 };
        plans.set(c.id, plan);
      }
      // The customer writes back some time after our reply.
      if (!c.waiting_since && plan.customerAt && at >= plan.customerAt) {
        plan.customerAt = null;
        const conv = await db.one('SELECT channel, external_id FROM desk.conversations WHERE id = $1', [c.id]);
        await desk.ingestMessage({ channel: conv.channel, external_id: conv.external_id, text: pick(CUSTOMER_FOLLOWUPS) });
        continue;
      }
      if (!a || !a.auth) continue; // a human's chat, or the agent is gone
      if (c.waiting_since) {
        const key = `${c.assigned_to}:${new Date(c.waiting_since).getTime()}`;
        if (plan.key !== key) {
          const from = Math.max(at.getTime(), new Date(c.assigned_at).getTime());
          plan.key = key;
          plan.replyAt = from + sampleDelay(a, c.load, c.how === 'sla' || c.how === 'transfer');
        }
        if (at.getTime() >= plan.replyAt) {
          const text = pick(AGENT_REPLIES).replace('{agent}', a.user.full_name.split(' ')[0]);
          await desk.recordActivity(a.auth, Math.round(text.length * between(1.1, 1.6)), Math.round(text.length * between(140, 260)));
          try {
            const { delivery } = await desk.sendReply(a.auth, c.id, text);
            await delivery;
          } catch {
            /* moved meanwhile */
          }
          plan.rounds += 1;
          plan.customerAt = plan.rounds < 4 && rnd() < 0.62 ? at.getTime() + between(60_000, 14 * 60_000) : null;
          plan.closeAt = at.getTime() + (plan.customerAt ? 30 * 60_000 : between(2 * 60_000, 9 * 60_000));
        }
      } else if (plan.closeAt && at.getTime() >= plan.closeAt && c.replies > 0) {
        try {
          await desk.close(a.auth, c.id);
        } catch {
          /* already moved */
        }
        plans.delete(c.id);
      }
    }
  }

  // One step of `dtMs` ending at clock.now().
  async function step(dtMs) {
    const at = clock.now();
    await shiftStep(at);
    const expected = (arrivalsPerMinute(at) * dtMs) / 60_000;
    let n = Math.floor(expected) + (rnd() < expected - Math.floor(expected) ? 1 : 0);
    while (n-- > 0) await arrive(at);
    await agentStep(at);
  }

  return { load, step, agents };
}

// DEMO_MODE=true: keep the floor alive in real time inside the server.
export async function startDemo({ desk, db, clock, log = console, everyMs = 3000 }) {
  const sim = createSimulation({ desk, db, clock, log, seed: Date.now() % 100000, arrivalScale: 1.5, alwaysOn: true });
  await sim.load();
  log.info?.(`[demo] simulating ${sim.agents.size} virtual agents; sign in as ${HUMANS.agent.username} / ${DEMO_PASSWORD}`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await sim.step(everyMs);
    } catch (err) {
      log.error?.('[demo]', err.message);
    } finally {
      busy = false;
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

