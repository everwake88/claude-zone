// The routing / SLA numbers, read from desk.settings and cached briefly.
// Supervisors change them from the Settings page; the engine picks the new
// values up within a few seconds without a restart.
import { badRequest } from './errors.js';

export const DEFAULTS = {
  max_chats: 25,
  sla_minutes: 15,
  first_hold_minutes: 10,
  hop_minutes: 1,
  reminder_minutes: [5, 8],
  transfer_timeout_seconds: 60,
  offline_after_seconds: 90,
  auto_checkout_minutes: 30,
  timezone: 'Africa/Cairo',
  busy_replies_per_minute: 0.5,
  busy_typing_share: 0.25,
  idle_typing_share: 0.05,
};

// What may be edited, and the allowed range for each value.
const RULES = {
  max_chats: { min: 1, max: 200, int: true },
  sla_minutes: { min: 1, max: 240 },
  first_hold_minutes: { min: 0.5, max: 240 },
  hop_minutes: { min: 0.25, max: 60 },
  transfer_timeout_seconds: { min: 10, max: 600, int: true },
  offline_after_seconds: { min: 30, max: 900, int: true },
  auto_checkout_minutes: { min: 5, max: 600, int: true },
  busy_replies_per_minute: { min: 0, max: 20 },
  busy_typing_share: { min: 0, max: 1 },
  idle_typing_share: { min: 0, max: 1 },
};

function derive(s) {
  const min = 60_000;
  const reminders = (Array.isArray(s.reminder_minutes) ? s.reminder_minutes : [])
    .map(Number)
    .filter((m) => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);
  return {
    ...s,
    reminder_minutes: reminders,
    slaMs: s.sla_minutes * min,
    firstHoldMs: s.first_hold_minutes * min,
    hopMs: s.hop_minutes * min,
    reminderMs: reminders.map((m) => m * min),
    transferTimeoutMs: s.transfer_timeout_seconds * 1000,
    offlineAfterMs: s.offline_after_seconds * 1000,
    autoCheckoutMs: s.auto_checkout_minutes * min,
  };
}

export function createSettings(db) {
  let cache = null;
  let loadedAt = 0;

  async function get(runner = db, { fresh = false } = {}) {
    if (!fresh && cache && Date.now() - loadedAt < 3000) return cache;
    const rows = await runner.q('SELECT key, value FROM desk.settings');
    const s = { ...DEFAULTS };
    for (const r of rows) if (r.key in DEFAULTS) s[r.key] = r.value;
    cache = derive(s);
    loadedAt = Date.now();
    return cache;
  }

  async function update(patch) {
    const clean = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      if (key === 'reminder_minutes') {
        const list = (Array.isArray(raw) ? raw : String(raw).split(','))
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v));
        if (list.length > 6 || list.some((v) => v <= 0 || v > 240)) {
          throw badRequest('Reminders must be up to 6 values between 0 and 240 minutes.');
        }
        clean[key] = [...new Set(list)].sort((a, b) => a - b);
      } else if (key === 'timezone') {
        const tz = String(raw);
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
        } catch {
          throw badRequest(`"${tz}" is not a time zone. Use a name like Africa/Cairo.`);
        }
        clean[key] = tz;
      } else if (RULES[key]) {
        const n = Number(raw);
        const r = RULES[key];
        if (!Number.isFinite(n) || n < r.min || n > r.max || (r.int && !Number.isInteger(n))) {
          throw badRequest(`${key.replace(/_/g, ' ')} must be between ${r.min} and ${r.max}.`);
        }
        clean[key] = n;
      }
    }
    const merged = { ...(await get(db, { fresh: true })), ...clean };
    if (merged.first_hold_minutes > merged.sla_minutes) {
      throw badRequest('The first agent cannot hold a chat longer than the SLA itself.');
    }
    for (const [key, value] of Object.entries(clean)) {
      await db.q(
        `INSERT INTO desk.settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
    cache = null;
    return get(db, { fresh: true });
  }

  return { get, update, invalidate: () => (cache = null) };
}

// The subset the dashboard needs to draw countdowns and rules.
export function publicSettings(s) {
  return {
    max_chats: s.max_chats,
    sla_minutes: s.sla_minutes,
    first_hold_minutes: s.first_hold_minutes,
    hop_minutes: s.hop_minutes,
    reminder_minutes: s.reminder_minutes,
    transfer_timeout_seconds: s.transfer_timeout_seconds,
    offline_after_seconds: s.offline_after_seconds,
    auto_checkout_minutes: s.auto_checkout_minutes,
    timezone: s.timezone,
    busy_replies_per_minute: s.busy_replies_per_minute,
    busy_typing_share: s.busy_typing_share,
    idle_typing_share: s.idle_typing_share,
  };
}
