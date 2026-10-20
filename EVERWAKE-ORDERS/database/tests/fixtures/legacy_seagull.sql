-- An old one-schema-per-brand client, shaped like the Seagull schema:
-- two branches, a menu snapshot with choice levels and a branch price,
-- a customer by number and one behind a WhatsApp private id, finished,
-- cancelled and draft orders, messages, menu pages.
-- Used by tests/60_legacy_import.sql and the engine tests.
drop schema if exists legacy_sg cascade;
create schema legacy_sg;

create table legacy_sg.settings (key text primary key, value jsonb);
insert into legacy_sg.settings values
  ('max_delivery_km', '8'), ('ops_whatsapp', '"201555000111"'), ('order_no_prefix', '"SG"');

create table legacy_sg.branches (
  id text primary key, name_ar text, name_en text, lat double precision, lng double precision,
  accepting_orders boolean default true, max_delivery_km numeric, delivery_fee_egp numeric, min_order_egp numeric,
  ops_whatsapp text, vat_percent numeric, hours jsonb);
insert into legacy_sg.branches values
  ('el_max', 'المكس', 'El Max', 31.1500, 29.8600, true, 6, 30, 200, '201555000222', 14,
   '{"default": [{"open": "12:00", "close": "02:00"}]}'),
  ('gleem', 'جليم', 'Gleem', 31.2400, 29.9600, true, null, 25, null, null, null, null);

create table legacy_sg.menu_snapshot (id text primary key, digest_text text, version_hash text, lookup jsonb);
insert into legacy_sg.menu_snapshot values
  ('all', '…', 'v1', $j${
     "settings": {"agent_name": "سلمى", "brand_facts_ar": ["سمك طازة كل يوم", "من سنة ١٩٩٠"],
                  "contacts": {"hotline": "19999", "complaints_whatsapp": "201555000333"},
                  "payment_methods_confirmed": ["كاش", "إنستاباي"]},
     "branches": [{"id": "el_max", "code": "el_max", "name_ar": "المكس", "area_ar": "المكس"},
                  {"id": "gleem", "code": "gleem", "name_ar": "جليم", "area_ar": "جليم"}],
     "items": {
       "M001": {"name": "بوري", "name_en": "Mullet", "category": "سمك بالكيلو", "unit": "kg", "price_egp": 420,
                "qty_step": 0.25, "min_qty": 0.5, "aliases": ["بورى"], "tags": ["Fish"], "signature": true,
                "orderable": true, "available": true},
       "M002": {"name": "شوربة سي فود", "category": "شوربة", "unit": "portion", "price_egp": 150, "available": true},
       "M026": {"name": "جمبري جامبو", "category": "سمك بالكيلو", "unit": "kg", "price_egp": 1200, "available": false}},
     "choices": {
       "M001": {"levels": [
         {"level": 1, "label_ar": "طريقة الطهي", "required": true, "min": 1, "max": 1,
          "options": [{"name": "مشوي", "price_egp": 0}, {"name": "مقلي", "price_egp": 0},
                      {"name": "سنجاري", "price_egp": 20, "aliases": ["سنجارى"]}]},
         {"level": 2, "label_ar": "إضافات", "required": false, "min": 0, "max": null,
          "options": [{"name": "طاجن", "price_egp": 0, "extra_charge": true}, {"name": "رز", "price_egp": 30}]}]}}
   }$j$),
  ('el_max', '…', 'v1', $j${"items": {
       "M001": {"name": "بوري", "price_egp": 420, "unit": "kg", "available": true},
       "M002": {"name": "شوربة سي فود", "price_egp": 150, "available": true},
       "M026": {"name": "جمبري جامبو", "price_egp": 1200, "unit": "kg", "available": false}}}$j$),
  ('gleem', '…', 'v1', $j${"items": {
       "M001": {"name": "بوري", "price_egp": 450, "unit": "kg", "available": true},
       "M002": {"name": "شوربة سي فود", "price_egp": 150, "available": true}}}$j$);

create table legacy_sg.customers (whatsapp_number text primary key, display_name text, created_at timestamptz, updated_at timestamptz);
insert into legacy_sg.customers values
  ('201011111111', 'Omar', now() - interval '200 days', now()),
  ('123456789012345', 'Mona', now() - interval '20 days', now());

create table legacy_sg.orders (
  id serial primary key, order_no text, whatsapp_number text, status text, placed_at timestamptz, branch_id text,
  customer jsonb, delivery_method text, payment_method text, address_text text, location jsonb, notes text, cart jsonb,
  subtotal_egp numeric, vat_egp numeric, delivery_fee_egp numeric, final_total_egp numeric,
  created_at timestamptz default now(), updated_at timestamptz default now());
insert into legacy_sg.orders (order_no, whatsapp_number, status, placed_at, branch_id, customer, delivery_method, payment_method,
                              address_text, location, cart, subtotal_egp, vat_egp, delivery_fee_egp, final_total_egp) values
  ('SG-1040', '201011111111', 'placed', now() - interval '90 days', 'el_max',
   '{"full_name": "عمر حسن", "phone": "201011111111"}', 'pickup', 'كاش', null, null,
   '{"items": [{"menu_id": "M002", "item_name": "شوربة سي فود", "quantity": 1, "unit_price_egp": 150, "line_total_egp": 150}]}',
   150, 0, null, 150),
  ('SG-1041', '201011111111', 'placed', now() - interval '30 days', 'el_max',
   '{"full_name": "عمر حسن", "phone": "201011111111", "address_area": "المكس", "address_street": "شارع المكس", "address_building": "12", "address_floor": "2", "address_apartment": "4"}',
   'delivery', 'cash', 'شارع المكس، عمارة 12', '{"lat": 31.152, "lng": 29.865, "maps_url": "https://maps.google.com/?q=31.152,29.865"}',
   $j${"items": [
     {"line_id": "L1", "menu_id": "M001", "item_name": "بوري", "display_name": "بوري", "unit": "kg", "quantity": 1.5,
      "base_price_egp": 420, "choices": [{"level": 1, "selected": [{"name": "مشوي", "adds_egp": 0}]},
                                         {"level": 2, "selected": [{"name": "رز", "adds_egp": 30}]}],
      "unit_price_egp": 450, "line_total_egp": 675, "notes": "من غير شطة"},
     {"line_id": "L2", "menu_id": "M002", "item_name": "شوربة سي فود", "quantity": 1, "unit_price_egp": 150, "line_total_egp": 150}]}$j$,
   825, 0, 30, 855),
  ('SG-1042', '123456789012345', 'placed', now() - interval '3 days', 'gleem',
   '{"full_name": "منى", "phone": "01022222222", "address_area": "جليم", "address_street": "أبو قير", "address_building": "5"}',
   'delivery', 'إنستاباي', 'أبو قير، عمارة 5', null,
   '{"items": [{"menu_id": "M002", "item_name": "شوربة سي فود", "quantity": 2, "unit_price_egp": 150, "line_total_egp": 300}]}',
   300, 0, 25, 325),
  ('SG-1043', '201011111111', 'cancelled', now() - interval '60 days', 'gleem',
   '{"full_name": "عمر حسن"}', 'delivery', 'cash', null, null, '{"items": []}', 0, 0, 0, 0),
  (null, '201011111111', 'draft', null, 'el_max', '{}', null, null, null, null, '{"items": []}', 0, 0, 0, 0);

create table legacy_sg.messages (
  id serial primary key, evolution_message_id text, whatsapp_number text, direction text, message_text text,
  raw_payload jsonb, created_at timestamptz);
insert into legacy_sg.messages (evolution_message_id, whatsapp_number, direction, message_text, raw_payload, created_at) values
  ('E1', '201011111111', 'inbound', 'عايز بوري', '{"key": {"remoteJid": "201011111111@s.whatsapp.net"}}', now() - interval '3 days'),
  (null, '201011111111', 'outbound', 'أهلاً يا عمر', null, now() - interval '3 days' + interval '1 minute'),
  ('E2', '123456789012345', 'inbound', 'زي المرة اللي فاتت', '{"key": {"remoteJid": "123456789012345@lid"}}', now() - interval '2 days'),
  ('E0', '201011111111', 'inbound', 'رسالة قديمة', null, now() - interval '400 days');

create table legacy_sg.menu_media (id serial primary key, branch_id text, url text, mime text, position int);
insert into legacy_sg.menu_media (branch_id, url, mime, position) values
  ('el_max', 'https://cdn.example.com/sg/menu-1.jpg', 'image/jpeg', 1),
  (null, 'https://cdn.example.com/sg/menu.pdf', 'application/pdf', 1),
  (null, 'local/only/path.jpg', null, 2);
