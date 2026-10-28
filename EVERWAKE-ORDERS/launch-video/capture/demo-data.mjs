// What the showcase restaurant does not have and the video shows: more
// offers, Paymob connected, a driver signed in on a phone, and the featured
// order — a customer who orders by voice note and photo, pays online, and
// lands on the board while the camera is on it.
// Everything is made up; it runs only on the local filming database.
import crypto from 'node:crypto';
import { db, SLUG, tenant } from './lib.mjs';

export const DRIVER_TOKEN = 'filming-driver-token-0001';
export const NADEEN = { wa: '201227483915', name: 'نادين عادل', first: 'نادين' };

async function one(sql, args = []) { return (await db.query(sql, args)).rows[0]; }

export async function prepare() {
  const t = await tenant();
  const T = t.id;

  // more offers, one of them switched off
  await db.query(`delete from everwake.offers where tenant_id = $1 and title_ar <> 'خصم 10% على الطلبات فوق 1000ج'`, [T]);
  const mixed = await one(`select id from everwake.menu_items where tenant_id = $1 and code = 'M001'`, [T]);
  const baba = await one(`select id from everwake.menu_items where tenant_id = $1 and code = 'M017'`, [T]);
  await db.query(`
    insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, value, min_subtotal, promo_code, stackable, priority, is_active)
    values ($1, 'كود GRILL50 — خصم 50ج', 'Code GRILL50', 'خصم 50ج بالكود GRILL50 على أي طلب فوق 400ج', 'amount_off', 'order', 50, 400, 'GRILL50', true, 20, true),
           ($1, 'توصيل مجاني يوم الجمعة', 'Free delivery on Fridays', 'التوصيل مجاني يوم الجمعة على الطلبات فوق 700ج', 'free_delivery', 'order', 0, 700, null, true, 30, true)`, [T]);
  await db.query(`update everwake.offers set days_of_week = '{5}' where tenant_id = $1 and kind = 'free_delivery'`, [T]);
  await db.query(`
    insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, item_ids, free_item_id, free_item_qty, stackable, priority, is_active)
    values ($1, 'بابا غنوج هدية مع المشكل', 'Free baba ghanoush with the mixed grill', 'بابا غنوج هدية مع أي مشكل مشويات', 'free_item', 'items', array[$2::uuid], $3, 1, true, 40, true)`,
    [T, mixed.id, baba.id]);
  await db.query(`
    insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, value, first_order_only, stackable, priority, is_active)
    values ($1, 'أول طلب — خصم 15%', 'First order 15% off', 'خصم 15% على أول طلب واتساب', 'percent_off', 'order', 15, true, false, 50, false)`, [T]);

  // Paymob connected (made-up keys; nothing can be charged)
  const sk = await one(`select vault.create_secret('filming-not-a-real-key') as id`);
  const hm = await one(`select vault.create_secret('filming-not-a-real-hmac') as id`);
  await db.query(`
    insert into everwake.payment_accounts (tenant_id, enabled, public_key, secret_key_id, hmac_secret_id, secret_hint, card_integration_id,
                                           wallet_integration_id, dashboard_url, is_live, last_callback_at, billing_email)
    values ($1, true, 'egy_pk_live_filming0000', $2, $3, 'f1lm', 4810021, 4810022, 'https://orders.everwake.tech', true, now() - interval '20 minutes', 'orders@grillhouse.example')
    on conflict (tenant_id) do update set enabled = true, is_live = true, dashboard_url = excluded.dashboard_url, last_callback_at = excluded.last_callback_at`,
    [T, sk.id, hm.id]);

  // a driver signed in on their phone
  const drv = await one(`select id from everwake.drivers where tenant_id = $1 order by phone limit 1 offset 3`, [T]);
  await db.query(`delete from everwake.driver_sessions where driver_id = $1`, [drv.id]);
  await db.query(`insert into everwake.driver_sessions (token_hash, driver_id, tenant_id, user_agent)
                  values (everwake.token_hash($1), $2, $3, 'iPhone')`, [DRIVER_TOKEN, drv.id, T]);

  // the featured customer, new to the restaurant
  for (const tbl of ['payments', 'order_items', 'order_events']) {
    await db.query(`delete from everwake.${tbl} where order_id in (select id from everwake.orders where tenant_id = $1 and wa_id = $2)`, [T, NADEEN.wa]);
  }
  for (const tbl of ['orders', 'messages', 'conversations', 'customer_identities', 'customers']) {
    await db.query(`delete from everwake.${tbl} where tenant_id = $1 and ${tbl === 'customer_identities' ? 'value' : 'wa_id'} = $2`, [T, NADEEN.wa]);
  }
  const c = await one(`insert into everwake.customers (tenant_id, wa_id, reply_to, phone, display_name, language, first_seen_at)
                       values ($1, $2, $2, $2, $3, 'ar', now() - interval '8 minutes') returning id`, [T, NADEEN.wa, NADEEN.first]);
  await db.query(`insert into everwake.customer_identities (tenant_id, kind, value, customer_id) values ($1, 'phone', $2, $3) on conflict do nothing`, [T, NADEEN.wa, c.id]);
  await db.query(`insert into everwake.conversations (tenant_id, customer_id, wa_id, state) values ($1, $2, $3, '{}')`, [T, c.id, NADEEN.wa]);
  return { tenant: T, driver: drv.id };
}

// The order goes in: the whole conversation up to it, the order, its
// payment, and the messages after it. Returns the order number and the
// payment reference.
export async function placeOrder({ voiceUrl, photoUrl }) {
  const t = await tenant();
  const T = t.id;
  const conv = await one(`select c.id, c.customer_id from everwake.conversations c where c.tenant_id = $1 and c.wa_id = $2`, [T, NADEEN.wa]);
  const branch = await one(`select id from everwake.branches where tenant_id = $1 and code = 'tagamoa'`, [T]);
  const zone = await one(`select id from everwake.delivery_zones where tenant_id = $1 and name_ar = 'التجمع الخامس'`, [T]);
  const items = Object.fromEntries((await db.query(`select code, id from everwake.menu_items where tenant_id = $1 and code in ('M002', 'M006', 'M019')`, [T])).rows.map((r) => [r.code, r.id]));
  const seq = await one(`update everwake.tenants set order_seq = order_seq + 1 where id = $1 returning order_no_prefix || '-' || order_seq as no`, [T]);
  const no = seq.no;
  const ref = crypto.randomBytes(6).toString('hex');
  const lat = 30.0207, lng = 31.4632;

  const lines = [
    { code: 'M002', unit: 'kg', notes: null, choices: [], item_id: items.M002, line_id: 'L1', quantity: 1, item_name: 'كفتة مشوية',
      line_total: 540, unit_price: 540, display_name: 'كفتة مشوية' },
    { code: 'M006', unit: 'portion', notes: null, item_id: items.M006, line_id: 'L2', quantity: 1, item_name: 'فرخة مشوية',
      choices: [{ level: 1, label_ar: 'الحجم', selected: [{ adds: 240, name: 'فرخة كاملة' }] }, { level: 2, label_ar: 'التتبيلة', selected: [{ name: 'ليمون وثوم' }] }],
      line_total: 530, unit_price: 530, display_name: 'فرخة مشوية (كاملة، ليمون وثوم)' },
    { code: 'M019', unit: 'portion', notes: null, choices: [], item_id: items.M019, line_id: 'L3', quantity: 2, item_name: 'أم علي',
      line_total: 180, unit_price: 90, display_name: 'أم علي' }
  ];
  const sub = 1250, disc = 125, vat = 157.5, fee = 30, total = 1312.5;

  const say = async (who, body, ago, extra = {}) => {
    await db.query(`
      insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, media_url, meta, status, created_at, sent_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - $11::interval, case when $5 = 'customer' then null else now() - $11::interval end)`,
      [T, conv.id, NADEEN.wa, who === 'customer' ? 'inbound' : 'outbound', who, extra.kind || 'text', body, extra.media_url || null,
       extra.meta || {}, who === 'customer' ? 'received' : 'read', ago]);
  };

  await say('customer', null, '7 minutes', { kind: 'audio', media_url: voiceUrl, meta: {
    understood: '[voice note (14s): «مساء الخير، عايزة كيلو كفتة وفرخة كاملة ليمون وتوم، والتوصيل على التجمع الخامس»]' } });
  await say('agent', 'مساء النور 🌙 سمعتك:\n• كيلو كفتة مشوية — 540ج\n• فرخة مشوية كاملة، ليمون وثوم — 530ج\nتحبي تزودي حاجة؟', '6 minutes 40 seconds');
  await say('customer', 'وده كمان، اتنين 👆', '6 minutes', { kind: 'image', media_url: photoUrl, meta: {
    understood: '[photo: A photo of a printed Grill House menu page with one dish circled in pen: «أم علي — 90ج».] وده كمان، اتنين 👆' } });
  await say('agent', 'ضفت 2 أم علي — 180ج 😋\nوطلبك عدّى 1000ج، فليكي خصم 10%.\nابعتيلي اللوكيشن وأنا أحدد أقرب فرع.', '5 minutes 40 seconds');
  await say('customer', null, '5 minutes', { kind: 'location', meta: { location: { lat, lng, maps_url: `https://www.google.com/maps?q=${lat},${lng}` } } });
  await say('agent', 'التجمع الخامس ✅ هيوصلك من فرع التجمع خلال 35–50 دقيقة، والتوصيل 30ج.\nاسم حضرتك إيه؟ وهتدفعي كاش ولا أونلاين؟', '4 minutes 45 seconds');
  await say('customer', 'نادين، أونلاين', '4 minutes');
  await say('agent', 'تمام يا نادين 👌\n*طلبك:*\n• كيلو كفتة مشوية — 540ج\n• فرخة مشوية كاملة، ليمون وثوم — 530ج\n• 2 أم علي — 180ج\nخصم 10% — 125ج-\nضريبة 14% — 157.5ج\nالتوصيل — 30ج\n*الإجمالي — 1,312.5ج*\n\nكده كله مظبوط؟', '3 minutes 40 seconds');
  await say('customer', 'تمام', '3 minutes');

  const o = await one(`
    insert into everwake.orders (tenant_id, order_no, customer_id, conversation_id, wa_id, branch_id, zone_id, status, cart, subtotal, discount_total,
                                 applied_offers, vat, delivery_fee, total, delivery_method, payment_method, customer, address_text, address, location,
                                 eta_text, placed_at, created_at, updated_at, payment_status, paid_at, paid_amount)
    values ($1, $2, $3, $4, $5, $6, $7, 'placed', $8, $9, $10, $11, $12, $13, $14, 'delivery', 'online', $15, $16, $17, $18,
            '35–50 دقيقة', now() - interval '2 minutes', now() - interval '8 minutes', now(), 'paid', now() - interval '20 seconds', $14)
    returning id`,
    [T, no, conv.customer_id, conv.id, NADEEN.wa, branch.id, zone.id, { items: lines }, sub, disc,
     JSON.stringify([{ title: 'خصم 10% على الطلبات فوق 1000ج', amount: disc }]), vat, fee, total,
     { full_name: NADEEN.name, phone: NADEEN.wa, phone_confirmed: 'yes', delivery_method: 'delivery', payment_method: 'online' },
     'التجمع الخامس، شارع التسعين الجنوبي، عمارة 12، الدور 4، شقة 8',
     { area: 'التجمع الخامس', street: 'شارع التسعين الجنوبي', building: '12', floor: '4', apartment: '8' },
     { lat, lng, maps_url: `https://www.google.com/maps?q=${lat},${lng}` }]);
  await db.query(`
    insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, unit, quantity, unit_price, line_total, choices)
    select $1, $2, ord::int, (x ->> 'item_id')::uuid, x ->> 'code', x ->> 'display_name', x ->> 'unit', (x ->> 'quantity')::numeric,
           (x ->> 'unit_price')::numeric, (x ->> 'line_total')::numeric, x -> 'choices'
      from jsonb_array_elements($3::jsonb) with ordinality as e(x, ord)`, [T, o.id, JSON.stringify(lines)]);
  await db.query(`insert into everwake.order_events (tenant_id, order_id, status, by_role, notified, created_at) values ($1, $2, 'placed', 'agent', false, now() - interval '2 minutes')`, [T, o.id]);
  await db.query(`
    insert into everwake.payments (tenant_id, order_id, ref, amount, status, method, card_brand, card_last4, link_url, expires_at, paid_at, created_at, is_live)
    values ($1, $2, $3, $4, 'paid', 'card', 'Visa', '4417', $5, now() + interval '58 minutes', now() - interval '20 seconds', now() - interval '2 minutes', true)`,
    [T, o.id, ref, total, `https://orders.everwake.tech/p/${ref}`]);

  await say('agent', `اتأكد طلبك رقم *${no}* 🎉 هيوصلك خلال 35–50 دقيقة. ولينك الدفع وصلك في الرسالة اللي جاية.`, '2 minutes');
  await say('system', `لينك الدفع لطلبك ${no} — 1,312.5ج:\nhttps://orders.everwake.tech/p/${ref}\nاللينك شغال لحد ساعة من دلوقتي.`, '1 minute 50 seconds');
  await say('customer', 'دفعت ✅', '30 seconds');
  await say('system', `وصلنا الدفع لطلبك رقم ${no} ✅ شكراً ليكي!`, '20 seconds');
  // what the engine keeps after a turn like this: the customer's tally and what the agent knows
  await db.query(`update everwake.customers set full_name = $2, orders_count = 1, total_spent = $3, last_order_id = $4, last_order_at = now(),
                         last_seen_at = now() where id = $1`, [conv.customer_id, NADEEN.name, total, o.id]);
  await db.query(`update everwake.conversations set last_message_at = now(), state = $2 where id = $1`, [conv.id, {
    phase: 'placed', last_language: 'ar', last_turn_at: new Date().toISOString(),
    zone: { name: 'التجمع الخامس', delivery_fee: 30 },
    branch: { id: branch.id, code: 'tagamoa', source: 'zone', name_ar: 'التجمع الخامس' },
    customer: { phone: NADEEN.wa, full_name: NADEEN.name, address_area: 'التجمع الخامس', address_street: 'شارع التسعين الجنوبي',
                address_building: '12', payment_method: 'online', delivery_method: 'delivery', phone_confirmed: 'yes' }
  }]);
  return { no, ref, orderId: o.id };
}

export { SLUG };
