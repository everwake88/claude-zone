-- Everwake Orders · full database setup for Supabase (migrations 001–013 + 090, in order)
-- Paste into Supabase → SQL Editor → New query, then Run. Run it once.

-- ================= 001_schema.sql =================
-- =====================================================================
-- Everwake Orders · 001 · schema
--
-- One engine, every restaurant. Every table carries tenant_id; nothing
-- is copied per brand. A restaurant is a row in `tenants`, and the
-- dashboard, the agent and the reports all read the same tables.
--
-- Naming follows the Seagull engine (conversation_state → conversations,
-- inbound_buffer, conversation_locks, menu_snapshot, agent_events…) so
-- the n8n workflows read the same way they always did.
-- =====================================================================

create schema if not exists everwake;

-- ---------------------------------------------------------------------
-- Restaurants
-- ---------------------------------------------------------------------
create table everwake.tenants (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z][a-z0-9_]{1,40}$'),
  name_ar            text not null default '',
  name_en            text not null default '',
  status             text not null default 'onboarding'
                     check (status in ('onboarding', 'live', 'suspended', 'cancelled')),
  plan               text not null default 'pilot',
  country            text not null default 'EG',
  timezone           text not null default 'Africa/Cairo',
  currency           text not null default 'EGP',
  currency_symbol_ar text not null default 'ج',
  default_language   text not null default 'ar' check (default_language in ('ar', 'en')),
  order_no_prefix    text not null default 'EW' check (order_no_prefix ~ '^[A-Z0-9]{1,6}$'),
  order_seq          bigint not null default 1000,
  item_seq           int not null default 0,
  -- the dashboard's ON / OFF switch for the agent
  agent_enabled      boolean not null default true,
  current_pause_id   bigint,
  -- what the agent knows about the restaurant (Settings → Agent)
  profile            jsonb not null default '{}'::jsonb,
  -- how the restaurant operates (payment, required details, templates…)
  settings           jsonb not null default '{}'::jsonb,
  -- bumped by any change the agent must see; the snapshot rebuilds from it
  menu_rev           bigint not null default 1,
  menu_rev_txid      bigint,
  live_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table everwake.tenants is 'One row per restaurant brand (a chain with many branches is one tenant).';
comment on column everwake.tenants.profile is 'Agent knowledge: agent_name{ar,en}, about_ar, about_en, cuisine, tone, brand_facts[], contacts{}, website, instagram, facebook, tiktok, google_maps_url.';
comment on column everwake.tenants.settings is 'Operations: payment_methods[], required_fields{delivery,pickup}, templates{}, human_auto_release_minutes, test_numbers[], ops_whatsapp, aggregator_commission_percent… merged over everwake.default_settings().';

create table everwake.platform_admins (
  user_id    uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);
comment on table everwake.platform_admins is 'Everwake staff: can open every restaurant in the dashboard.';

create table everwake.tenant_members (
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  user_id      uuid not null,
  role         text not null default 'staff' check (role in ('owner', 'manager', 'staff')),
  branch_ids   uuid[],                 -- null = every branch
  display_name text,
  email        text,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on everwake.tenant_members (user_id);

create table everwake.tenant_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references everwake.tenants(id) on delete cascade,
  email       text not null check (email = lower(email)),
  role        text not null default 'staff' check (role in ('owner', 'manager', 'staff')),
  branch_ids  uuid[],
  invited_by  uuid,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid,
  unique (tenant_id, email)
);

-- ---------------------------------------------------------------------
-- Branches, delivery zones, WhatsApp numbers
-- ---------------------------------------------------------------------
create table everwake.branches (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references everwake.tenants(id) on delete cascade,
  code             text not null check (code ~ '^[a-z0-9_]{2,30}$'),
  name_ar          text not null,
  name_en          text,
  aliases          text[] not null default '{}',
  area_ar          text,
  address_ar       text,
  address_en       text,
  lat              double precision,
  lng              double precision,
  maps_url         text,
  phone            text,
  ops_whatsapp     text,              -- where new-order tickets go
  -- {"sat":[{"open":"12:00","close":"01:00"}], …, "default":[…]} — split shifts allowed
  hours            jsonb not null default '{}'::jsonb,
  hours_text_ar    text,
  accepting_orders boolean not null default true,
  busy_until       timestamptz,       -- temporary stop ("no orders for 30 minutes")
  busy_reason      text,
  delivery_enabled boolean not null default true,
  pickup_enabled   boolean not null default true,
  delivery_fee     numeric(10, 2),    -- used when no zone matched; null = branch confirms
  min_order        numeric(10, 2),
  max_delivery_km  numeric(6, 2),
  vat_percent      numeric(5, 2),     -- null = prices exclude fees the branch adds
  price_note_ar    text,
  prep_minutes     int,
  delivery_eta_text text,
  serves_hint_ar   text,              -- areas it usually serves, for typed addresses
  seasonal         boolean not null default false,
  is_active        boolean not null default true,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, code)
);
create index branches_tenant_idx on everwake.branches (tenant_id);

create table everwake.delivery_zones (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  branch_id    uuid not null references everwake.branches(id) on delete cascade,
  name_ar      text not null,
  name_en      text,
  kind         text not null default 'polygon' check (kind in ('polygon', 'radius')),
  polygon      jsonb,                 -- [[lat,lng], [lat,lng], …] one closed ring
  center_lat   double precision,
  center_lng   double precision,
  radius_km    numeric(6, 2),
  areas        text[] not null default '{}',   -- neighbourhood names it covers
  delivery_fee numeric(10, 2),
  min_order    numeric(10, 2),
  eta_min      int,
  eta_max      int,
  priority     int not null default 100,       -- lower wins when zones overlap
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((kind = 'polygon' and jsonb_typeof(polygon) = 'array' and jsonb_array_length(polygon) >= 3)
      or (kind = 'radius' and center_lat is not null and center_lng is not null and radius_km > 0))
);
create index delivery_zones_tenant_idx on everwake.delivery_zones (tenant_id, is_active);

create table everwake.whatsapp_channels (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references everwake.tenants(id) on delete cascade,
  provider          text not null default 'evolution' check (provider in ('evolution', 'cloud_api')),
  label             text,
  phone_number      text,
  instance_name     text,             -- Evolution instance
  base_url          text,             -- Evolution server, e.g. https://evo.example.com
  api_key           text,             -- secret: never readable from the dashboard
  cloud_phone_number_id text,         -- WhatsApp Cloud API (when moved to the official API)
  cloud_access_token    text,         -- secret
  webhook_token     text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  default_branch_id uuid references everwake.branches(id) on delete set null,
  status            text not null default 'pending' check (status in ('pending', 'connected', 'disconnected')),
  is_active         boolean not null default true,
  last_inbound_at   timestamptz,
  connected_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index whatsapp_channels_instance_uidx on everwake.whatsapp_channels (instance_name)
  where provider = 'evolution' and instance_name is not null;
create unique index whatsapp_channels_cloud_uidx on everwake.whatsapp_channels (cloud_phone_number_id)
  where provider = 'cloud_api' and cloud_phone_number_id is not null;

-- ---------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------
create table everwake.menu_categories (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references everwake.tenants(id) on delete cascade,
  name_ar        text not null,
  name_en        text,
  description_ar text,
  available_from time,                -- e.g. a breakfast menu 08:00–12:00
  available_to   time,
  is_active      boolean not null default true,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index menu_categories_tenant_idx on everwake.menu_categories (tenant_id);

create table everwake.menu_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references everwake.tenants(id) on delete cascade,
  code             text not null check (code ~ '^M[0-9]{3,5}$'),   -- what the agent uses: M001, M002…
  category_id      uuid references everwake.menu_categories(id) on delete set null,
  name_ar          text not null,
  name_en          text,
  aliases          text[] not null default '{}',
  description_ar   text,
  description_en   text,
  unit             text not null default 'portion' check (unit in ('portion', 'piece', 'kg', 'person')),
  price            numeric(10, 2),    -- null = the branch confirms the price
  qty_step         numeric(6, 3),     -- kg dishes: 0.25 …
  min_qty          numeric(6, 3),
  tags             text[] not null default '{}',
  is_signature     boolean not null default false,
  is_featured      boolean not null default false,
  orderable        boolean not null default true,   -- false = dine-in only
  is_available     boolean not null default true,   -- the out-of-stock switch
  sold_out_until   timestamptz,                     -- out of stock until a time, then back by itself
  is_active        boolean not null default true,   -- false = archived, hidden from the agent
  prep_note        text,
  calories         int,
  spicy_level      smallint,
  sort             int not null default 0,
  source_import_id uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, code)
);
create index menu_items_tenant_idx on everwake.menu_items (tenant_id, category_id);

-- "levels" in the Seagull engine: asked one at a time, in level order
create table everwake.menu_option_groups (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  item_id    uuid not null references everwake.menu_items(id) on delete cascade,
  level      int not null check (level between 1 and 20),
  label_ar   text not null,
  label_en   text,
  required   boolean not null default false,
  min_select int not null default 0,
  max_select int,                     -- null = any number
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, level)
);

create table everwake.menu_options (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  group_id     uuid not null references everwake.menu_option_groups(id) on delete cascade,
  name_ar      text not null,
  name_en      text,
  aliases      text[] not null default '{}',
  price_delta  numeric(10, 2) not null default 0,
  extra_charge boolean not null default false,  -- the branch adds a charge it has not published
  is_available boolean not null default true,
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index menu_options_group_idx on everwake.menu_options (group_id);

-- per-branch menu: an item is on every branch unless a row here says otherwise
create table everwake.menu_item_branches (
  tenant_id      uuid not null references everwake.tenants(id) on delete cascade,
  item_id        uuid not null references everwake.menu_items(id) on delete cascade,
  branch_id      uuid not null references everwake.branches(id) on delete cascade,
  is_listed      boolean not null default true,
  price          numeric(10, 2),      -- null = the item's own price
  is_available   boolean not null default true,
  sold_out_until timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (item_id, branch_id)
);

-- a photo per dish, sent when a customer wants to see it
create table everwake.item_media (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  item_id      uuid not null references everwake.menu_items(id) on delete cascade,
  url          text not null,
  storage_path text,
  mime         text not null default 'image/jpeg',
  is_primary   boolean not null default true,
  sort         int not null default 0,
  created_at   timestamptz not null default now()
);
create index item_media_item_idx on everwake.item_media (item_id);

-- the full menu (pictures or a PDF), sent when a customer asks for the menu
create table everwake.menu_media (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  branch_id    uuid references everwake.branches(id) on delete cascade,   -- null = every branch
  kind         text not null default 'image' check (kind in ('image', 'pdf')),
  url          text not null,
  storage_path text,
  mime         text not null default 'image/jpeg',
  file_name    text,
  caption      text,
  position     int not null default 1,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index menu_media_tenant_idx on everwake.menu_media (tenant_id, branch_id);

create table everwake.menu_imports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  source_kind  text not null check (source_kind in ('pdf', 'image', 'url', 'text', 'csv')),
  source_url   text,
  files        jsonb not null default '[]'::jsonb,   -- [{path, mime, name}]
  raw_text     text,
  status       text not null default 'uploaded'
               check (status in ('uploaded', 'extracting', 'review', 'published', 'failed')),
  extracted    jsonb,
  error        text,
  model        text,
  usage        jsonb,
  created_by   uuid,
  published_by uuid,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index menu_imports_tenant_idx on everwake.menu_imports (tenant_id, created_at desc);

-- ---------------------------------------------------------------------
-- Offers and what the agent should know
-- ---------------------------------------------------------------------
create table everwake.offers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references everwake.tenants(id) on delete cascade,
  title_ar         text not null,
  title_en         text,
  description_ar   text,
  description_en   text,
  kind             text not null check (kind in ('percent_off', 'amount_off', 'fixed_price', 'free_delivery', 'free_item')),
  scope            text not null default 'order' check (scope in ('order', 'items', 'categories')),
  value            numeric(10, 2) not null default 0,
  max_discount     numeric(10, 2),
  min_subtotal     numeric(10, 2),
  item_ids         uuid[] not null default '{}',
  category_ids     uuid[] not null default '{}',
  branch_ids       uuid[] not null default '{}',     -- empty = every branch
  free_item_id     uuid references everwake.menu_items(id) on delete set null,
  free_item_qty    numeric(6, 2) not null default 1,
  promo_code       text,                              -- null = applies by itself
  first_order_only boolean not null default false,
  stackable        boolean not null default false,
  priority         int not null default 100,
  starts_at        timestamptz,
  ends_at          timestamptz,
  days_of_week     int[] not null default '{}',       -- 0 = Sunday … 6 = Saturday; empty = every day
  time_from        time,
  time_to          time,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index offers_tenant_idx on everwake.offers (tenant_id, is_active);

create table everwake.knowledge_entries (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  topic      text not null,
  content_ar text,
  content_en text,
  is_active  boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_entries_tenant_idx on everwake.knowledge_entries (tenant_id);

-- ---------------------------------------------------------------------
-- Customers
-- WhatsApp may hide a number behind a private id ("…@lid"). A customer
-- is found by ANY of their identities, so the last order is remembered
-- whether they come back by number or by lid.
-- ---------------------------------------------------------------------
create table everwake.customers (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references everwake.tenants(id) on delete cascade,
  wa_id             text not null,     -- the conversation key: real number, else the lid digits
  reply_to          text,              -- where WhatsApp replies go (number, or the full "…@lid")
  phone             text,
  lid               text,
  phone_hidden      boolean not null default false,
  display_name      text,              -- WhatsApp profile name
  full_name         text,
  alt_phone         text,
  language          text,
  food_prefs        text,
  staff_notes       text,
  tags              text[] not null default '{}',
  is_blocked        boolean not null default false,
  marketing_opt_out boolean not null default false,
  orders_count      int not null default 0,
  total_spent       numeric(12, 2) not null default 0,
  last_order_id     bigint,
  last_order_at     timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, wa_id)
);
create index customers_phone_idx on everwake.customers (tenant_id, phone) where phone is not null;

create table everwake.customer_identities (
  tenant_id   uuid not null references everwake.tenants(id) on delete cascade,
  kind        text not null check (kind in ('phone', 'lid')),
  value       text not null,
  customer_id bigint not null references everwake.customers(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, kind, value)
);
create index customer_identities_customer_idx on everwake.customer_identities (customer_id);

create table everwake.customer_addresses (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  customer_id  bigint not null references everwake.customers(id) on delete cascade,
  fingerprint  text not null,
  label        text,
  governorate  text,
  city         text,
  area         text,
  street       text,
  building     text,
  floor        text,
  apartment    text,
  landmark     text,
  notes        text,
  lat          double precision,
  lng          double precision,
  maps_url     text,
  zone_id      uuid references everwake.delivery_zones(id) on delete set null,
  branch_id    uuid references everwake.branches(id) on delete set null,
  address_text text,
  use_count    int not null default 1,
  last_used_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (customer_id, fingerprint)
);

-- ---------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------
create table everwake.conversations (
  id                     bigint generated always as identity primary key,
  tenant_id              uuid not null references everwake.tenants(id) on delete cascade,
  customer_id            bigint references everwake.customers(id) on delete set null,
  wa_id                  text not null,
  -- the engine's working memory (contact, details, branch, zone, pin, ledger, notes)
  state                  jsonb not null default '{}'::jsonb,
  mode                   text not null default 'agent' check (mode in ('agent', 'human')),
  assigned_user_id       uuid,
  human_since            timestamptz,
  human_last_activity_at timestamptz,
  human_reason           text,
  needs_attention        boolean not null default false,
  attention_reason       text,
  attention_at           timestamptz,
  unread_count           int not null default 0,
  last_message_at        timestamptz,
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,
  last_message_preview   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (tenant_id, wa_id)
);
create index conversations_inbox_idx on everwake.conversations (tenant_id, last_message_at desc);

create table everwake.messages (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references everwake.tenants(id) on delete cascade,
  conversation_id bigint references everwake.conversations(id) on delete cascade,
  wa_id           text not null,
  direction       text not null check (direction in ('inbound', 'outbound')),
  sender          text not null check (sender in ('customer', 'agent', 'staff', 'system')),
  staff_user_id   uuid,
  kind            text not null default 'text',
  body            text,
  media_url       text,
  media_mime      text,
  external_id     text,
  status          text not null default 'received'
                  check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error           text,
  run_id          text,
  meta            jsonb not null default '{}'::jsonb,
  raw_payload     jsonb,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create unique index messages_external_uidx on everwake.messages (tenant_id, external_id) where external_id is not null;
create index messages_thread_idx on everwake.messages (tenant_id, wa_id, created_at desc);
create index messages_conversation_idx on everwake.messages (conversation_id, created_at desc);

-- everything sent from the dashboard or by the system (not the agent's own
-- replies) goes through here, so nothing is lost while a sender is down
create table everwake.outbox (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references everwake.tenants(id) on delete cascade,
  channel_id  uuid references everwake.whatsapp_channels(id) on delete set null,
  to_jid      text not null,
  wa_id       text,
  message_id  bigint references everwake.messages(id) on delete set null,
  purpose     text not null check (purpose in ('staff_reply', 'order_status', 'pause_notice', 'resume_notice',
                                               'order_ticket', 'broadcast', 'test')),
  kind        text not null default 'text' check (kind in ('text', 'image', 'document')),
  body        text,
  media_url   text,
  media_mime  text,
  file_name   text,
  status      text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts    int not null default 0,
  last_error  text,
  not_before  timestamptz not null default now(),
  claimed_at  timestamptz,
  claimed_by  text,
  sent_at     timestamptz,
  external_id text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index outbox_pending_idx on everwake.outbox (not_before) where status in ('queued', 'sending');
create index outbox_tenant_idx on everwake.outbox (tenant_id, created_at desc);

create table everwake.inbound_buffer (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references everwake.tenants(id) on delete cascade,
  wa_id             text not null,
  message_text      text,
  has_location      boolean not null default false,
  location          jsonb,
  received_at       timestamptz not null default now(),
  claimed_by_run_id text
);
create index inbound_buffer_wa_idx on everwake.inbound_buffer (tenant_id, wa_id, claimed_by_run_id);

create table everwake.conversation_locks (
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  wa_id      text not null,
  run_id     text not null,
  locked_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, wa_id)
);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create table everwake.orders (
  id                  bigint generated always as identity primary key,
  tenant_id           uuid not null references everwake.tenants(id) on delete cascade,
  order_no            text,
  customer_id         bigint references everwake.customers(id) on delete set null,
  conversation_id     bigint references everwake.conversations(id) on delete set null,
  wa_id               text not null,
  branch_id           uuid references everwake.branches(id) on delete set null,
  zone_id             uuid references everwake.delivery_zones(id) on delete set null,
  status              text not null default 'draft'
                      check (status in ('draft', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery',
                                        'delivered', 'picked_up', 'rejected', 'cancelled')),
  source              text not null default 'whatsapp_agent',
  cart                jsonb not null default '{"items": []}'::jsonb,
  currency            text not null default 'EGP',
  subtotal            numeric(12, 2) not null default 0,
  discount_total      numeric(12, 2) not null default 0,
  applied_offers      jsonb not null default '[]'::jsonb,
  vat                 numeric(12, 2),
  delivery_fee        numeric(12, 2),
  total               numeric(12, 2) not null default 0,
  delivery_method     text,
  payment_method      text,
  customer            jsonb,
  address_text        text,
  address             jsonb,
  location            jsonb,
  notes               text,
  eta_text            text,
  reject_reason       text,
  placed_at           timestamptz,
  accepted_at         timestamptz,
  ready_at            timestamptz,
  out_for_delivery_at timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, order_no)
);
create unique index orders_one_draft_uidx on everwake.orders (tenant_id, wa_id) where status = 'draft';
create index orders_board_idx on everwake.orders (tenant_id, status, placed_at desc);
create index orders_customer_idx on everwake.orders (customer_id, placed_at desc);

create table everwake.order_items (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  order_id   bigint not null references everwake.orders(id) on delete cascade,
  line_no    int not null,
  item_id    uuid references everwake.menu_items(id) on delete set null,
  item_code  text,
  name       text not null,
  unit       text,
  quantity   numeric(10, 3) not null,
  unit_price numeric(10, 2),
  line_total numeric(12, 2),
  choices    jsonb not null default '[]'::jsonb,
  notes      text,
  is_gift    boolean not null default false
);
create index order_items_order_idx on everwake.order_items (order_id);
create index order_items_item_idx on everwake.order_items (tenant_id, item_id);

create table everwake.order_events (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  order_id   bigint not null references everwake.orders(id) on delete cascade,
  status     text not null,
  note       text,
  by_user    uuid,
  by_role    text not null default 'staff' check (by_role in ('agent', 'staff', 'system')),
  notified   boolean not null default false,
  created_at timestamptz not null default now()
);
create index order_events_order_idx on everwake.order_events (order_id, created_at);

-- ---------------------------------------------------------------------
-- The agent switch: who wrote while it was off, so they hear when it is back
-- ---------------------------------------------------------------------
create table everwake.agent_pauses (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references everwake.tenants(id) on delete cascade,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  started_by       uuid,
  ended_by         uuid,
  reason           text,
  notify_on_resume boolean not null default true,
  contacts_count   int not null default 0,
  notified_count   int not null default 0
);
alter table everwake.tenants
  add constraint tenants_current_pause_fk foreign key (current_pause_id)
  references everwake.agent_pauses(id) on delete set null;

create table everwake.pause_contacts (
  pause_id           bigint not null references everwake.agent_pauses(id) on delete cascade,
  tenant_id          uuid not null references everwake.tenants(id) on delete cascade,
  wa_id              text not null,
  reply_to           text,
  channel_id         uuid references everwake.whatsapp_channels(id) on delete set null,
  customer_id        bigint references everwake.customers(id) on delete set null,
  first_message_at   timestamptz not null default now(),
  last_message_at    timestamptz not null default now(),
  messages_count     int not null default 1,
  apologized_at      timestamptz,
  resume_notified_at timestamptz,
  primary key (pause_id, wa_id)
);

-- ---------------------------------------------------------------------
-- Telemetry, the agent's menu snapshot, the audit trail
-- ---------------------------------------------------------------------
create table everwake.agent_events (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references everwake.tenants(id) on delete cascade,
  wa_id             text,
  run_id            text,
  stage             text,
  order_stage       text,
  cart_action       text,
  qa_passed         boolean,
  repair_used       boolean,
  llm_calls         int,
  duration_total_ms int,
  duration_llm_ms   int,
  prompt_tokens     int,
  completion_tokens int,
  cached_tokens     int,
  input             jsonb,
  output            jsonb,
  created_at        timestamptz not null default now()
);
create index agent_events_tenant_idx on everwake.agent_events (tenant_id, created_at desc);

-- built by everwake.rebuild_snapshot(): what the agent reads every turn.
-- scope 'all' = the whole restaurant; scope '<branch uuid>' = one branch.
create table everwake.menu_snapshot (
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  scope        text not null,
  digest_text  text not null default '',
  lookup       jsonb not null default '{}'::jsonb,
  version_hash text not null default '',
  source_rev   bigint not null default 0,
  built_at     timestamptz not null default now(),
  valid_until  timestamptz,
  primary key (tenant_id, scope)
);

create table everwake.audit_log (
  id         bigint generated always as identity primary key,
  tenant_id  uuid references everwake.tenants(id) on delete cascade,
  user_id    uuid,
  action     text not null,
  entity     text,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on everwake.audit_log (tenant_id, created_at desc);

-- ================= 002_helpers.sql =================
-- =====================================================================
-- Everwake Orders · 002 · helpers
-- Text matching, geometry, defaults, templates, and the triggers that
-- make every dashboard edit reach the agent on its very next message.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who is calling. Works on Supabase (PostgREST puts the JWT in
-- request.jwt.claims) and anywhere else that sets the same setting.
-- The n8n engine connects as a database role and has no user: null.
-- ---------------------------------------------------------------------
create or replace function everwake.current_user_id()
returns uuid language sql stable as $$
  select nullif(coalesce(
           nullif(current_setting('request.jwt.claim.sub', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Arabic-aware matching key: same rules as normalizeArabic() in the
-- engine, so SQL and JS agree on what "the same name" means.
-- ---------------------------------------------------------------------
create or replace function everwake.norm(t text)
returns text language sql immutable parallel safe as $$
  select btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(t, '')), 'أإآىةٱ٠١٢٣٤٥٦٧٨٩', 'ااايها0123456789'),
             '[ً-ٰٟـ]', '', 'g'),
           '[^a-z0-9ء-ي]+', ' ', 'g'))
$$;

create or replace function everwake.digits(t text)
returns text language sql immutable parallel safe as $$
  select regexp_replace(translate(coalesce(t, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '\D', '', 'g')
$$;

create or replace function everwake.fmt_money(n numeric)
returns text language sql immutable parallel safe as $$
  select case when n is null then null else trim_scale(round(n, 2))::text end
$$;

-- ---------------------------------------------------------------------
-- Geometry (plain SQL, no PostGIS needed)
-- ---------------------------------------------------------------------
create or replace function everwake.haversine_km(lat1 double precision, lng1 double precision,
                                                 lat2 double precision, lng2 double precision)
returns numeric language sql immutable parallel safe as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    round((6371 * 2 * asin(least(1, sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))))::numeric, 2)
  end
$$;

-- polygon = [[lat,lng], …] (or [{"lat":…,"lng":…}, …]); ray casting
create or replace function everwake.point_in_polygon(p_lat double precision, p_lng double precision, p_poly jsonb)
returns boolean language plpgsql immutable parallel safe as $$
declare
  n int; i int; j int;
  yi double precision; xi double precision; yj double precision; xj double precision;
  inside boolean := false;
begin
  if p_lat is null or p_lng is null or p_poly is null or jsonb_typeof(p_poly) <> 'array' then
    return false;
  end if;
  n := jsonb_array_length(p_poly);
  if n < 3 then return false; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    if jsonb_typeof(p_poly -> i) = 'object' then
      yi := (p_poly -> i ->> 'lat')::double precision; xi := (p_poly -> i ->> 'lng')::double precision;
    else
      yi := (p_poly -> i ->> 0)::double precision;     xi := (p_poly -> i ->> 1)::double precision;
    end if;
    if jsonb_typeof(p_poly -> j) = 'object' then
      yj := (p_poly -> j ->> 'lat')::double precision; xj := (p_poly -> j ->> 'lng')::double precision;
    else
      yj := (p_poly -> j ->> 0)::double precision;     xj := (p_poly -> j ->> 1)::double precision;
    end if;
    if ((yi > p_lat) <> (yj > p_lat))
       and (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

-- ---------------------------------------------------------------------
-- Defaults. Stored settings are merged over these, so a new restaurant
-- works on day one and every value can be changed from the dashboard.
-- ---------------------------------------------------------------------
create or replace function everwake.default_settings()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'payment_methods', jsonb_build_array('cash'),
    'required_fields', jsonb_build_object(
      'delivery', jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method', 'address_area', 'address_street',
                                    'address_building', 'address_floor', 'address_apartment', 'payment_method'),
      'pickup',   jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method'),
      'unknown',  jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method')),
    'max_delivery_km', 15,
    'require_zone_for_delivery', true,
    'accept_orders_when_closed', false,
    'human_auto_release_minutes', 30,
    'phone_reply_takes_over', true,
    'auto_takeover_on_handoff', false,
    'send_order_ticket', true,
    'ops_whatsapp', '',
    'test_numbers', jsonb_build_array(),
    'aggregator_commission_percent', 25,
    'allowed_links', jsonb_build_array(),
    'templates', jsonb_build_object(
      'pause_apology_ar', 'أهلاً {name} 🙏 معلش جداً، خط الطلبات على الواتساب واقف مؤقتاً بسبب ضغط الطلبات. أول ما نرجع هنبعتلك رسالة هنا على طول علشان تطلب براحتك. متشكرين لصبرك.',
      'pause_apology_en', 'Hi {name}, we are really sorry 🙏 Our WhatsApp ordering line is paused for a little while because we are very busy. We will message you right here as soon as we are back so you can order. Thank you for your patience.',
      'resume_notice_ar', 'أهلاً {name} 👋 رجعنا نستقبل الطلبات على الواتساب! متشكرين جداً إنك استنيتنا، ابعتلنا طلبك وإحنا معاك.',
      'resume_notice_en', 'Hi {name} 👋 We are back and taking orders on WhatsApp again! Thank you so much for waiting, just send us what you would like.',
      'status_accepted_ar', 'تمام 👨‍🍳 طلبك رقم {order_no} اتأكد من فرع {branch} وبيتجهز دلوقتي.{eta}',
      'status_accepted_en', 'Great 👨‍🍳 Your order {order_no} is confirmed by our {branch} branch and is being prepared now.{eta}',
      'status_ready_ar', 'طلبك رقم {order_no} جاهز للاستلام من فرع {branch} ✅',
      'status_ready_en', 'Your order {order_no} is ready for pickup at our {branch} branch ✅',
      'status_out_for_delivery_ar', 'طلبك رقم {order_no} خرج مع الطيار وفي الطريق ليك 🛵',
      'status_out_for_delivery_en', 'Your order {order_no} is out for delivery and on its way to you 🛵',
      'status_delivered_ar', 'بالهنا والشفا! لو احتجت أي حاجة إحنا هنا.',
      'status_delivered_en', 'Enjoy your meal! If you need anything, we are right here.',
      'status_rejected_ar', 'معلش جداً، مقدرناش ننفذ طلبك رقم {order_no}.{reason} لو تحب نساعدك في طلب تاني إحنا موجودين.',
      'status_rejected_en', 'We are really sorry, we could not fulfil your order {order_no}.{reason} If you would like help with another order, we are here.',
      'status_cancelled_ar', 'طلبك رقم {order_no} اتلغى.{reason} لو حابب تطلب تاني إحنا موجودين.',
      'status_cancelled_en', 'Your order {order_no} has been cancelled.{reason} If you would like to order again, we are here.'))
$$;

create or replace function everwake.default_profile()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'agent_name', jsonb_build_object('ar', 'ياسمين', 'en', 'Yasmin'),
    'about_ar', '', 'about_en', '', 'cuisine', '', 'tone', '',
    'brand_facts', jsonb_build_array(),
    'contacts', jsonb_build_object('hotline', '', 'complaints', '', 'whatsapp', '', 'email', ''),
    'website', '', 'instagram', '', 'facebook', '', 'tiktok', '', 'google_maps_url', '')
$$;

create or replace function everwake.merged_settings(p_settings jsonb)
returns jsonb language sql immutable as $$
  select everwake.default_settings()
         || coalesce(p_settings, '{}'::jsonb)
         || jsonb_build_object(
              'templates', (everwake.default_settings() -> 'templates') || coalesce(p_settings -> 'templates', '{}'::jsonb),
              'required_fields', (everwake.default_settings() -> 'required_fields') || coalesce(p_settings -> 'required_fields', '{}'::jsonb))
$$;

create or replace function everwake.merged_profile(p_profile jsonb)
returns jsonb language sql immutable as $$
  select everwake.default_profile()
         || coalesce(p_profile, '{}'::jsonb)
         || jsonb_build_object(
              'agent_name', (everwake.default_profile() -> 'agent_name') || coalesce(p_profile -> 'agent_name', '{}'::jsonb),
              'contacts', (everwake.default_profile() -> 'contacts') || coalesce(p_profile -> 'contacts', '{}'::jsonb))
$$;

-- {name} style placeholders; an empty value leaves no stray space behind
create or replace function everwake.render_template(tpl text, vars jsonb)
returns text language plpgsql immutable as $$
declare
  k text; v text; out text := coalesce(tpl, '');
begin
  for k, v in select key, value from jsonb_each_text(coalesce(vars, '{}'::jsonb)) loop
    out := replace(out, '{' || k || '}', coalesce(v, ''));
  end loop;
  out := regexp_replace(out, '\{[a-z_]+\}', '', 'g');
  out := regexp_replace(out, '[ \t]+([،,.!؟?])', '\1', 'g');
  out := regexp_replace(out, '[ \t]{2,}', ' ', 'g');
  return btrim(out);
end $$;

-- the customer's first name for a template: their given name, never a long WhatsApp nickname
create or replace function everwake.first_name(full_name text, display_name text)
returns text language sql immutable as $$
  select coalesce(
    nullif(split_part(btrim(coalesce(full_name, '')), ' ', 1), ''),
    case when length(btrim(coalesce(display_name, ''))) between 2 and 20
              and btrim(display_name) ~ '^[ء-يA-Za-z ]+$'
         then split_part(btrim(display_name), ' ', 1) end,
    '')
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace function everwake.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Anything the agent reads changed → the restaurant's menu revision goes
-- up once per transaction; the next turn rebuilds the snapshot.
create or replace function everwake.bump_menu_rev()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  t uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
begin
  update everwake.tenants
     set menu_rev = menu_rev + 1, menu_rev_txid = txid_current()
   where id = t and menu_rev_txid is distinct from txid_current();
  return null;
end $$;

create or replace function everwake.tenants_before_update()
returns trigger language plpgsql as $$
begin
  if (new.profile, new.settings, new.name_ar, new.name_en, new.timezone, new.currency, new.currency_symbol_ar,
      new.default_language, new.order_no_prefix, new.status)
     is distinct from
     (old.profile, old.settings, old.name_ar, old.name_en, old.timezone, old.currency, old.currency_symbol_ar,
      old.default_language, old.order_no_prefix, old.status)
     and new.menu_rev = old.menu_rev then
    new.menu_rev := old.menu_rev + 1;
    new.menu_rev_txid := txid_current();
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function everwake.assign_item_code()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
declare s int;
begin
  if new.code is null or btrim(new.code) = '' then
    loop
      update everwake.tenants set item_seq = item_seq + 1 where id = new.tenant_id returning item_seq into s;
      new.code := 'M' || lpad(s::text, 3, '0');
      exit when not exists (select 1 from everwake.menu_items where tenant_id = new.tenant_id and code = new.code);
    end loop;
  end if;
  new.code := upper(btrim(new.code));
  return new;
end $$;

-- who changed what, from the dashboard (the engine has no user and is not audited here)
create or replace function everwake.audit_change()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  uid uuid := everwake.current_user_id();
  diff jsonb;
  rid text;
  tid uuid;
begin
  if uid is null then return null; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(to_jsonb(old) -> n.key, n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
     where n.key not in ('updated_at', 'menu_rev', 'menu_rev_txid', 'item_seq', 'order_seq',
                         'api_key', 'cloud_access_token', 'webhook_token')
       and (to_jsonb(old) -> n.key) is distinct from n.value;
    if diff is null then return null; end if;
  elsif tg_op = 'INSERT' then
    diff := to_jsonb(new) - 'api_key' - 'cloud_access_token' - 'webhook_token';
  else
    diff := to_jsonb(old) - 'api_key' - 'cloud_access_token' - 'webhook_token';
  end if;
  rid := coalesce(to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'id',
                  to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'item_id');
  tid := case when tg_table_name = 'tenants' then (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'id')::uuid
              else (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'tenant_id')::uuid end;
  insert into everwake.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (tid, uid, lower(tg_op), tg_table_name, rid, diff);
  return null;
end $$;

-- wire them up -----------------------------------------------------------
create trigger tenants_before_update before update on everwake.tenants
  for each row execute function everwake.tenants_before_update();

create trigger menu_items_assign_code before insert on everwake.menu_items
  for each row execute function everwake.assign_item_code();

do $$
declare t text;
begin
  -- updated_at
  foreach t in array array['branches', 'delivery_zones', 'whatsapp_channels', 'menu_categories', 'menu_items',
                           'menu_option_groups', 'menu_options', 'menu_item_branches', 'menu_imports', 'offers',
                           'knowledge_entries', 'customers', 'conversations', 'orders'] loop
    execute format('create trigger %I before update on everwake.%I for each row execute function everwake.touch_updated_at()',
                   t || '_touch', t);
  end loop;
  -- what the agent reads
  foreach t in array array['branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_option_groups',
                           'menu_options', 'menu_item_branches', 'item_media', 'menu_media', 'offers',
                           'knowledge_entries'] loop
    execute format('create trigger %I after insert or update or delete on everwake.%I for each row execute function everwake.bump_menu_rev()',
                   t || '_menu_rev', t);
  end loop;
  -- the audit trail of dashboard edits
  foreach t in array array['tenants', 'branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_options',
                           'menu_item_branches', 'offers', 'knowledge_entries', 'whatsapp_channels', 'tenant_members'] loop
    execute format('create trigger %I after insert or update or delete on everwake.%I for each row execute function everwake.audit_change()',
                   t || '_audit', t);
  end loop;
end $$;

-- ================= 003_snapshot.sql =================
-- =====================================================================
-- Everwake Orders · 003 · the menu snapshot
--
-- The agent never reads the menu tables directly. Every turn it reads
-- one prepared snapshot per restaurant ('all') and one per branch:
--   digest_text — the MENU the model reads (codes, prices, choices)
--   lookup      — the same facts as JSON for the code that prices carts
-- A branch's snapshot is that branch's own menu: its dishes and
-- categories, its prices, its choice prices and choices (012).
--
-- Any dashboard edit bumps tenants.menu_rev (002). ensure_snapshot()
-- rebuilds when the stored snapshot is older than that revision, or
-- when an "out of stock until …" time has passed. So: save in the
-- dashboard → the very next customer message sees it.
-- =====================================================================

create or replace function everwake.snapshot_is_fresh(p_tenant uuid)
returns boolean language sql stable as $$
  select exists (
    select 1
      from everwake.menu_snapshot s
      join everwake.tenants t on t.id = s.tenant_id
     where s.tenant_id = p_tenant and s.scope = 'all'
       and s.source_rev >= t.menu_rev
       and (s.valid_until is null or s.valid_until > now()))
$$;

-- one dish's choices as the engine reads them, at one branch (its own
-- choice prices, without the choices it doesn't have — 012; a question
-- with no option left there is not asked there)
create or replace function everwake.item_choices_json(p_item uuid, p_branch uuid default null)
returns jsonb language plpgsql stable as $$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'level', g.level, 'label_ar', g.label_ar, 'label_en', g.label_en,
             'required', g.required, 'min', g.min_select, 'max', g.max_select,
             'options', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'name', o.name_ar, 'name_en', o.name_en, 'aliases', to_jsonb(o.aliases),
                        'price', coalesce(x.price_delta, o.price_delta), 'extra_charge', o.extra_charge)
                      order by o.sort, o.name_ar)
                 from everwake.menu_options o
                 left join everwake.menu_option_branches x on x.option_id = o.id and x.branch_id = p_branch
                where o.group_id = g.id and o.is_available and coalesce(x.is_available, true)), '[]'::jsonb))
           order by g.level), '[]'::jsonb)
      from everwake.menu_option_groups g
     where g.item_id = p_item
       and exists (select 1 from everwake.menu_options o
                     left join everwake.menu_option_branches x on x.option_id = o.id and x.branch_id = p_branch
                    where o.group_id = g.id and o.is_available and coalesce(x.is_available, true)));
end $$;

-- one dish's choices as the model reads them (one line), at one branch
create or replace function everwake.item_choices_text(p_item uuid, p_sym text, p_branch uuid default null)
returns text language plpgsql stable as $$
begin
  return (
    select string_agg(
             g.label_ar
             || ' (' || case when g.required then 'مطلوب' else 'اختياري' end
             || case when coalesce(g.max_select, 99) > 1 and g.max_select is not null then '، لحد ' || g.max_select
                     when g.max_select is null and not g.required then '، أكتر من اختيار'
                     else '' end
             || '): '
             || coalesce((
                  select string_agg(o.name_ar
                                    || case when p.price > 0 then ' +' || everwake.fmt_money(p.price) || p_sym
                                            when p.price < 0 then ' ' || everwake.fmt_money(p.price) || p_sym
                                            else '' end
                                    || case when o.extra_charge then ' (+رسوم تسوية يحددها الفرع)' else '' end,
                                    ' / ' order by o.sort, o.name_ar)
                    from everwake.menu_options o
                    left join everwake.menu_option_branches x on x.option_id = o.id and x.branch_id = p_branch
                    cross join lateral (select coalesce(x.price_delta, o.price_delta) as price) p
                   where o.group_id = g.id and o.is_available and coalesce(x.is_available, true)), '—'),
             ' · ' order by g.level)
      from everwake.menu_option_groups g
     where g.item_id = p_item
       and exists (select 1 from everwake.menu_options o
                     left join everwake.menu_option_branches x on x.option_id = o.id and x.branch_id = p_branch
                    where o.group_id = g.id and o.is_available and coalesce(x.is_available, true)));
end $$;

create or replace function everwake.rebuild_snapshot(p_tenant uuid, p_force boolean default true)
returns void language plpgsql as $$
declare
  t           everwake.tenants%rowtype;
  v_rev       bigint;
  v_sym       text;
  v_branches  jsonb;
  v_zones     jsonb;
  v_all_items jsonb;
  v_offers    jsonb;
  v_knowledge jsonb;
  v_media     jsonb;
  v_all       jsonb;
  v_digest    text;
  v_valid     timestamptz;
  v_bvalid    timestamptz;
  b           record;
  v_items     jsonb;
  v_choices   jsonb;
  v_bdigest   text;
  v_blookup   jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('everwake.snapshot:' || p_tenant::text, 0));
  if not p_force and everwake.snapshot_is_fresh(p_tenant) then
    return;
  end if;
  select * into t from everwake.tenants where id = p_tenant;
  if not found then return; end if;
  v_rev := t.menu_rev;
  v_sym := case when t.default_language = 'en' and t.currency_symbol_ar = 'ج' then ' ' || t.currency
                else t.currency_symbol_ar end;

  -- the effective menu of every active branch -------------------------
  create temp table if not exists _ew_eff (
    branch_id uuid, branch_code text, item_id uuid, code text, cat_id uuid, cat_name text, cat_sort int,
    cat_from time, cat_to time, name_ar text, name_en text, aliases text[], description_ar text,
    unit text, price numeric, qty_step numeric, min_qty numeric, tags text[], is_signature boolean,
    is_featured boolean, orderable boolean, available boolean, sold_out_until timestamptz,
    item_sort int, has_photo boolean
  ) on commit drop;
  truncate _ew_eff;

  insert into _ew_eff
  select br.id, br.code, i.id, i.code, c.id, coalesce(c.name_ar, 'أصناف أخرى'), coalesce(c.sort, 9999),
         c.available_from, c.available_to, i.name_ar, i.name_en, i.aliases, i.description_ar,
         i.unit, coalesce(mib.price, i.price), i.qty_step, i.min_qty, i.tags, i.is_signature,
         i.is_featured, i.orderable,
         i.is_available and coalesce(mib.is_available, true),
         greatest(case when i.sold_out_until > now() then i.sold_out_until end,
                  case when mib.sold_out_until > now() then mib.sold_out_until end),
         i.sort,
         exists (select 1 from everwake.item_media m where m.item_id = i.id)
    from everwake.branches br
    join everwake.menu_items i on i.tenant_id = br.tenant_id and i.is_active
    left join everwake.menu_categories c on c.id = i.category_id
    left join everwake.menu_item_branches mib on mib.item_id = i.id and mib.branch_id = br.id
   where br.tenant_id = p_tenant and br.is_active
     and coalesce(c.is_active, true)
     and (c.branch_ids is null or br.id = any(c.branch_ids))      -- a category only some branches serve
     and coalesce(mib.is_listed, true)
     and (i.orderable or br.dine_in is not false);               -- dine-in only: not where there is no seating

  select min(sold_out_until) into v_valid from _ew_eff where sold_out_until is not null;

  -- branches -------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', br.id, 'code', br.code, 'name_ar', br.name_ar, 'name_en', br.name_en, 'aliases', to_jsonb(br.aliases),
           'area_ar', br.area_ar, 'address_ar', br.address_ar, 'address_en', br.address_en,
           'lat', br.lat, 'lng', br.lng, 'maps_url', br.maps_url, 'phone', br.phone,
           'hours', br.hours, 'hours_text_ar', br.hours_text_ar,
           'accepting_orders', br.accepting_orders, 'busy_until', br.busy_until, 'busy_reason', br.busy_reason,
           'delivery_enabled', br.delivery_enabled, 'pickup_enabled', br.pickup_enabled,
           'delivery_fee', br.delivery_fee, 'min_order', br.min_order, 'max_delivery_km', br.max_delivery_km,
           'vat_percent', br.vat_percent, 'price_note_ar', br.price_note_ar,
           'prep_minutes', br.prep_minutes, 'delivery_eta_text', br.delivery_eta_text,
           'serves_hint_ar', br.serves_hint_ar, 'seasonal', br.seasonal,
           'dine_in', br.dine_in,
           'payment_methods', everwake.payment_methods_at(p_tenant, br.id),
           'own_payment_methods', br.payment_methods is not null,
           'zones', (select count(*) from everwake.delivery_zones z where z.branch_id = br.id and z.is_active))
         order by br.sort, br.name_ar), '[]'::jsonb)
    into v_branches
    from everwake.branches br
   where br.tenant_id = p_tenant and br.is_active;

  -- delivery zones (names and money only; the shapes stay in SQL) -----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', z.id, 'branch_id', z.branch_id, 'branch_code', br.code, 'name_ar', z.name_ar, 'name_en', z.name_en,
           'kind', z.kind, 'areas', to_jsonb(z.areas), 'delivery_fee', z.delivery_fee, 'min_order', z.min_order,
           'eta_min', z.eta_min, 'eta_max', z.eta_max, 'priority', z.priority)
         order by br.sort, z.priority, z.name_ar), '[]'::jsonb)
    into v_zones
    from everwake.delivery_zones z
    join everwake.branches br on br.id = z.branch_id and br.is_active
   where z.tenant_id = p_tenant and z.is_active;

  -- every dish across the restaurant: where it is sold and for how much ----
  select coalesce(jsonb_object_agg(x.code, x.entry), '{}'::jsonb)
    into v_all_items
    from (
      select e.code, jsonb_build_object(
               'id', min(e.item_id::text), 'name', min(e.name_ar), 'name_en', min(e.name_en),
               'aliases', to_jsonb(min(e.aliases)),
               'category', min(e.cat_name), 'unit', min(e.unit),
               'branches', jsonb_agg(distinct e.branch_code),
               'dine_in_only', bool_and(not e.orderable),
               'price_min', min(e.price), 'price_max', max(e.price),
               'signature', bool_or(e.is_signature or e.is_featured),
               'has_photo', bool_or(e.has_photo),
               'tags', to_jsonb(min(e.tags))) as entry
        from _ew_eff e
       group by e.code) x;

  -- offers that could apply now or later (time rules are checked per turn) --
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'title_ar', o.title_ar, 'title_en', o.title_en,
           'description_ar', o.description_ar, 'description_en', o.description_en,
           'kind', o.kind, 'scope', o.scope, 'value', o.value, 'max_discount', o.max_discount,
           'min_subtotal', o.min_subtotal,
           'item_codes', coalesce((select jsonb_agg(i.code) from everwake.menu_items i where i.id = any(o.item_ids)), '[]'::jsonb),
           'category_ids', to_jsonb(o.category_ids),
           'category_names', coalesce((select jsonb_agg(c.name_ar) from everwake.menu_categories c where c.id = any(o.category_ids)), '[]'::jsonb),
           'branch_ids', to_jsonb(o.branch_ids),
           'free_item_code', (select i.code from everwake.menu_items i where i.id = o.free_item_id),
           'free_item_name', (select i.name_ar from everwake.menu_items i where i.id = o.free_item_id),
           'free_item_qty', o.free_item_qty,
           'promo_code', o.promo_code, 'first_order_only', o.first_order_only,
           'stackable', o.stackable, 'priority', o.priority,
           'starts_at', o.starts_at, 'ends_at', o.ends_at, 'days_of_week', to_jsonb(o.days_of_week),
           'time_from', o.time_from, 'time_to', o.time_to)
         order by o.priority, o.created_at), '[]'::jsonb)
    into v_offers
    from everwake.offers o
   where o.tenant_id = p_tenant and o.is_active and (o.ends_at is null or o.ends_at > now());

  select coalesce(jsonb_agg(jsonb_build_object('topic', k.topic, 'content_ar', k.content_ar, 'content_en', k.content_en)
                            order by k.sort, k.topic), '[]'::jsonb)
    into v_knowledge
    from everwake.knowledge_entries k
   where k.tenant_id = p_tenant and k.is_active;

  select jsonb_build_object(
           'menu_pages', coalesce((select jsonb_object_agg(scope, n) from (
                             select coalesce(m.branch_id::text, 'all') as scope, count(*) as n
                               from everwake.menu_media m
                              where m.tenant_id = p_tenant and m.is_active
                              group by 1) s), '{}'::jsonb),
           'items_with_photos', coalesce((select jsonb_agg(distinct i.code)
                                           from everwake.menu_items i
                                           join everwake.item_media m on m.item_id = i.id
                                          where i.tenant_id = p_tenant and i.is_active), '[]'::jsonb))
    into v_media;

  v_all := jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name_ar', t.name_ar, 'name_en', t.name_en,
                                 'status', t.status, 'timezone', t.timezone, 'currency', t.currency,
                                 'currency_symbol', v_sym, 'default_language', t.default_language,
                                 'order_no_prefix', t.order_no_prefix),
    'profile', everwake.merged_profile(t.profile),
    'settings', everwake.merged_settings(t.settings),
    'branches', v_branches,
    'zones', v_zones,
    'items', v_all_items,
    'offers', v_offers,
    'knowledge', v_knowledge,
    'media', v_media);

  -- the all-branches MENU: what exists and where, before a branch is known
  select coalesce(string_agg(cat_block, E'\n\n' order by cat_sort, cat_name), '(المنيو لسه فاضي)')
    into v_digest
    from (
      select e.cat_name, min(e.cat_sort) as cat_sort,
             '### ' || e.cat_name
             || case when min(e.cat_from) is not null and min(e.cat_to) is not null
                     then ' (متاح ' || to_char(min(e.cat_from), 'HH24:MI') || '–' || to_char(min(e.cat_to), 'HH24:MI') || ' بس)'
                     else '' end
             || E'\n'
             || string_agg(line, E'\n' order by item_sort, name_ar) as cat_block
        from (
          select e.cat_name, e.cat_sort, e.cat_from, e.cat_to, e.code, min(e.item_sort) as item_sort, min(e.name_ar) as name_ar,
                 '- ' || e.code || ' ' || min(e.name_ar)
                 || coalesce(' (' || nullif(min(e.name_en), '') || ')', '')
                 || ' — '
                 || case when min(e.price) is null then 'السعر يتأكد من الفرع'
                         when min(e.price) = max(e.price) then everwake.fmt_money(min(e.price)) || v_sym
                         else everwake.fmt_money(min(e.price)) || '–' || everwake.fmt_money(max(e.price)) || v_sym || ' حسب الفرع' end
                 || case when min(e.unit) = 'kg' then ' للكيلو' when min(e.unit) = 'person' then ' للفرد' else '' end
                 || case when bool_or(e.is_signature or e.is_featured) then ' ★' else '' end
                 || case when bool_and(not e.orderable) then ' · في المطعم بس (مش دليفري ولا تيك أواي)' else '' end
                 || case when (select count(*) from jsonb_array_elements(v_branches)) > count(distinct e.branch_id)
                         then ' · متاح في: ' || string_agg(distinct br.name_ar, '، ')
                         else '' end as line
            from _ew_eff e
            join everwake.branches br on br.id = e.branch_id
           group by e.cat_name, e.cat_sort, e.cat_from, e.cat_to, e.code) e
       group by e.cat_name) blocks;

  insert into everwake.menu_snapshot (tenant_id, scope, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
  values (p_tenant, 'all', v_digest, v_all, md5(v_digest || v_all::text), v_rev, now(), v_valid)
  on conflict (tenant_id, scope) do update
    set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
        source_rev = excluded.source_rev, built_at = excluded.built_at, valid_until = excluded.valid_until;

  -- one snapshot per branch ------------------------------------------------
  for b in select br.id, br.code, br.name_ar from everwake.branches br
            where br.tenant_id = p_tenant and br.is_active loop

    select coalesce(jsonb_object_agg(e.code, jsonb_build_object(
             'id', e.item_id, 'name', e.name_ar, 'name_en', e.name_en, 'aliases', to_jsonb(e.aliases),
             'category', e.cat_name, 'category_id', e.cat_id, 'desc', e.description_ar,
             'price', e.price, 'unit', e.unit, 'qty_step', e.qty_step, 'min_qty', e.min_qty,
             'tags', to_jsonb(e.tags), 'signature', e.is_signature, 'featured', e.is_featured,
             'orderable', e.orderable, 'available', e.available, 'sold_out_until', e.sold_out_until,
             'has_photo', e.has_photo,
             'window', case when e.cat_from is not null and e.cat_to is not null
                            then jsonb_build_object('from', to_char(e.cat_from, 'HH24:MI'), 'to', to_char(e.cat_to, 'HH24:MI'))
                       end)), '{}'::jsonb),
           coalesce(jsonb_object_agg(e.code, jsonb_build_object('levels', everwake.item_choices_json(e.item_id, b.id)))
                      filter (where exists (select 1 from everwake.menu_option_groups g where g.item_id = e.item_id)
                                and everwake.item_choices_json(e.item_id, b.id) <> '[]'::jsonb),
                    '{}'::jsonb)
      into v_items, v_choices
      from _ew_eff e
     where e.branch_id = b.id;

    select coalesce(string_agg(cat_block, E'\n\n' order by cat_sort, cat_name), '(المنيو لسه فاضي)')
      into v_bdigest
      from (
        select e.cat_name, min(e.cat_sort) as cat_sort,
               '### ' || e.cat_name
               || case when min(e.cat_from) is not null and min(e.cat_to) is not null
                       then ' (متاح ' || to_char(min(e.cat_from), 'HH24:MI') || '–' || to_char(min(e.cat_to), 'HH24:MI') || ' بس)'
                       else '' end
               || E'\n'
               || string_agg(
                    '- ' || e.code || ' ' || e.name_ar
                    || coalesce(' (' || nullif(e.name_en, '') || ')', '')
                    || ' — '
                    || case when e.price is null then 'السعر يتأكد من الفرع' else everwake.fmt_money(e.price) || v_sym end
                    || case when e.unit = 'kg' then ' للكيلو' when e.unit = 'person' then ' للفرد'
                            when e.unit = 'piece' then ' للقطعة' else '' end
                    || case when e.is_signature or e.is_featured then ' ★' else '' end
                    || case when not e.orderable then ' · في المطعم بس (مش دليفري ولا تيك أواي)' else '' end
                    || case when not e.available then ' · خلصان دلوقتي'
                            when e.sold_out_until is not null then ' · خلصان لحد ' || to_char(e.sold_out_until at time zone t.timezone, 'HH24:MI')
                            else '' end
                    || case when e.has_photo then ' 📷' else '' end
                    || coalesce(E'\n  ' || left(nullif(btrim(e.description_ar), ''), 140), '')
                    || coalesce(E'\n  اختيارات: ' || everwake.item_choices_text(e.item_id, v_sym, b.id), ''),
                    E'\n' order by e.item_sort, e.name_ar) as cat_block
          from _ew_eff e
         where e.branch_id = b.id
         group by e.cat_name) blocks;

    v_blookup := jsonb_build_object(
      'branch', jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar),
      'items', v_items,
      'choices', v_choices);

    select min(sold_out_until) into v_bvalid from _ew_eff where branch_id = b.id and sold_out_until is not null;

    insert into everwake.menu_snapshot (tenant_id, scope, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
    values (p_tenant, b.id::text, v_bdigest, v_blookup, md5(v_bdigest || v_blookup::text), v_rev, now(), v_bvalid)
    on conflict (tenant_id, scope) do update
      set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
          source_rev = excluded.source_rev, built_at = excluded.built_at, valid_until = excluded.valid_until;
  end loop;

  -- branches that were closed or removed
  delete from everwake.menu_snapshot s
   where s.tenant_id = p_tenant and s.scope <> 'all'
     and not exists (select 1 from everwake.branches br
                      where br.tenant_id = p_tenant and br.is_active and br.id::text = s.scope);
  drop table if exists _ew_eff;
end $$;

-- called at the start of every turn: rebuild only when something changed
create or replace function everwake.ensure_snapshot(p_tenant uuid)
returns void language plpgsql as $$
begin
  if not everwake.snapshot_is_fresh(p_tenant) then
    perform everwake.rebuild_snapshot(p_tenant, false);
  end if;
end $$;

-- ================= 004_engine.sql =================
-- =====================================================================
-- Everwake Orders · 004 · what the n8n engine calls
--
-- The Seagull pipeline, unchanged in shape:
--   Normalize → intake() → debounce → claim_window() → [pin → save_pin()]
--   → turn_context() → Brain → Agent (tools: cart_context()/persist_cart()/
--   place_order(), save details) → persist_turn() → send → log_outbound()
--
-- Every function takes the restaurant (tenant) first. All JSON in, JSON
-- out, so each n8n Postgres node is one line: select everwake.x($1::jsonb).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Opening hours
-- hours = {"sun":[{"open":"12:00","close":"02:00"}], …, "default":[…]}
-- A day may also be a single {"open","close"} object, or [] (closed).
-- ---------------------------------------------------------------------
create or replace function everwake.day_windows(p_hours jsonb, p_day int)
returns jsonb language sql immutable as $$
  select case
    when p_hours is null then '[]'::jsonb
    when jsonb_typeof(coalesce(p_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[p_day + 1], p_hours -> 'default')) = 'object'
      then jsonb_build_array(coalesce(p_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[p_day + 1], p_hours -> 'default'))
    else coalesce(p_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[p_day + 1], p_hours -> 'default', '[]'::jsonb)
  end
$$;

-- null = no hours on file
create or replace function everwake.is_open_at(p_hours jsonb, p_local timestamp)
returns boolean language plpgsql immutable as $$
declare
  d int := extract(dow from p_local)::int;
  m int := extract(hour from p_local)::int * 60 + extract(minute from p_local)::int;
  w jsonb; o int; c int;
begin
  if p_hours is null or p_hours = '{}'::jsonb then return null; end if;
  for w in select * from jsonb_array_elements(everwake.day_windows(p_hours, d)) loop
    o := split_part(w ->> 'open', ':', 1)::int * 60 + split_part(w ->> 'open', ':', 2)::int;
    c := split_part(w ->> 'close', ':', 1)::int * 60 + split_part(w ->> 'close', ':', 2)::int;
    if c <= o then c := c + 1440; end if;
    if m >= o and m < c then return true; end if;
  end loop;
  -- a window that started yesterday and runs past midnight
  for w in select * from jsonb_array_elements(everwake.day_windows(p_hours, (d + 6) % 7)) loop
    o := split_part(w ->> 'open', ':', 1)::int * 60 + split_part(w ->> 'open', ':', 2)::int;
    c := split_part(w ->> 'close', ':', 1)::int * 60 + split_part(w ->> 'close', ':', 2)::int;
    if c <= o then c := c + 1440; end if;
    if m + 1440 >= o and m + 1440 < c then return true; end if;
  end loop;
  return false;
exception when others then
  return null;
end $$;

-- open | closed | busy | not_accepting | unknown
create or replace function everwake.branch_state(p_branch uuid)
returns text language sql stable as $$
  select case
    when not b.accepting_orders then 'not_accepting'
    when b.busy_until is not null and b.busy_until > now() then 'busy'
    else case everwake.is_open_at(b.hours, (now() at time zone t.timezone)::timestamp)
           when true then 'open' when false then 'closed' else 'unknown' end
  end
  from everwake.branches b join everwake.tenants t on t.id = b.tenant_id
  where b.id = p_branch
$$;

-- ---------------------------------------------------------------------
-- Delivery zones
-- ---------------------------------------------------------------------
create or replace function everwake.zones_at(p_tenant uuid, p_lat double precision, p_lng double precision)
returns table (zone_id uuid, zone_name text, branch_id uuid, branch_code text, branch_name text,
               delivery_fee numeric, min_order numeric, eta_min int, eta_max int, priority int,
               km numeric, branch_state text)
language sql stable as $$
  select z.id, z.name_ar, b.id, b.code, b.name_ar,
         coalesce(z.delivery_fee, b.delivery_fee), coalesce(z.min_order, b.min_order), z.eta_min, z.eta_max, z.priority,
         everwake.haversine_km(b.lat, b.lng, p_lat, p_lng),
         everwake.branch_state(b.id)
    from everwake.delivery_zones z
    join everwake.branches b on b.id = z.branch_id and b.is_active and b.delivery_enabled
   where z.tenant_id = p_tenant and z.is_active
     and case when z.kind = 'polygon' then everwake.point_in_polygon(p_lat, p_lng, z.polygon)
              else everwake.haversine_km(z.center_lat, z.center_lng, p_lat, p_lng) <= z.radius_km end
   order by case everwake.branch_state(b.id) when 'open' then 0 when 'unknown' then 1 when 'closed' then 2 else 3 end,
            z.priority, everwake.haversine_km(b.lat, b.lng, p_lat, p_lng) nulls last
$$;

-- a typed area ("المعادي", "Zamalek") → the zones that list it
create or replace function everwake.match_area(p_tenant uuid, p_text text)
returns jsonb language sql stable as $$
  with q as (select everwake.norm(p_text) as t),
  hits as (
    select distinct on (z.id) z.id, z.name_ar, z.priority, b.id as branch_id, b.code, b.name_ar as branch_name,
           coalesce(z.delivery_fee, b.delivery_fee) as fee, coalesce(z.min_order, b.min_order) as min_order,
           z.eta_min, z.eta_max, a as matched
      from everwake.delivery_zones z
      join everwake.branches b on b.id = z.branch_id and b.is_active and b.delivery_enabled
      cross join q
      cross join lateral unnest(z.areas || array[z.name_ar, coalesce(z.name_en, '')]) a
     where z.tenant_id = p_tenant and z.is_active
       and length(everwake.norm(a)) >= 3 and length(q.t) >= 3
       and (q.t = everwake.norm(a)
            or q.t like '%' || everwake.norm(a) || '%'
            or everwake.norm(a) like '%' || q.t || '%')
     order by z.id, length(a) desc)
  select jsonb_build_object(
           'text', p_text,
           'matches', coalesce(jsonb_agg(jsonb_build_object(
                         'zone_id', h.id, 'zone_name', h.name_ar, 'branch_id', h.branch_id, 'branch_code', h.code,
                         'branch_name', h.branch_name, 'delivery_fee', h.fee, 'min_order', h.min_order,
                         'eta_min', h.eta_min, 'eta_max', h.eta_max, 'matched', h.matched,
                         'branch_state', everwake.branch_state(h.branch_id))
                       order by h.priority), '[]'::jsonb),
           'branches', count(distinct h.branch_id))
    from hits h
$$;

-- ---------------------------------------------------------------------
-- The review fingerprint: what the customer saw in the order summary.
-- Any change to the cart, the details, the branch, the zone or a promo
-- code makes the summary outdated, and place_order refuses it.
-- ---------------------------------------------------------------------
create or replace function everwake.review_hash(p_tenant uuid, p_wa text)
returns text language sql stable as $$
  select md5(coalesce((select jsonb_build_object(
                         'items', o.cart -> 'items', 'subtotal', o.subtotal, 'discount', o.discount_total,
                         'vat', o.vat, 'fee', o.delivery_fee, 'total', o.total)::text
                         from everwake.orders o
                        where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'), 'no-cart')
             || coalesce((select jsonb_build_object(
                            'customer', c.state -> 'customer', 'branch', c.state -> 'branch' -> 'id',
                            'zone', c.state -> 'zone' -> 'id', 'codes', c.state -> 'ledger' -> 'promo_codes')::text
                            from everwake.conversations c
                           where c.tenant_id = p_tenant and c.wa_id = p_wa), 'no-state'))
$$;

-- ---------------------------------------------------------------------
-- Intake: one inbound WhatsApp message.
-- Finds the restaurant from the WhatsApp instance, the customer from any
-- of their identities, logs the message once, and decides the route:
--   agent      → buffered for the debounce window; the agent answers
--   human      → a person took over; the message waits in the dashboard
--   paused     → the agent is OFF; apologise once, remember them
--   not_live   → restaurant still onboarding and this is not a test number
--   duplicate / ignore
-- ---------------------------------------------------------------------
create or replace function everwake.intake(p jsonb)
returns jsonb language plpgsql as $$
declare
  ch        everwake.whatsapp_channels%rowtype;
  t         everwake.tenants%rowtype;
  s         jsonb;
  cust      everwake.customers%rowtype;
  conv      everwake.conversations%rowtype;
  v_phone   text := nullif(everwake.digits(p ->> 'phone'), '');
  v_lid     text := nullif(everwake.digits(p ->> 'lid'), '');
  v_wa      text := nullif(btrim(p ->> 'wa_id'), '');
  v_reply   text := nullif(btrim(p ->> 'reply_to'), '');
  v_text    text := coalesce(p ->> 'text', '');
  v_cid     bigint;
  v_msg     bigint;
  v_buf     bigint;
  v_lang    text;
  v_release int;
  v_pc      everwake.pause_contacts%rowtype;
  v_pause   bigint;
  v_send    boolean := false;
  v_apology text;
  base      jsonb;
begin
  select * into ch from everwake.whatsapp_channels
   where provider = coalesce(nullif(p ->> 'provider', ''), 'evolution')
     and instance_name = p ->> 'instance' and is_active;
  if not found then
    return jsonb_build_object('route', 'ignore', 'reason', 'unknown_channel');
  end if;
  if coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('route', 'ignore', 'reason', 'bad_token');
  end if;
  select * into t from everwake.tenants where id = ch.tenant_id;
  if t.status in ('suspended', 'cancelled') then
    return jsonb_build_object('route', 'ignore', 'reason', 'tenant_' || t.status);
  end if;
  update everwake.whatsapp_channels
     set last_inbound_at = now(), status = 'connected', connected_at = coalesce(connected_at, now())
   where id = ch.id;
  s := everwake.merged_settings(t.settings);

  base := jsonb_build_object(
    'tenant_id', t.id, 'tenant_slug', t.slug, 'tenant_status', t.status,
    'channel', jsonb_build_object('id', ch.id, 'provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                  'instance', ch.instance_name, 'api_key', ch.api_key));

  if coalesce((p ->> 'from_me')::boolean, false) then
    return base || jsonb_build_object('route', 'from_me');
  end if;
  if v_wa is null then
    return base || jsonb_build_object('route', 'ignore', 'reason', 'no_sender');
  end if;

  -- the customer, by any identity -----------------------------------------
  select ci.customer_id into v_cid
    from everwake.customer_identities ci
   where ci.tenant_id = t.id
     and ((ci.kind = 'phone' and ci.value = v_phone) or (ci.kind = 'lid' and ci.value = v_lid))
   order by (ci.kind = 'phone') desc
   limit 1;
  if v_cid is null then
    select id into v_cid from everwake.customers where tenant_id = t.id and wa_id = v_wa;
  end if;
  if v_cid is null then
    insert into everwake.customers (tenant_id, wa_id, reply_to, phone, lid, phone_hidden, display_name)
    values (t.id, v_wa, coalesce(v_reply, v_wa), v_phone, v_lid, v_phone is null,
            nullif(btrim(p ->> 'push_name'), ''))
    on conflict (tenant_id, wa_id) do update set last_seen_at = now()
    returning id into v_cid;
  end if;
  update everwake.customers c
     set phone        = coalesce(c.phone, v_phone),
         lid          = coalesce(c.lid, v_lid),
         phone_hidden = coalesce(c.phone, v_phone) is null,
         -- a real number is the safest place to reply to
         reply_to     = case when v_phone is not null then v_phone else coalesce(v_reply, c.reply_to) end,
         display_name = coalesce(nullif(btrim(p ->> 'push_name'), ''), c.display_name),
         last_seen_at = now()
   where c.id = v_cid
  returning * into cust;
  if v_phone is not null then
    insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
    values (t.id, 'phone', v_phone, v_cid) on conflict do nothing;
  end if;
  if v_lid is not null then
    insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
    values (t.id, 'lid', v_lid, v_cid) on conflict do nothing;
  end if;

  -- the message, exactly once (Evolution can deliver twice) ---------------
  insert into everwake.messages (tenant_id, wa_id, direction, sender, kind, body, external_id, raw_payload, meta)
  values (t.id, cust.wa_id, 'inbound', 'customer', coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), p -> 'raw',
          jsonb_strip_nulls(jsonb_build_object('location', p -> 'location', 'push_name', p ->> 'push_name',
                                               'channel_id', ch.id)))
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_msg;
  if v_msg is null then
    return base || jsonb_build_object('route', 'duplicate', 'wa_id', cust.wa_id);
  end if;

  insert into everwake.conversations as c
    (tenant_id, customer_id, wa_id, state, last_message_at, last_inbound_at, unread_count, last_message_preview)
  values (t.id, v_cid, cust.wa_id,
          jsonb_build_object('contact', jsonb_build_object('reply_to', cust.reply_to, 'phone_hidden', cust.phone_hidden,
                                                           'channel_id', ch.id)),
          now(), now(), 1, left(v_text, 160))
  on conflict (tenant_id, wa_id) do update
    set state = c.state || jsonb_build_object('contact', coalesce(c.state -> 'contact', '{}'::jsonb) || (excluded.state -> 'contact')),
        customer_id = coalesce(c.customer_id, excluded.customer_id),
        last_message_at = now(), last_inbound_at = now(),
        unread_count = c.unread_count + 1,
        last_message_preview = excluded.last_message_preview
  returning * into conv;
  update everwake.messages set conversation_id = conv.id where id = v_msg;

  base := base || jsonb_build_object(
    'customer_id', cust.id, 'conversation_id', conv.id, 'message_id', v_msg,
    'wa_id', cust.wa_id, 'reply_to', cust.reply_to, 'phone_hidden', cust.phone_hidden);

  if cust.is_blocked then
    return base || jsonb_build_object('route', 'ignore', 'reason', 'blocked');
  end if;

  -- a person took over: the agent stays quiet unless the person went idle -
  if conv.mode = 'human' then
    v_release := coalesce((s ->> 'human_auto_release_minutes')::int, 0);
    if v_release > 0 and coalesce(conv.human_last_activity_at, conv.human_since, now())
                         < now() - make_interval(mins => v_release) then
      update everwake.conversations
         set mode = 'agent', assigned_user_id = null, human_since = null, human_reason = null,
             state = state || jsonb_build_object('handback', jsonb_build_object(
                       'at', now(), 'by', 'auto', 'human_since', conv.human_since))
       where id = conv.id;
    else
      return base || jsonb_build_object('route', 'human');
    end if;
  end if;

  -- the agent is OFF ---------------------------------------------------------
  if not t.agent_enabled then
    v_pause := t.current_pause_id;
    if v_pause is null then
      insert into everwake.agent_pauses (tenant_id, reason) values (t.id, 'switched off') returning id into v_pause;
      update everwake.tenants set current_pause_id = v_pause where id = t.id;
    end if;
    insert into everwake.pause_contacts as pc (pause_id, tenant_id, wa_id, reply_to, channel_id, customer_id)
    values (v_pause, t.id, cust.wa_id, cust.reply_to, ch.id, cust.id)
    on conflict (pause_id, wa_id) do update
      set last_message_at = now(), messages_count = pc.messages_count + 1, reply_to = excluded.reply_to,
          channel_id = excluded.channel_id
    returning * into v_pc;
    if v_pc.apologized_at is null then
      update everwake.pause_contacts set apologized_at = now()
       where pause_id = v_pc.pause_id and wa_id = v_pc.wa_id;
      update everwake.agent_pauses set contacts_count = contacts_count + 1 where id = v_pause;
      v_lang := case when v_text ~ '[ء-ي]' then 'ar'
                     when v_text ~ '[A-Za-z]' then 'en'
                     else coalesce(cust.language, t.default_language) end;
      v_apology := everwake.render_template(
                     s -> 'templates' ->> ('pause_apology_' || v_lang),
                     jsonb_build_object('name', everwake.first_name(cust.full_name, cust.display_name),
                                        'restaurant', case when v_lang = 'en' then coalesce(nullif(t.name_en, ''), t.name_ar) else t.name_ar end));
      v_send := true;
    end if;
    return base || jsonb_build_object('route', 'paused', 'send_apology', v_send, 'apology_text', v_apology,
                                      'pause_id', v_pause);
  end if;

  -- still onboarding: only the restaurant's test numbers (and the Test
  -- Runner's pretend number, 013) reach the agent ----
  if t.status = 'onboarding'
     and not (coalesce((p ->> 'test_run')::boolean, false) and everwake.is_test_number(cust.wa_id))
     and not (coalesce(s -> 'test_numbers', '[]'::jsonb) ? cust.wa_id
              or (cust.phone is not null and coalesce(s -> 'test_numbers', '[]'::jsonb) ? cust.phone)) then
    return base || jsonb_build_object('route', 'not_live');
  end if;

  insert into everwake.inbound_buffer (tenant_id, wa_id, message_text, has_location, location)
  values (t.id, cust.wa_id, v_text, coalesce((p ->> 'has_location')::boolean, false), p -> 'location')
  returning id into v_buf;

  return base || jsonb_build_object('route', 'agent', 'buffer_id', v_buf);
end $$;

-- ---------------------------------------------------------------------
-- A message the restaurant typed on the phone itself (fromMe). Called a
-- few seconds after it arrives, so the engine's own sends are already
-- logged and are not mistaken for a person.
-- ---------------------------------------------------------------------
create or replace function everwake.log_phone_reply(p jsonb)
returns jsonb language plpgsql as $$
declare
  ch     everwake.whatsapp_channels%rowtype;
  t      everwake.tenants%rowtype;
  s      jsonb;
  v_wa   text;
  v_cid  bigint;
  v_conv bigint;
  v_text text := coalesce(p ->> 'text', '');
  v_msg  bigint;
begin
  select * into ch from everwake.whatsapp_channels
   where provider = coalesce(nullif(p ->> 'provider', ''), 'evolution') and instance_name = p ->> 'instance' and is_active;
  if not found or coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('logged', false, 'reason', 'unknown_channel');
  end if;
  select * into t from everwake.tenants where id = ch.tenant_id;
  s := everwake.merged_settings(t.settings);

  if nullif(p ->> 'external_id', '') is not null
     and exists (select 1 from everwake.messages where tenant_id = t.id and external_id = p ->> 'external_id') then
    return jsonb_build_object('logged', false, 'reason', 'already_logged');
  end if;

  select ci.customer_id into v_cid
    from everwake.customer_identities ci
   where ci.tenant_id = t.id
     and ((ci.kind = 'phone' and ci.value = nullif(everwake.digits(p ->> 'phone'), ''))
       or (ci.kind = 'lid' and ci.value = nullif(everwake.digits(p ->> 'lid'), '')))
   limit 1;
  if v_cid is null then
    select id into v_cid from everwake.customers where tenant_id = t.id and wa_id = p ->> 'wa_id';
  end if;
  if v_cid is null then
    return jsonb_build_object('logged', false, 'reason', 'unknown_customer');
  end if;
  select wa_id into v_wa from everwake.customers where id = v_cid;

  -- the engine's own reply that came back before its id was stored
  if exists (select 1 from everwake.messages
              where tenant_id = t.id and wa_id = v_wa and direction = 'outbound'
                and created_at > now() - interval '3 minutes'
                and btrim(coalesce(body, '')) = btrim(v_text) and v_text <> '') then
    return jsonb_build_object('logged', false, 'reason', 'engine_echo');
  end if;

  select id into v_conv from everwake.conversations where tenant_id = t.id and wa_id = v_wa;
  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, external_id, status, sent_at, meta)
  values (t.id, v_conv, v_wa, 'outbound', 'staff', coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), 'sent', now(), jsonb_build_object('via', 'phone'))
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_msg;
  if v_msg is null then
    return jsonb_build_object('logged', false, 'reason', 'already_logged');
  end if;

  update everwake.conversations
     set last_message_at = now(), last_outbound_at = now(), last_message_preview = left(v_text, 160),
         mode = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true) then 'human' else mode end,
         human_since = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true)
                            then coalesce(human_since, now()) else human_since end,
         human_last_activity_at = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true)
                                       then now() else human_last_activity_at end,
         human_reason = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true) and mode = 'agent'
                             then 'replied from the phone' else human_reason end
   where id = v_conv;
  return jsonb_build_object('logged', true, 'message_id', v_msg, 'wa_id', v_wa);
end $$;

-- ---------------------------------------------------------------------
-- Debounce window (Seagull): only the run holding the newest buffered
-- message answers. It takes a 120 s lock and drains every buffered
-- message into one turn. A takeover or the OFF switch during the wait
-- ends the run quietly — the messages are already in the inbox.
-- ---------------------------------------------------------------------
create or replace function everwake.claim_window(p_tenant uuid, p_wa text, p_run text, p_buffer bigint)
returns jsonb language plpgsql as $$
declare
  v_mode    text;
  v_enabled boolean;
  v_newest  bigint;
  v_lock    text;
  r         record;
begin
  select c.mode into v_mode from everwake.conversations c where c.tenant_id = p_tenant and c.wa_id = p_wa;
  select t.agent_enabled into v_enabled from everwake.tenants t where t.id = p_tenant;
  if v_mode = 'human' or not v_enabled then
    delete from everwake.inbound_buffer where tenant_id = p_tenant and wa_id = p_wa and claimed_by_run_id is null;
    return jsonb_build_object('is_newest', false, 'lock_acquired', false,
                              'blocked_reason', case when v_mode = 'human' then 'human' else 'paused' end);
  end if;

  select b.id into v_newest
    from everwake.inbound_buffer b
   where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
   order by b.received_at desc, b.id desc
   limit 1;
  if v_newest is distinct from p_buffer then
    return jsonb_build_object('is_newest', false, 'lock_acquired', false);
  end if;

  insert into everwake.conversation_locks as l (tenant_id, wa_id, run_id, locked_at, expires_at)
  values (p_tenant, p_wa, p_run, now(), now() + interval '120 seconds')
  on conflict (tenant_id, wa_id) do update
    set run_id = excluded.run_id, locked_at = now(), expires_at = excluded.expires_at
    where l.expires_at < now()
  returning run_id into v_lock;
  if v_lock is null then
    return jsonb_build_object('is_newest', true, 'lock_acquired', false);
  end if;

  with drained as (
    update everwake.inbound_buffer b
       set claimed_by_run_id = p_run
     where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
    returning b.message_text, b.has_location, b.location, b.received_at
  )
  select coalesce(string_agg(nullif(d.message_text, ''), E'\n' order by d.received_at), '') as combined_text,
         coalesce(bool_or(d.has_location), false) as has_location,
         (array_remove(array_agg(d.location order by d.received_at desc), null))[1] as location,
         count(*) as buffered_count
    into r
    from drained d;

  return jsonb_build_object('is_newest', true, 'lock_acquired', true,
                            'combined_text', r.combined_text, 'has_location', r.has_location,
                            'location', r.location, 'buffered_count', r.buffered_count);
end $$;

-- ---------------------------------------------------------------------
-- A GPS pin: stored with its resolved address, matched to the delivery
-- zones, and — when nothing is chosen yet and the cart is empty — the
-- branch that delivers there is chosen. A chosen branch with items in
-- the cart is never switched silently: the agent decides and re-prices.
-- ---------------------------------------------------------------------
create or replace function everwake.save_pin(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant  uuid := (p ->> 'tenant_id')::uuid;
  v_wa      text := p ->> 'wa_id';
  v_lat     double precision := (p ->> 'lat')::double precision;
  v_lng     double precision := (p ->> 'lng')::double precision;
  v_geo     jsonb := coalesce(p -> 'geo', '{}'::jsonb);
  t         everwake.tenants%rowtype;
  s         jsonb;
  st        jsonb;
  v_zones   jsonb;
  v_best    jsonb;
  v_hasz    boolean;
  v_nearest jsonb;
  v_lines   int;
  v_auto    boolean := false;
  v_zone    jsonb;
  v_in      boolean;
  v_loc     jsonb;
  v_cust    jsonb;
begin
  select * into t from everwake.tenants where id = v_tenant;
  s := everwake.merged_settings(t.settings);
  select state into st from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa for update;
  st := coalesce(st, '{}'::jsonb);

  v_hasz := exists (select 1 from everwake.delivery_zones where tenant_id = v_tenant and is_active);
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into v_zones from everwake.zones_at(v_tenant, v_lat, v_lng) z;

  select coalesce(jsonb_agg(x order by (x ->> 'km')::numeric), '[]'::jsonb) into v_nearest
    from (select jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name_ar,
                                    'km', everwake.haversine_km(b.lat, b.lng, v_lat, v_lng),
                                    'state', everwake.branch_state(b.id),
                                    'delivery_enabled', b.delivery_enabled,
                                    'max_km', coalesce(b.max_delivery_km, (s ->> 'max_delivery_km')::numeric)) as x
            from everwake.branches b
           where b.tenant_id = v_tenant and b.is_active and b.lat is not null and b.lng is not null
           order by everwake.haversine_km(b.lat, b.lng, v_lat, v_lng)
           limit 3) n;

  if v_hasz then
    v_best := v_zones -> 0;
    if v_best is not null then
      v_zone := jsonb_build_object('id', v_best ->> 'zone_id', 'name', v_best ->> 'zone_name',
                  'branch_id', v_best ->> 'branch_id', 'branch_code', v_best ->> 'branch_code',
                  'branch_name', v_best ->> 'branch_name', 'delivery_fee', v_best -> 'delivery_fee',
                  'min_order', v_best -> 'min_order', 'eta_min', v_best -> 'eta_min', 'eta_max', v_best -> 'eta_max',
                  'branch_state', v_best ->> 'branch_state', 'source', 'pin', 'at', now());
    end if;
  else
    -- no zones drawn yet: the nearest delivering branch within its range
    select jsonb_build_object('id', null, 'name', null, 'branch_id', x ->> 'id', 'branch_code', x ->> 'code',
                              'branch_name', x ->> 'name', 'delivery_fee', b.delivery_fee, 'min_order', b.min_order,
                              'branch_state', x ->> 'state', 'km', x -> 'km', 'source', 'radius', 'at', now())
      into v_zone
      from jsonb_array_elements(v_nearest) x
      join everwake.branches b on b.id = (x ->> 'id')::uuid
     where (x ->> 'delivery_enabled')::boolean and (x ->> 'km')::numeric <= (x ->> 'max_km')::numeric
     order by case x ->> 'state' when 'open' then 0 when 'unknown' then 1 when 'closed' then 2 else 3 end,
              (x ->> 'km')::numeric
     limit 1;
  end if;
  v_in := v_zone is not null;

  select coalesce(jsonb_array_length(o.cart -> 'items'), 0) into v_lines
    from everwake.orders o where o.tenant_id = v_tenant and o.wa_id = v_wa and o.status = 'draft';
  v_auto := v_in and (st -> 'branch' ->> 'id') is null and coalesce(v_lines, 0) = 0;

  v_loc := jsonb_build_object(
    'lat', v_lat, 'lng', v_lng, 'maps_url', p ->> 'maps_url', 'geo', v_geo, 'at', now(),
    'in_delivery_area', v_in, 'zones_drawn', v_hasz,
    'zone_candidates', (select coalesce(jsonb_agg(z), '[]'::jsonb) from (select z from jsonb_array_elements(v_zones) z limit 4) q),
    'nearest', v_nearest);

  -- the pin is where they are: it becomes the delivery address unless the
  -- customer typed one (a typed address always wins)
  v_cust := coalesce(st -> 'customer', '{}'::jsonb);
  if coalesce(v_cust ->> 'address_source', 'pin') = 'pin' then
    v_cust := (v_cust - 'address_street' - 'address_area' - 'address_city' - 'address_governorate' - 'address_confirmed')
              || jsonb_strip_nulls(jsonb_build_object(
                   'address_street',      nullif(v_geo ->> 'street', ''),
                   'address_area',        nullif(v_geo ->> 'district', ''),
                   'address_city',        nullif(v_geo ->> 'city', ''),
                   'address_governorate', nullif(v_geo ->> 'governorate', ''),
                   'address_source', case when coalesce(nullif(v_geo ->> 'street', ''), nullif(v_geo ->> 'district', ''),
                                                        nullif(v_geo ->> 'city', '')) is not null then 'pin' end));
  end if;

  st := st || jsonb_build_object('location', v_loc, 'customer', v_cust)
           || case when v_zone is not null then jsonb_build_object('zone', v_zone) else jsonb_build_object('zone', null) end
           || case when v_auto then jsonb_build_object('branch', jsonb_build_object(
                     'id', v_zone ->> 'branch_id', 'code', v_zone ->> 'branch_code', 'name_ar', v_zone ->> 'branch_name',
                     'source', 'zone', 'set_at', now())) else '{}'::jsonb end;

  update everwake.conversations set state = st where tenant_id = v_tenant and wa_id = v_wa;
  return jsonb_build_object('location', v_loc, 'zone', v_zone, 'branch', st -> 'branch',
                            'auto_branch_set', v_auto, 'in_delivery_area', v_in);
end $$;

-- ---------------------------------------------------------------------
-- Everything the Brain and the Agent need for one turn.
-- ---------------------------------------------------------------------
create or replace function everwake.turn_context(p_tenant uuid, p_wa text)
returns jsonb language plpgsql as $$
declare
  t       everwake.tenants%rowtype;
  conv    everwake.conversations%rowtype;
  cust    everwake.customers%rowtype;
  v_bid   text;
  v_ids   bigint[];
  v_phones text[];
  v_all   everwake.menu_snapshot%rowtype;
  v_br    everwake.menu_snapshot%rowtype;
begin
  perform everwake.ensure_snapshot(p_tenant);
  select * into t from everwake.tenants where id = p_tenant;
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into cust from everwake.customers where id = conv.customer_id;

  -- a restaurant with one branch never has to ask which one
  if (conv.state -> 'branch' ->> 'id') is null
     and (select count(*) from everwake.branches b where b.tenant_id = p_tenant and b.is_active) = 1 then
    update everwake.conversations c
       set state = c.state || jsonb_build_object('branch', (
                     select jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar,
                                               'source', 'only_branch', 'set_at', now())
                       from everwake.branches b where b.tenant_id = p_tenant and b.is_active))
     where c.id = conv.id
    returning * into conv;
  end if;
  v_bid := conv.state -> 'branch' ->> 'id';

  -- previous orders: by this customer, or by the number they gave us
  v_ids := array_remove(array[cust.id, nullif(conv.state -> 'contact' ->> 'linked_customer_id', '')::bigint], null);
  select array_agg(ci.value) into v_phones
    from everwake.customer_identities ci where ci.customer_id = any(v_ids) and ci.kind = 'phone';

  select * into v_all from everwake.menu_snapshot where tenant_id = p_tenant and scope = 'all';
  select * into v_br from everwake.menu_snapshot where tenant_id = p_tenant and scope = v_bid;

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'status', t.status, 'agent_enabled', t.agent_enabled),
    'state', coalesce(conv.state, '{}'::jsonb),
    'conversation', jsonb_build_object('id', conv.id, 'mode', conv.mode, 'needs_attention', conv.needs_attention,
                                       'created_at', conv.created_at),
    'customer', jsonb_build_object(
       'id', cust.id, 'wa_id', cust.wa_id, 'phone', cust.phone, 'phone_hidden', cust.phone_hidden,
       'display_name', cust.display_name, 'full_name', cust.full_name, 'alt_phone', cust.alt_phone,
       'food_prefs', cust.food_prefs, 'language', cust.language, 'tags', to_jsonb(cust.tags),
       'orders_count', (select count(*) from everwake.orders o
                         where o.tenant_id = p_tenant and o.status not in ('draft', 'cancelled', 'rejected')
                           and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))),
       'first_seen_at', cust.first_seen_at),
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'last_orders', coalesce((
       select jsonb_agg(x order by (x ->> 'placed_at') desc) from (
         select jsonb_build_object(
                  'order_no', o.order_no, 'status', o.status, 'placed_at', o.placed_at,
                  'branch_id', o.branch_id, 'branch_name', b.name_ar, 'total', o.total,
                  'delivery_method', o.delivery_method, 'payment_method', o.payment_method,
                  -- paying online (011): paid or not, and the live link to send again
                  'payment_status', o.payment_status, 'paid_amount', o.paid_amount,
                  'payment', (select jsonb_build_object('status', p.status, 'amount', p.amount, 'expires_at', p.expires_at,
                                       'link', case when p.status = 'pending' and p.expires_at > now()
                                                    then everwake.payment_short_url(p.tenant_id, p.ref) end,
                                       'declined_attempts', p.attempts, 'last_error', p.last_error)
                                from everwake.payments p where p.order_id = o.id order by p.id desc limit 1),
                  'address_text', o.address_text, 'eta_text', o.eta_text,
                  'last_update_at', greatest(o.accepted_at, o.ready_at, o.out_for_delivery_at, o.completed_at, o.cancelled_at),
                  -- the restaurant's driver on it, and how far they were at their last position
                  'driver', (select jsonb_build_object('name', d.name, 'phone', d.phone) from everwake.drivers d where d.id = o.driver_id),
                  'tracking', case when o.delivery_track_at > now() - interval '10 minutes' then
                                jsonb_build_object('km_left', o.delivery_km_left, 'eta_min', o.delivery_eta_min,
                                                   'minutes_ago', floor(extract(epoch from now() - o.delivery_track_at) / 60)) end,
                  'items', coalesce((select jsonb_agg(jsonb_build_object(
                                       'code', oi.item_code, 'name', oi.name, 'quantity', oi.quantity, 'unit', oi.unit,
                                       'choices', oi.choices, 'notes', oi.notes, 'line_total', oi.line_total,
                                       'gift', oi.is_gift) order by oi.line_no)
                                       from everwake.order_items oi where oi.order_id = o.id), '[]'::jsonb)) as x
           from everwake.orders o
           left join everwake.branches b on b.id = o.branch_id
          where o.tenant_id = p_tenant and o.status <> 'draft'
            and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
          order by o.placed_at desc nulls last
          limit 3) q), '[]'::jsonb),
    'saved_addresses', coalesce((
       select jsonb_agg(jsonb_build_object('id', a.id, 'text', a.address_text, 'area', a.area, 'street', a.street,
                                           'building', a.building, 'floor', a.floor, 'apartment', a.apartment,
                                           'landmark', a.landmark, 'zone_id', a.zone_id, 'branch_id', a.branch_id,
                                           'has_pin', a.lat is not null, 'last_used_at', a.last_used_at)
                        order by a.last_used_at desc)
         from (select * from everwake.customer_addresses
                where customer_id = any(v_ids) order by last_used_at desc limit 3) a), '[]'::jsonb),
    'recent_messages', coalesce((
       select jsonb_agg(jsonb_build_object('direction', m.direction, 'sender', m.sender, 'kind', m.kind,
                                           'text', m.body, 'at', m.created_at, 'staff_name', m.staff_name,
                                           'status', m.status)
                        order by m.created_at)
         from (select mm.*, tm.display_name as staff_name
                 from everwake.messages mm
                 left join everwake.tenant_members tm on tm.tenant_id = mm.tenant_id and tm.user_id = mm.staff_user_id
                where mm.tenant_id = p_tenant and mm.wa_id = p_wa and mm.status <> 'failed'
                order by mm.created_at desc limit 20) m), '[]'::jsonb),
    'pause', (select jsonb_build_object('apologized_at', pc.apologized_at, 'resume_notified_at', pc.resume_notified_at,
                                        'paused_at', ap.started_at, 'resumed_at', ap.ended_at)
                from everwake.pause_contacts pc join everwake.agent_pauses ap on ap.id = pc.pause_id
               where pc.tenant_id = p_tenant and pc.wa_id = p_wa and pc.last_message_at > now() - interval '24 hours'
               order by pc.last_message_at desc limit 1),
    -- table bookings (010): the rules, the one in progress, and what is coming up
    'reservation_setup', everwake.reservation_setup(p_tenant),
    'reservation', (select everwake.reservation_view(x) from everwake.reservations x
                     where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status = 'draft'),
    'reservations_upcoming', coalesce((select jsonb_agg(everwake.reservation_view(x) order by x.reserved_for)
                                         from everwake.reservations x
                                        where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status in ('requested', 'confirmed')
                                          and x.reserved_for > now() - interval '3 hours'), '[]'::jsonb),
    'all_lookup', coalesce(v_all.lookup, '{}'::jsonb),
    'all_digest', coalesce(v_all.digest_text, ''),
    'branch_lookup', coalesce(v_br.lookup, '{}'::jsonb),
    'menu_digest', coalesce(v_br.digest_text, v_all.digest_text, ''),
    'menu_version', coalesce(v_br.version_hash, v_all.version_hash, 'none'),
    'current_review_hash', everwake.review_hash(p_tenant, p_wa));
end $$;

-- after the Agent's tools ran: the state the reply is checked against
create or replace function everwake.read_back(p_tenant uuid, p_wa text)
returns jsonb language sql stable as $$
  with st as (select coalesce((select state from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa),
                              '{}'::jsonb) as state)
  select jsonb_build_object(
    'state', (select state from st),
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'branch_lookup', coalesce((select lookup from everwake.menu_snapshot
                                where tenant_id = p_tenant and scope = (select state -> 'branch' ->> 'id' from st)), '{}'::jsonb),
    'last_placed', coalesce((select jsonb_build_object('order_no', o.order_no, 'placed_at', o.placed_at, 'total', o.total)
                               from everwake.orders o
                              where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status <> 'draft'
                              order by o.placed_at desc nulls last limit 1), 'null'::jsonb))
$$;

-- ---------------------------------------------------------------------
-- The turn's own record: memory, handoff, telemetry, unlock, cleanup.
-- ---------------------------------------------------------------------
create or replace function everwake.persist_turn(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant  uuid := (p ->> 'tenant_id')::uuid;
  v_wa      text := p ->> 'wa_id';
  v_run     text := p ->> 'run_id';
  v_handoff boolean := coalesce((p -> 'handoff' ->> 'needed')::boolean, false);
  v_take    boolean;
  n_state int; n_unlock int; n_clean int;
begin
  select coalesce((everwake.merged_settings(settings) ->> 'auto_takeover_on_handoff')::boolean, false)
    into v_take from everwake.tenants where id = v_tenant;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || coalesce(p -> 'state_patch', '{}'::jsonb)
                 || jsonb_build_object('ledger',
                      coalesce(c.state -> 'ledger', '{}'::jsonb)
                      || coalesce(p -> 'ledger_patch', '{}'::jsonb)
                      || case when coalesce((p ->> 'save_review')::boolean, false)
                              then jsonb_build_object('review_hash', everwake.review_hash(v_tenant, v_wa), 'review_at', now())
                              else '{}'::jsonb end),
         needs_attention  = c.needs_attention or v_handoff,
         attention_reason = case when v_handoff then nullif(p -> 'handoff' ->> 'reason', '') else c.attention_reason end,
         attention_at     = case when v_handoff then now() else c.attention_at end,
         mode             = case when v_handoff and v_take then 'human' else c.mode end,
         human_since      = case when v_handoff and v_take and c.mode = 'agent' then now() else c.human_since end,
         human_reason     = case when v_handoff and v_take and c.mode = 'agent' then 'agent asked for a person: ' || coalesce(p -> 'handoff' ->> 'reason', '') else c.human_reason end
   where c.tenant_id = v_tenant and c.wa_id = v_wa;
  get diagnostics n_state = row_count;

  if nullif(p ->> 'language', '') is not null then
    update everwake.customers set language = p ->> 'language'
     where tenant_id = v_tenant and wa_id = v_wa and language is distinct from p ->> 'language';
  end if;

  insert into everwake.agent_events
    (tenant_id, wa_id, run_id, stage, order_stage, cart_action, qa_passed, repair_used, llm_calls,
     duration_total_ms, duration_llm_ms, prompt_tokens, completion_tokens, cached_tokens, input, output)
  select v_tenant, v_wa, v_run, 'turn_complete', l ->> 'order_stage', l ->> 'cart_action',
         (l ->> 'qa_passed')::boolean, (l ->> 'repair_used')::boolean, (l ->> 'llm_calls')::int,
         (l ->> 'duration_total_ms')::int, (l ->> 'duration_llm_ms')::int, (l ->> 'prompt_tokens')::int,
         (l ->> 'completion_tokens')::int, coalesce((l ->> 'cached_tokens')::int, 0),
         coalesce(l -> 'input', '{}'::jsonb), coalesce(l -> 'output', '{}'::jsonb)
    from (select coalesce(p -> 'log_row', '{}'::jsonb) as l) x;

  delete from everwake.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
  get diagnostics n_unlock = row_count;
  delete from everwake.inbound_buffer where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
  get diagnostics n_clean = row_count;

  -- a person may have taken over (or the agent been switched off) while
  -- the model was thinking: the reply is then not sent
  return jsonb_build_object('state_written', n_state, 'locks_released', n_unlock, 'buffer_rows_cleared', n_clean,
                            'mode', (select mode from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa),
                            'agent_enabled', (select agent_enabled from everwake.tenants where id = v_tenant));
end $$;

-- a turn that ends without replying (superseded, blocked, failed) must not hold the lock
create or replace function everwake.release_lock(p_tenant uuid, p_wa text, p_run text)
returns void language sql as $$
  delete from everwake.conversation_locks where tenant_id = p_tenant and wa_id = p_wa and run_id = p_run;
$$;

-- every message the engine sends to a customer
create or replace function everwake.log_outbound(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_conv   bigint;
  v_id     bigint;
  v_ok     boolean := coalesce((p ->> 'ok')::boolean, true);
begin
  select id into v_conv from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa;
  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, media_url, media_mime,
                                 external_id, status, error, run_id, meta, sent_at)
  values (v_tenant, v_conv, v_wa, 'outbound', coalesce(nullif(p ->> 'sender', ''), 'agent'),
          coalesce(nullif(p ->> 'kind', ''), 'text'), p ->> 'body', nullif(p ->> 'media_url', ''),
          nullif(p ->> 'media_mime', ''), nullif(p ->> 'external_id', ''),
          case when v_ok then 'sent' else 'failed' end, nullif(p ->> 'error', ''), p ->> 'run_id',
          coalesce(p -> 'meta', '{}'::jsonb), case when v_ok then now() end)
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_id;
  if v_ok then
    update everwake.conversations
       set last_outbound_at = now(), last_message_at = now(),
           last_message_preview = left(coalesce(p ->> 'body', '[' || coalesce(p ->> 'kind', 'media') || ']'), 160)
     where id = v_conv;
  end if;
  return jsonb_build_object('message_id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- manage_cart: load, persist, place
-- ---------------------------------------------------------------------
create or replace function everwake.cart_context(p_tenant uuid, p_wa text, p_branch text)
returns jsonb language plpgsql as $$
declare
  st     jsonb;
  v_req  record;
  v_q    text := everwake.norm(p_branch);
  v_cust bigint;
  v_ids  bigint[];
  v_phones text[];
begin
  perform everwake.ensure_snapshot(p_tenant);
  select null::uuid as id, null::text as code, null::int as rank into v_req;
  select c.state, c.customer_id into st, v_cust from everwake.conversations c where c.tenant_id = p_tenant and c.wa_id = p_wa;
  st := coalesce(st, '{}'::jsonb);
  v_ids := array_remove(array[v_cust, nullif(st -> 'contact' ->> 'linked_customer_id', '')::bigint], null);
  select array_agg(ci.value) into v_phones from everwake.customer_identities ci where ci.customer_id = any(v_ids) and ci.kind = 'phone';

  -- "same as last time": the branch of their latest order
  if p_branch = '__last_order__' then
    select o.branch_id as id, b.code, 1 as rank into v_req
      from everwake.orders o join everwake.branches b on b.id = o.branch_id and b.is_active
     where o.tenant_id = p_tenant and o.status <> 'draft'
       and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
     order by o.placed_at desc nulls last limit 1;
  -- exact code / name / alias first; an area the branch usually serves last
  elsif nullif(btrim(coalesce(p_branch, '')), '') is not null then
    select b.id, b.code,
           case when b.code = lower(btrim(p_branch)) or b.id::text = btrim(p_branch) then 1
                when everwake.norm(b.name_ar) = v_q or everwake.norm(b.name_en) = v_q then 2
                when exists (select 1 from unnest(b.aliases) a where everwake.norm(a) = v_q) then 3
                when everwake.norm(b.name_ar) like '%' || v_q || '%' or everwake.norm(b.name_en) like '%' || v_q || '%' then 4
                else 5 end as rank
      into v_req
      from everwake.branches b
     where b.tenant_id = p_tenant and b.is_active
       and (   b.code = lower(btrim(p_branch)) or b.id::text = btrim(p_branch)
            or everwake.norm(b.name_ar) = v_q or everwake.norm(b.name_en) = v_q
            or exists (select 1 from unnest(b.aliases) a where everwake.norm(a) = v_q)
            or (length(v_q) >= 2 and (everwake.norm(b.name_ar) like '%' || v_q || '%' or everwake.norm(b.name_en) like '%' || v_q || '%'))
            or (length(v_q) >= 3 and everwake.norm(b.serves_hint_ar) like '%' || v_q || '%'))
     order by rank, b.accepting_orders desc, b.sort
     limit 1;
  end if;

  return jsonb_build_object(
    'state', st,
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'requested_branch_id', v_req.id,
    'requested_match_rank', v_req.rank,
    'menu_lookup', coalesce((select lookup from everwake.menu_snapshot
                              where tenant_id = p_tenant and scope = st -> 'branch' ->> 'id'), '{}'::jsonb),
    'requested_lookup', coalesce((select lookup from everwake.menu_snapshot
                                   where tenant_id = p_tenant and scope = v_req.id::text), '{}'::jsonb),
    'all_lookup', coalesce((select lookup from everwake.menu_snapshot where tenant_id = p_tenant and scope = 'all'), '{}'::jsonb),
    'branch_states', coalesce((select jsonb_object_agg(b.id, everwake.branch_state(b.id))
                                 from everwake.branches b where b.tenant_id = p_tenant and b.is_active), '{}'::jsonb),
    'orders_count', (select count(*) from everwake.orders o
                      where o.tenant_id = p_tenant and o.status not in ('draft', 'cancelled', 'rejected')
                        and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))),
    'last_order', (select jsonb_build_object('order_no', o.order_no, 'branch_id', o.branch_id, 'placed_at', o.placed_at,
                                             'items', o.cart -> 'items')
                     from everwake.orders o
                    where o.tenant_id = p_tenant and o.status <> 'draft'
                      and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
                    order by o.placed_at desc nulls last limit 1),
    'current_review_hash', everwake.review_hash(p_tenant, p_wa));
end $$;

-- writes the draft order and merges the tool's keys into the state (one
-- level deep into ledger, so save_customer_details in the same turn
-- never erases it)
create or replace function everwake.persist_cart(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_conv   everwake.conversations%rowtype;
  v_order  bigint;
  tot      jsonb := coalesce(p -> 'totals', '{}'::jsonb);
begin
  select * into v_conv from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa;
  insert into everwake.orders as o
    (tenant_id, wa_id, customer_id, conversation_id, status, branch_id, zone_id, cart, currency, subtotal,
     discount_total, applied_offers, vat, delivery_fee, total)
  values (v_tenant, v_wa, v_conv.customer_id, v_conv.id, 'draft', nullif(p ->> 'branch_id', '')::uuid,
          nullif(p ->> 'zone_id', '')::uuid, coalesce(p -> 'cart', '{"items":[]}'::jsonb),
          coalesce(nullif(tot ->> 'currency', ''), 'EGP'),
          coalesce((tot ->> 'subtotal')::numeric, 0), coalesce((tot ->> 'discount_total')::numeric, 0),
          coalesce(tot -> 'applied_offers', '[]'::jsonb), (tot ->> 'vat')::numeric, (tot ->> 'delivery_fee')::numeric,
          coalesce((tot ->> 'total')::numeric, 0))
  on conflict (tenant_id, wa_id) where status = 'draft' do update
    set branch_id = excluded.branch_id, zone_id = excluded.zone_id, cart = excluded.cart, currency = excluded.currency,
        subtotal = excluded.subtotal, discount_total = excluded.discount_total, applied_offers = excluded.applied_offers,
        vat = excluded.vat, delivery_fee = excluded.delivery_fee, total = excluded.total,
        customer_id = coalesce(o.customer_id, excluded.customer_id), conversation_id = coalesce(o.conversation_id, excluded.conversation_id)
  returning id into v_order;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || (coalesce(p -> 'state_patch', '{}'::jsonb) - 'ledger')
                 || jsonb_build_object('ledger', coalesce(c.state -> 'ledger', '{}'::jsonb) || coalesce(p -> 'ledger_patch', '{}'::jsonb))
   where c.tenant_id = v_tenant and c.wa_id = v_wa;

  return jsonb_build_object('order_id', v_order);
end $$;

-- the draft becomes a placed order with a number; the customer's record,
-- their address book and the order lines are written in the same step
create or replace function everwake.place_order(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  t        everwake.tenants%rowtype;
  o        everwake.orders%rowtype;
  v_seq    bigint;
  v_no     text;
  cs       jsonb := coalesce(p -> 'customer', '{}'::jsonb);
  addr     jsonb := p -> 'address';
  v_fp     text;
  v_phone  text;
  v_addr   bigint;
  tot      jsonb := coalesce(p -> 'totals', '{}'::jsonb);
begin
  select * into o from everwake.orders
   where tenant_id = v_tenant and wa_id = v_wa and status = 'draft' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NO_DRAFT');
  end if;

  update everwake.tenants set order_seq = order_seq + 1 where id = v_tenant returning * into t;
  v_seq := t.order_seq;
  v_no := t.order_no_prefix || '-' || v_seq;

  update everwake.orders
     set status = 'placed', placed_at = now(), order_no = v_no,
         branch_id = coalesce(nullif(p ->> 'branch_id', '')::uuid, branch_id),
         zone_id = coalesce(nullif(p ->> 'zone_id', '')::uuid, zone_id),
         customer = cs,
         delivery_method = nullif(cs ->> 'delivery_method', ''),
         payment_method = nullif(cs ->> 'payment_method', ''),
         address_text = nullif(p ->> 'address_text', ''),
         address = addr,
         location = p -> 'location',
         notes = nullif(p ->> 'notes', ''),
         eta_text = nullif(p ->> 'eta_text', ''),
         subtotal = coalesce((tot ->> 'subtotal')::numeric, subtotal),
         discount_total = coalesce((tot ->> 'discount_total')::numeric, discount_total),
         applied_offers = coalesce(tot -> 'applied_offers', applied_offers),
         vat = case when tot ? 'vat' then (tot ->> 'vat')::numeric else vat end,
         delivery_fee = case when tot ? 'delivery_fee' then (tot ->> 'delivery_fee')::numeric else delivery_fee end,
         total = coalesce((tot ->> 'total')::numeric, total),
         currency = t.currency
   where id = o.id
  returning * into o;

  insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, unit, quantity,
                                    unit_price, line_total, choices, notes, is_gift)
  select v_tenant, o.id, x.n::int, nullif(x.i ->> 'item_id', '')::uuid, x.i ->> 'code',
         coalesce(x.i ->> 'display_name', x.i ->> 'item_name', '?'), x.i ->> 'unit',
         coalesce((x.i ->> 'quantity')::numeric, 1), (x.i ->> 'unit_price')::numeric, (x.i ->> 'line_total')::numeric,
         coalesce(x.i -> 'choices', '[]'::jsonb), nullif(x.i ->> 'notes', ''), coalesce((x.i ->> 'gift')::boolean, false)
    from jsonb_array_elements(coalesce(o.cart -> 'items', '[]'::jsonb)) with ordinality as x(i, n);

  insert into everwake.order_events (tenant_id, order_id, status, by_role, note)
  values (v_tenant, o.id, 'placed', 'agent', null);

  -- the customer's record
  v_phone := nullif(everwake.digits(cs ->> 'phone'), '');
  update everwake.customers c
     set orders_count = c.orders_count + 1, total_spent = c.total_spent + coalesce(o.total, 0),
         last_order_id = o.id, last_order_at = now(),
         full_name = coalesce(nullif(cs ->> 'full_name', ''), c.full_name),
         alt_phone = coalesce(nullif(cs ->> 'alt_phone', ''), c.alt_phone),
         food_prefs = coalesce(nullif(cs ->> 'food_prefs', ''), c.food_prefs)
   where c.id = o.customer_id;
  if v_phone is not null and o.customer_id is not null then
    insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
    values (v_tenant, 'phone', v_phone, o.customer_id) on conflict do nothing;
  end if;

  -- the address book (delivery only)
  if o.delivery_method = 'delivery' and addr is not null and o.customer_id is not null then
    v_fp := md5(everwake.norm(concat_ws('|', addr ->> 'area', addr ->> 'street', addr ->> 'building',
                                         addr ->> 'floor', addr ->> 'apartment')));
    insert into everwake.customer_addresses as a
      (tenant_id, customer_id, fingerprint, governorate, city, area, street, building, floor, apartment, landmark,
       notes, lat, lng, maps_url, zone_id, branch_id, address_text)
    values (v_tenant, o.customer_id, v_fp, addr ->> 'governorate', addr ->> 'city', addr ->> 'area', addr ->> 'street',
            addr ->> 'building', addr ->> 'floor', addr ->> 'apartment', addr ->> 'landmark', addr ->> 'notes',
            (p -> 'location' ->> 'lat')::double precision, (p -> 'location' ->> 'lng')::double precision,
            p -> 'location' ->> 'maps_url', o.zone_id, o.branch_id, o.address_text)
    on conflict (customer_id, fingerprint) do update
      set use_count = a.use_count + 1, last_used_at = now(),
          lat = coalesce(excluded.lat, a.lat), lng = coalesce(excluded.lng, a.lng),
          maps_url = coalesce(excluded.maps_url, a.maps_url), zone_id = coalesce(excluded.zone_id, a.zone_id),
          landmark = coalesce(excluded.landmark, a.landmark), address_text = excluded.address_text
    returning id into v_addr;
  end if;

  -- nothing can be placed twice from one summary
  update everwake.conversations s
     set state = coalesce(s.state, '{}'::jsonb)
                 || jsonb_build_object('ledger',
                      coalesce(s.state -> 'ledger', '{}'::jsonb)
                      || jsonb_build_object('review_hash', null, 'pending_items', '[]'::jsonb, 'cart_log', '[]'::jsonb,
                                            'promo_codes', '[]'::jsonb,
                                            'last_order', jsonb_build_object('order_no', v_no, 'at', now(),
                                                                             'total', o.total, 'branch_id', o.branch_id)))
   where s.tenant_id = v_tenant and s.wa_id = v_wa;

  return jsonb_build_object('ok', true, 'order_no', v_no, 'order_id', o.id, 'total', o.total, 'address_id', v_addr);
end $$;

-- the new-order ticket for the branch's WhatsApp
create or replace function everwake.order_ticket(p_tenant uuid, p_order_no text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'order_no', o.order_no, 'placed_at', o.placed_at, 'branch_id', o.branch_id,
    'branch_name', b.name_ar, 'vat_percent', b.vat_percent, 'customer', o.customer,
    'delivery_method', o.delivery_method, 'payment_method', o.payment_method, 'address_text', o.address_text,
    'location', o.location, 'notes', o.notes, 'cart', o.cart, 'subtotal', o.subtotal, 'discount_total', o.discount_total,
    'applied_offers', o.applied_offers, 'vat', o.vat, 'delivery_fee', o.delivery_fee, 'total', o.total,
    'currency', o.currency, 'currency_symbol', t.currency_symbol_ar, 'wa_id', o.wa_id, 'zone_name', z.name_ar,
    'send_ticket', coalesce((everwake.merged_settings(t.settings) ->> 'send_order_ticket')::boolean, true),
    'ops_whatsapp', coalesce(nullif(b.ops_whatsapp, ''), nullif(everwake.merged_settings(t.settings) ->> 'ops_whatsapp', '')))
  from everwake.orders o
  join everwake.tenants t on t.id = o.tenant_id
  left join everwake.branches b on b.id = o.branch_id
  left join everwake.delivery_zones z on z.id = o.zone_id
  where o.tenant_id = p_tenant and o.order_no = p_order_no
$$;

-- ---------------------------------------------------------------------
-- save_customer_details helpers
-- ---------------------------------------------------------------------
create or replace function everwake.details_context(p_tenant uuid, p_wa text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'state', coalesce((select state from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa), '{}'::jsonb),
    'settings', everwake.merged_settings((select settings from everwake.tenants where id = p_tenant)),
    'saved_addresses', coalesce((
       select jsonb_agg(to_jsonb(a) order by a.last_used_at desc)
         from everwake.customer_addresses a
         join everwake.conversations c on c.customer_id = a.customer_id
        where c.tenant_id = p_tenant and c.wa_id = p_wa), '[]'::jsonb),
    'zones_drawn', exists (select 1 from everwake.delivery_zones where tenant_id = p_tenant and is_active),
    -- each branch takes its own payment methods (012)
    'payment_methods_by_branch', coalesce((
       select jsonb_object_agg(b ->> 'id', b -> 'payment_methods')
         from everwake.menu_snapshot s, jsonb_array_elements(s.lookup -> 'branches') b
        where s.tenant_id = p_tenant and s.scope = 'all'), '{}'::jsonb))
$$;

create or replace function everwake.persist_details(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_phone  text := nullif(everwake.digits(p ->> 'link_phone'), '');
  v_cust   bigint;
  v_other  bigint;
  v_area   jsonb;
  v_patch  jsonb := coalesce(p -> 'state_patch', '{}'::jsonb);
  v_zone   jsonb;
  st       jsonb;
begin
  select customer_id, state into v_cust, st from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa for update;

  -- a typed area: which delivery zone is that? (a pin, when shared, wins)
  if nullif(p ->> 'area_text', '') is not null
     and (coalesce((p ->> 'address_reset')::boolean, false) or coalesce(st -> 'zone' ->> 'source', '') <> 'pin') then
    v_area := everwake.match_area(v_tenant, p ->> 'area_text');
    if jsonb_array_length(v_area -> 'matches') > 0 and (v_area ->> 'branches')::int = 1 then
      v_zone := (v_area -> 'matches' -> 0);
      v_patch := v_patch || jsonb_build_object('zone', jsonb_build_object(
        'id', v_zone ->> 'zone_id', 'name', v_zone ->> 'zone_name', 'branch_id', v_zone ->> 'branch_id',
        'branch_code', v_zone ->> 'branch_code', 'branch_name', v_zone ->> 'branch_name',
        'delivery_fee', v_zone -> 'delivery_fee', 'min_order', v_zone -> 'min_order',
        'eta_min', v_zone -> 'eta_min', 'eta_max', v_zone -> 'eta_max', 'branch_state', v_zone ->> 'branch_state',
        'source', 'area_name', 'matched', v_zone ->> 'matched', 'at', now()));
    elsif coalesce((p ->> 'address_reset')::boolean, false) then
      v_patch := v_patch || jsonb_build_object('zone', null);
    end if;
  end if;

  -- a saved address chosen again: its zone comes with it
  if nullif(p ->> 'zone_id', '') is not null then
    select jsonb_build_object('id', z.id, 'name', z.name_ar, 'branch_id', b.id, 'branch_code', b.code, 'branch_name', b.name_ar,
                              'delivery_fee', coalesce(z.delivery_fee, b.delivery_fee), 'min_order', coalesce(z.min_order, b.min_order),
                              'eta_min', z.eta_min, 'eta_max', z.eta_max, 'branch_state', everwake.branch_state(b.id),
                              'source', 'saved_address', 'at', now())
      into v_zone
      from everwake.delivery_zones z join everwake.branches b on b.id = z.branch_id
     where z.id = (p ->> 'zone_id')::uuid and z.tenant_id = v_tenant and z.is_active and b.is_active;
    if v_zone is not null then
      v_patch := v_patch || jsonb_build_object('zone', v_zone);
    end if;
  end if;

  -- a number typed for the order: remember it as theirs (so a customer
  -- hidden behind a WhatsApp private id is found by it next time)
  if v_phone is not null and v_cust is not null then
    select customer_id into v_other from everwake.customer_identities
     where tenant_id = v_tenant and kind = 'phone' and value = v_phone;
    if v_other is null then
      insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
      values (v_tenant, 'phone', v_phone, v_cust) on conflict do nothing;
    elsif v_other <> v_cust then
      v_patch := v_patch || jsonb_build_object('contact', coalesce(st -> 'contact', '{}'::jsonb)
                                                || jsonb_build_object('linked_customer_id', v_other));
    end if;
  end if;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || (v_patch - 'ledger')
                 || jsonb_build_object('ledger', coalesce(c.state -> 'ledger', '{}'::jsonb) || coalesce(p -> 'ledger_patch', '{}'::jsonb))
   where c.tenant_id = v_tenant and c.wa_id = v_wa
  returning c.state into st;

  return jsonb_build_object('state', st, 'area_match', v_area);
end $$;

-- the pictures that go with a reply: the branch's menu pages (or the
-- restaurant's, when the branch has none) and the photos of dishes asked for
create or replace function everwake.reply_media(p jsonb)
returns jsonb language sql stable as $$
  with pages as (
    select m.kind, m.url, m.mime, m.file_name, m.caption, m.position
      from everwake.menu_media m
     where m.tenant_id = (p ->> 'tenant_id')::uuid and m.is_active
       and coalesce((p ->> 'send_menu')::boolean, false)
       and (m.branch_id::text = p ->> 'branch_id'
            or (m.branch_id is null and not exists (
                  select 1 from everwake.menu_media x
                   where x.tenant_id = m.tenant_id and x.is_active and x.branch_id::text = p ->> 'branch_id')))
     order by m.position
     limit 10
  ), photos as (
    select distinct on (i.code) i.code, i.name_ar, im.url, im.mime, coalesce(mib.price, i.price) as price, i.unit, x.ord
      from jsonb_array_elements_text(coalesce(p -> 'item_codes', '[]'::jsonb)) with ordinality x(code, ord)
      join everwake.menu_items i on i.tenant_id = (p ->> 'tenant_id')::uuid and i.code = upper(x.code) and i.is_active
      join everwake.item_media im on im.item_id = i.id
      left join everwake.menu_item_branches mib on mib.item_id = i.id and mib.branch_id::text = p ->> 'branch_id'
     order by i.code, im.is_primary desc, im.sort
  )
  select jsonb_build_object(
    'menu_pages', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'url', url, 'mime', mime,
                                                                'file_name', file_name, 'caption', caption) order by position) from pages), '[]'::jsonb),
    'item_photos', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name_ar, 'url', url, 'mime', mime,
                                                                 'price', price, 'unit', unit) order by ord) from (select * from photos limit 3) ph), '[]'::jsonb))
$$;

-- ================= 005_operations.sql =================
-- =====================================================================
-- Everwake Orders · 005 · operations
--
-- What the restaurant does from the dashboard, and what the system
-- sends on its behalf:
--   · the agent ON / OFF switch, and the "we're back" message to everyone
--     who wrote while it was off
--   · taking over a conversation, replying, handing it back
--   · moving an order along the board (the customer hears each step)
--   · out-of-stock and busy switches
--   · the outbox every one of those messages goes through
--   · housekeeping (idle takeovers, stuck locks, expired snapshots)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who may do what. Dashboard users carry a JWT with their user id; the
-- n8n engine and maintenance scripts connect as a database role with no
-- user and are trusted (anon never gets EXECUTE — see 007).
-- ---------------------------------------------------------------------
create or replace function everwake.member_role(p_tenant uuid)
returns text language sql stable security definer set search_path = everwake, pg_temp as $$
  select case
    when everwake.current_user_id() is null then null
    when exists (select 1 from everwake.platform_admins a where a.user_id = everwake.current_user_id()) then 'owner'
    else (select m.role from everwake.tenant_members m
           where m.tenant_id = p_tenant and m.user_id = everwake.current_user_id())
  end
$$;

create or replace function everwake.is_platform_admin()
returns boolean language sql stable security definer set search_path = everwake, pg_temp as $$
  select exists (select 1 from everwake.platform_admins a where a.user_id = everwake.current_user_id())
$$;

create or replace function everwake.require_role(p_tenant uuid, p_roles text[])
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare r text;
begin
  if everwake.current_user_id() is null then
    return 'system';
  end if;
  r := everwake.member_role(p_tenant);
  if r is null or not (r = any(p_roles)) then
    raise exception 'not allowed for this restaurant' using errcode = '42501';
  end if;
  return r;
end $$;

-- branch-scoped staff see only their branches' orders
create or replace function everwake.can_see_branch(p_tenant uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = everwake, pg_temp as $$
  select everwake.is_platform_admin()
      or exists (select 1 from everwake.tenant_members m
                  where m.tenant_id = p_tenant and m.user_id = everwake.current_user_id()
                    and (m.branch_ids is null or p_branch is null or p_branch = any(m.branch_ids)))
$$;

create or replace function everwake.customer_language(p_tenant uuid, p_wa text)
returns text language sql stable as $$
  select coalesce(nullif(c.state ->> 'last_language', ''), cu.language, t.default_language, 'ar')
    from everwake.tenants t
    left join everwake.conversations c on c.tenant_id = t.id and c.wa_id = p_wa
    left join everwake.customers cu on cu.id = c.customer_id
   where t.id = p_tenant
$$;

-- ---------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------
create or replace function everwake.queue_customer_message(
  p_tenant uuid, p_wa text, p_purpose text, p_body text,
  p_kind text default 'text', p_media_url text default null, p_media_mime text default null,
  p_file_name text default null, p_sender text default 'system', p_user uuid default null,
  p_not_before timestamptz default now())
returns jsonb language plpgsql as $$
declare
  conv  everwake.conversations%rowtype;
  cust  everwake.customers%rowtype;
  v_ch  uuid;
  v_to  text;
  v_msg bigint;
  v_out bigint;
begin
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  if not found then
    raise exception 'no conversation with % for this restaurant', p_wa;
  end if;
  select * into cust from everwake.customers where id = conv.customer_id;
  select ch.id into v_ch
    from everwake.whatsapp_channels ch
   where ch.tenant_id = p_tenant and ch.is_active
   order by (ch.id::text = conv.state -> 'contact' ->> 'channel_id') desc, ch.created_at
   limit 1;
  v_to := coalesce(nullif(conv.state -> 'contact' ->> 'reply_to', ''), cust.reply_to, p_wa);

  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, staff_user_id, kind, body,
                                 media_url, media_mime, status, meta)
  values (p_tenant, conv.id, p_wa, 'outbound', p_sender, p_user, p_kind, p_body, p_media_url, p_media_mime, 'queued',
          jsonb_build_object('purpose', p_purpose))
  returning id into v_msg;

  insert into everwake.outbox (tenant_id, channel_id, to_jid, wa_id, message_id, purpose, kind, body, media_url,
                               media_mime, file_name, not_before, created_by)
  values (p_tenant, v_ch, v_to, p_wa, v_msg, p_purpose, p_kind, p_body, p_media_url, p_media_mime, p_file_name,
          p_not_before, p_user)
  returning id into v_out;

  update everwake.conversations
     set last_message_at = now(),
         last_message_preview = left(coalesce(p_body, '[' || p_kind || ']'), 160)
   where id = conv.id;
  return jsonb_build_object('outbox_id', v_out, 'message_id', v_msg);
end $$;

-- the sender (n8n "Everwake — Outbox") takes a batch; nobody else gets the same rows
create or replace function everwake.outbox_claim(p_limit int default 20, p_worker text default 'n8n')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  -- nothing to send with: fail fast so the dashboard shows why
  update everwake.outbox o
     set status = 'failed', last_error = 'No WhatsApp number is connected for this restaurant.'
   where o.status = 'queued' and o.not_before <= now()
     and not exists (select 1 from everwake.whatsapp_channels ch where ch.id = o.channel_id and ch.is_active);
  update everwake.messages m set status = 'failed', error = 'No WhatsApp number is connected.'
    from everwake.outbox o
   where o.message_id = m.id and o.status = 'failed' and m.status = 'queued';

  with c as (
    select o.id from everwake.outbox o
     where o.status = 'queued' and o.not_before <= now()
     order by o.not_before, o.id
     for update skip locked
     limit greatest(1, least(p_limit, 100))
  ), u as (
    update everwake.outbox o
       set status = 'sending', claimed_at = now(), claimed_by = p_worker, attempts = o.attempts + 1
      from c where o.id = c.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'tenant_id', u.tenant_id, 'wa_id', u.wa_id, 'to', u.to_jid, 'purpose', u.purpose,
           'kind', u.kind, 'body', u.body, 'media_url', u.media_url, 'media_mime', u.media_mime,
           'file_name', u.file_name, 'attempts', u.attempts,
           'channel', jsonb_build_object('id', ch.id, 'provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                         'instance', ch.instance_name, 'api_key', ch.api_key))
         order by u.id), '[]'::jsonb)
    into v
    from u join everwake.whatsapp_channels ch on ch.id = u.channel_id;

  update everwake.messages m set status = 'sending'
    from everwake.outbox o
   where o.message_id = m.id and o.status = 'sending' and m.status = 'queued';
  return v;
end $$;

create or replace function everwake.outbox_result(p jsonb)
returns jsonb language plpgsql as $$
declare
  o     everwake.outbox%rowtype;
  v_ok  boolean := coalesce((p ->> 'ok')::boolean, false);
  v_fin boolean;
begin
  select * into o from everwake.outbox where id = (p ->> 'id')::bigint for update;
  if not found then return jsonb_build_object('updated', false); end if;
  v_fin := v_ok or o.attempts >= 3;

  update everwake.outbox
     set status = case when v_ok then 'sent' when v_fin then 'failed' else 'queued' end,
         sent_at = case when v_ok then now() end,
         external_id = nullif(p ->> 'external_id', ''),
         last_error = case when v_ok then null else left(coalesce(p ->> 'error', 'send failed'), 500) end,
         not_before = case when v_ok or v_fin then not_before else now() + make_interval(secs => 30 * o.attempts) end
   where id = o.id;

  if o.message_id is not null then
    update everwake.messages
       set status = case when v_ok then 'sent' when v_fin then 'failed' else 'queued' end,
           external_id = coalesce(nullif(p ->> 'external_id', ''), external_id),
           sent_at = case when v_ok then now() else sent_at end,
           error = case when v_ok then null else left(coalesce(p ->> 'error', 'send failed'), 500) end
     where id = o.message_id
       -- a duplicate external id would violate the unique index: keep the row, drop the id
       and not exists (select 1 from everwake.messages x
                        where x.tenant_id = o.tenant_id and x.external_id = nullif(p ->> 'external_id', '')
                          and x.id <> o.message_id);
  end if;
  if v_ok and o.wa_id is not null then
    update everwake.conversations set last_outbound_at = now()
     where tenant_id = o.tenant_id and wa_id = o.wa_id;
  end if;
  return jsonb_build_object('updated', true, 'final', v_fin, 'ok', v_ok);
end $$;

-- ---------------------------------------------------------------------
-- The agent switch
-- OFF: every new customer gets one warm apology and is remembered.
-- ON:  everyone remembered gets a "we're back" message (staggered, so
--      WhatsApp never sees a burst), unless the restaurant says not to.
-- ---------------------------------------------------------------------
create or replace function everwake.set_agent_enabled(p_tenant uuid, p_enabled boolean,
                                                       p_reason text default null, p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  t       everwake.tenants%rowtype;
  s       jsonb;
  v_pause bigint;
  pc      record;
  n       int := 0;
  v_lang  text;
  v_body  text;
  v_uid   uuid := everwake.current_user_id();
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  select * into t from everwake.tenants where id = p_tenant for update;
  s := everwake.merged_settings(t.settings);

  if not p_enabled then
    if not t.agent_enabled then
      return jsonb_build_object('agent_enabled', false, 'pause_id', t.current_pause_id, 'changed', false);
    end if;
    insert into everwake.agent_pauses (tenant_id, started_by, reason, notify_on_resume)
    values (p_tenant, v_uid, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_notify, true))
    returning id into v_pause;
    update everwake.tenants set agent_enabled = false, current_pause_id = v_pause where id = p_tenant;
    insert into everwake.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
    values (p_tenant, v_uid, 'agent_off', 'tenants', p_tenant::text, jsonb_build_object('reason', p_reason));
    return jsonb_build_object('agent_enabled', false, 'pause_id', v_pause, 'changed', true);
  end if;

  if t.agent_enabled then
    return jsonb_build_object('agent_enabled', true, 'changed', false, 'notified', 0);
  end if;
  v_pause := t.current_pause_id;
  update everwake.agent_pauses set ended_at = now(), ended_by = v_uid where id = v_pause;
  update everwake.tenants set agent_enabled = true, current_pause_id = null where id = p_tenant;

  if coalesce(p_notify, true) and v_pause is not null then
    for pc in
      select x.*, cu.full_name, cu.display_name
        from everwake.pause_contacts x
        left join everwake.customers cu on cu.id = x.customer_id
       where x.pause_id = v_pause and x.resume_notified_at is null and not coalesce(cu.is_blocked, false)
       order by x.first_message_at
    loop
      v_lang := everwake.customer_language(p_tenant, pc.wa_id);
      v_body := everwake.render_template(s -> 'templates' ->> ('resume_notice_' || v_lang),
                                         jsonb_build_object('name', everwake.first_name(pc.full_name, pc.display_name)));
      perform everwake.queue_customer_message(p_tenant, pc.wa_id, 'resume_notice', v_body,
                                              p_not_before => now() + make_interval(secs => n * 3));
      update everwake.pause_contacts set resume_notified_at = now() where pause_id = v_pause and wa_id = pc.wa_id;
      n := n + 1;
    end loop;
  end if;
  update everwake.agent_pauses set notified_count = n where id = v_pause;
  insert into everwake.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (p_tenant, v_uid, 'agent_on', 'tenants', p_tenant::text, jsonb_build_object('notified', n, 'pause_id', v_pause));
  return jsonb_build_object('agent_enabled', true, 'changed', true, 'notified', n, 'pause_id', v_pause);
end $$;

-- how many people are waiting for the "we're back" message
create or replace function everwake.pause_status(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select jsonb_build_object(
    'agent_enabled', t.agent_enabled,
    'pause', case when t.current_pause_id is null then null else (
       select jsonb_build_object('id', ap.id, 'started_at', ap.started_at, 'reason', ap.reason,
                                 'waiting', (select count(*) from everwake.pause_contacts pc
                                              where pc.pause_id = ap.id and pc.resume_notified_at is null))
         from everwake.agent_pauses ap where ap.id = t.current_pause_id) end)
  from everwake.tenants t
  where t.id = p_tenant and everwake.member_role(p_tenant) is not null
$$;

-- ---------------------------------------------------------------------
-- Take over · reply · hand back
-- ---------------------------------------------------------------------
create or replace function everwake.take_over(p_conversation bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c everwake.conversations%rowtype;
begin
  select * into c from everwake.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.conversations
     set mode = 'human', assigned_user_id = coalesce(everwake.current_user_id(), assigned_user_id),
         human_since = coalesce(human_since, now()), human_last_activity_at = now(),
         human_reason = coalesce(nullif(p_reason, ''), human_reason, 'taken over from the dashboard'),
         needs_attention = false
   where id = c.id
  returning * into c;
  -- an agent turn already running for this chat will see the mode and stay quiet
  delete from everwake.inbound_buffer where tenant_id = c.tenant_id and wa_id = c.wa_id and claimed_by_run_id is null;
  return jsonb_build_object('mode', c.mode, 'human_since', c.human_since);
end $$;

create or replace function everwake.hand_back(p_conversation bigint)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c everwake.conversations%rowtype;
begin
  select * into c from everwake.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.conversations
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null,
         state = state || jsonb_build_object('handback', jsonb_build_object(
                   'at', now(), 'by', coalesce(everwake.current_user_id()::text, 'system'), 'human_since', c.human_since)),
         human_since = null
   where id = c.id
  returning * into c;
  return jsonb_build_object('mode', c.mode);
end $$;

create or replace function everwake.send_staff_message(p_conversation bigint, p_body text, p_kind text default 'text',
                                                        p_media_url text default null, p_media_mime text default null,
                                                        p_file_name text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  c everwake.conversations%rowtype;
  r jsonb;
begin
  select * into c from everwake.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  if coalesce(btrim(p_body), '') = '' and p_media_url is null then
    raise exception 'empty message';
  end if;
  -- writing to the customer means a person has this conversation now
  update everwake.conversations
     set mode = 'human', assigned_user_id = coalesce(assigned_user_id, everwake.current_user_id()),
         human_since = coalesce(human_since, now()), human_last_activity_at = now(),
         human_reason = coalesce(human_reason, 'replied from the dashboard'),
         needs_attention = false, unread_count = 0
   where id = c.id;
  delete from everwake.inbound_buffer where tenant_id = c.tenant_id and wa_id = c.wa_id and claimed_by_run_id is null;
  r := everwake.queue_customer_message(c.tenant_id, c.wa_id, 'staff_reply', nullif(btrim(p_body), ''),
                                       coalesce(p_kind, 'text'), p_media_url, p_media_mime, p_file_name,
                                       'staff', everwake.current_user_id());
  return r;
end $$;

create or replace function everwake.mark_read(p_conversation bigint)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.conversations where id = p_conversation;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  update everwake.conversations set unread_count = 0 where id = p_conversation;
end $$;

create or replace function everwake.resolve_attention(p_conversation bigint)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.conversations where id = p_conversation;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  update everwake.conversations set needs_attention = false, attention_reason = null where id = p_conversation;
end $$;

-- ---------------------------------------------------------------------
-- The order board
-- placed → accepted → preparing → ready / out_for_delivery → delivered | picked_up
-- placed / accepted / preparing / ready / out_for_delivery → rejected | cancelled
-- ---------------------------------------------------------------------
create or replace function everwake.set_order_status(p_order bigint, p_status text, p_note text default null,
                                                      p_notify boolean default true, p_eta text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  o       everwake.orders%rowtype;
  t       everwake.tenants%rowtype;
  s       jsonb;
  v_rank  jsonb := '{"placed":1,"accepted":2,"preparing":3,"ready":4,"out_for_delivery":5,"delivered":6,"picked_up":6}';
  v_lang  text;
  v_tpl   text;
  v_body  text;
  v_sent  boolean := false;
  v_bname text;
  v_line  text;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if p_status not in ('accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'picked_up', 'rejected', 'cancelled') then
    raise exception 'unknown status %', p_status;
  end if;
  if o.status in ('draft', 'delivered', 'picked_up', 'rejected', 'cancelled') then
    raise exception 'this order is % and cannot change', o.status;
  end if;
  if p_status not in ('rejected', 'cancelled') and (v_rank ->> p_status)::int <= (v_rank ->> o.status)::int then
    raise exception 'the order is already %', o.status;
  end if;

  update everwake.orders
     set status = p_status,
         accepted_at = case when p_status in ('accepted', 'preparing') then coalesce(accepted_at, now()) else accepted_at end,
         ready_at = case when p_status = 'ready' then now() else ready_at end,
         out_for_delivery_at = case when p_status = 'out_for_delivery' then now() else out_for_delivery_at end,
         completed_at = case when p_status in ('delivered', 'picked_up') then now() else completed_at end,
         cancelled_at = case when p_status in ('rejected', 'cancelled') then now() else cancelled_at end,
         reject_reason = case when p_status in ('rejected', 'cancelled') then nullif(btrim(coalesce(p_note, '')), '') else reject_reason end,
         eta_text = coalesce(nullif(btrim(coalesce(p_eta, '')), ''), eta_text)
   where id = o.id
  returning * into o;

  -- a rejected / cancelled order is not money the customer spent
  if p_status in ('rejected', 'cancelled') and o.customer_id is not null then
    update everwake.customers
       set orders_count = greatest(0, orders_count - 1), total_spent = greatest(0, total_spent - coalesce(o.total, 0))
     where id = o.customer_id;
  end if;

  select * into t from everwake.tenants where id = o.tenant_id;
  s := everwake.merged_settings(t.settings);
  if coalesce(p_notify, true) then
    v_lang := everwake.customer_language(o.tenant_id, o.wa_id);
    v_tpl := s -> 'templates' ->> ('status_' || p_status || '_' || v_lang);
    -- on its way with one of the restaurant's drivers: their name, number and how far
    if p_status = 'out_for_delivery' then v_line := everwake.driver_line(o, v_lang); end if;
    if nullif(btrim(coalesce(v_tpl, '')), '') is not null or v_line is not null then
      select case when v_lang = 'en' then coalesce(nullif(name_en, ''), name_ar) else name_ar end
        into v_bname from everwake.branches where id = o.branch_id;
      v_body := everwake.render_template(v_tpl, jsonb_build_object(
        'order_no', o.order_no,
        'branch', coalesce(v_bname, ''),
        'eta', case when o.eta_text is null then ''
                    when v_lang = 'en' then ' Expected in about ' || o.eta_text || '.'
                    else ' الوقت المتوقع حوالي ' || o.eta_text || '.' end,
        'reason', case when nullif(btrim(coalesce(p_note, '')), '') is null then ''
                       when v_lang = 'en' then ' ' || btrim(p_note) || '.'
                       else ' ' || btrim(p_note) || '.' end,
        'name', ''));
      v_body := concat_ws(E'\n', nullif(btrim(coalesce(v_body, '')), ''), v_line);
      perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status', v_body,
                                              p_user => everwake.current_user_id());
      v_sent := true;
    end if;
  end if;

  insert into everwake.order_events (tenant_id, order_id, status, note, by_user, by_role, notified)
  values (o.tenant_id, o.id, p_status, nullif(btrim(coalesce(p_note, '')), ''), everwake.current_user_id(),
          case when everwake.current_user_id() is null then 'system' else 'staff' end, v_sent);
  return jsonb_build_object('order_id', o.id, 'status', o.status, 'notified', v_sent);
end $$;

-- ---------------------------------------------------------------------
-- Stock and busy switches (any team member — it is a floor decision)
-- available=false, until=null  → off until switched back on
-- available=false, until=X     → off until X, then back by itself
-- ---------------------------------------------------------------------
create or replace function everwake.set_item_availability(p_item uuid, p_available boolean,
                                                           p_branch uuid default null, p_until timestamptz default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.menu_items where id = p_item;
  if v_tenant is null then raise exception 'item not found'; end if;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  if p_branch is null then
    update everwake.menu_items
       set is_available = p_available or p_until is not null,
           sold_out_until = case when p_available then null else p_until end
     where id = p_item;
    -- back on everywhere means every branch too
    if p_available then
      update everwake.menu_item_branches
         set is_available = true, sold_out_until = null, updated_at = now()
       where item_id = p_item and (not is_available or sold_out_until is not null);
    end if;
  else
    insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, is_available, sold_out_until)
    values (v_tenant, p_item, p_branch, p_available or p_until is not null, case when p_available then null else p_until end)
    on conflict (item_id, branch_id) do update
      set is_available = excluded.is_available, sold_out_until = excluded.sold_out_until, updated_at = now();
  end if;
  return jsonb_build_object('item_id', p_item, 'branch_id', p_branch, 'available', p_available, 'until', p_until);
end $$;

create or replace function everwake.set_option_availability(p_option uuid, p_available boolean)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.menu_options where id = p_option;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  update everwake.menu_options set is_available = p_available where id = p_option;
end $$;

create or replace function everwake.set_branch_busy(p_branch uuid, p_minutes int, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare b everwake.branches%rowtype;
begin
  select * into b from everwake.branches where id = p_branch;
  if not found then raise exception 'branch not found'; end if;
  perform everwake.require_role(b.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.branches
     set busy_until = case when coalesce(p_minutes, 0) > 0 then now() + make_interval(mins => p_minutes) end,
         busy_reason = case when coalesce(p_minutes, 0) > 0 then nullif(btrim(coalesce(p_reason, '')), '') end
   where id = p_branch
  returning * into b;
  return jsonb_build_object('branch_id', b.id, 'busy_until', b.busy_until);
end $$;

create or replace function everwake.set_branch_accepting(p_branch uuid, p_accepting boolean)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare b everwake.branches%rowtype;
begin
  select * into b from everwake.branches where id = p_branch;
  if not found then raise exception 'branch not found'; end if;
  perform everwake.require_role(b.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.branches set accepting_orders = p_accepting, busy_until = null where id = p_branch returning * into b;
  return jsonb_build_object('branch_id', b.id, 'accepting_orders', b.accepting_orders);
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping (every minute, from the n8n outbox workflow)
-- ---------------------------------------------------------------------
create or replace function everwake.housekeeping()
returns jsonb language plpgsql as $$
declare
  n_release int; n_locks int; n_stuck int; n_buf int; n_snap int := 0; n_busy int; n_rep int; n_pay int;
  r record;
begin
  -- a takeover nobody touched for a while goes back to the agent
  with idle as (
    select c.id, c.human_since
      from everwake.conversations c
      join everwake.tenants t on t.id = c.tenant_id
     where c.mode = 'human'
       and coalesce((everwake.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int, 0) > 0
       and coalesce(c.human_last_activity_at, c.human_since, c.updated_at)
           < now() - make_interval(mins => (everwake.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int)
  )
  update everwake.conversations c
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null, human_since = null,
         state = c.state || jsonb_build_object('handback', jsonb_build_object('at', now(), 'by', 'auto', 'human_since', idle.human_since))
    from idle where c.id = idle.id;
  get diagnostics n_release = row_count;

  delete from everwake.conversation_locks where expires_at < now() - interval '1 minute';
  get diagnostics n_locks = row_count;

  update everwake.outbox set status = 'queued', not_before = now()
   where status = 'sending' and claimed_at < now() - interval '5 minutes';
  get diagnostics n_stuck = row_count;

  delete from everwake.inbound_buffer
   where (claimed_by_run_id is not null and received_at < now() - interval '1 hour')
      or (claimed_by_run_id is null and received_at < now() - interval '15 minutes');
  get diagnostics n_buf = row_count;

  update everwake.branches set busy_until = null, busy_reason = null where busy_until < now();
  get diagnostics n_busy = row_count;

  for r in select s.tenant_id from everwake.menu_snapshot s
            where s.scope = 'all' and s.valid_until is not null and s.valid_until <= now() loop
    perform everwake.rebuild_snapshot(r.tenant_id, false);
    n_snap := n_snap + 1;
  end loop;

  -- each restaurant's daily report on the owner's WhatsApp, at its hour (009)
  n_rep := everwake.send_due_reports();

  -- online payments: one reminder, then the link expires and the branch is told (011)
  n_pay := everwake.payment_due();

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'busy_cleared', n_busy, 'snapshots_rebuilt', n_snap,
                            'reports_queued', n_rep, 'payments_due', n_pay);
end $$;

-- ================= 006_dashboard.sql =================
-- =====================================================================
-- Everwake Orders · 006 · dashboard
--
-- Signing a restaurant up, its go-live checklist, publishing a menu the
-- AI read from a PDF / photo / link, the reports, the WhatsApp number
-- and the team. Every function checks the caller's role first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A restaurant's own schema: r_<slug>, with a read-only view per table
-- holding only its rows. Open it in any database client and it looks
-- like the old one-schema-per-brand setup (r_bazooka.orders, …) — while
-- the engine keeps one set of tables and one migration path.
-- ---------------------------------------------------------------------
create or replace function everwake.provision_tenant_views(p_tenant uuid)
returns text language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_slug   text;
  v_schema text;
  v        text;
  tables   text[] := array['branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_option_groups',
                           'menu_options', 'menu_item_branches', 'item_media', 'menu_media', 'menu_imports', 'offers',
                           'knowledge_entries', 'customers', 'customer_identities', 'customer_addresses', 'conversations',
                           'messages', 'outbox', 'inbound_buffer', 'conversation_locks', 'orders', 'order_items',
                           'order_events', 'agent_pauses', 'pause_contacts', 'agent_events', 'menu_snapshot', 'audit_log'];
begin
  select slug into v_slug from everwake.tenants where id = p_tenant;
  if v_slug is null then raise exception 'restaurant not found'; end if;
  v_schema := 'r_' || v_slug;
  execute format('create schema if not exists %I', v_schema);
  execute format('revoke all on schema %I from public', v_schema);
  foreach v in array tables loop
    execute format('create or replace view %I.%I with (security_barrier = true) as select * from everwake.%I where tenant_id = %L',
                   v_schema, v, v, p_tenant);
  end loop;
  -- the familiar names
  execute format('create or replace view %I.conversation_state with (security_barrier = true) as
                    select wa_id as whatsapp_number, state, mode, updated_at from everwake.conversations where tenant_id = %L',
                 v_schema, p_tenant);
  execute format('create or replace view %I.settings with (security_barrier = true) as
                    select s.key, s.value from everwake.tenants t, jsonb_each(everwake.merged_settings(t.settings)) s where t.id = %L',
                 v_schema, p_tenant);
  execute format('create or replace view %I.whatsapp_channels with (security_barrier = true) as
                    select id, provider, label, phone_number, instance_name, base_url, default_branch_id, status, is_active,
                           last_inbound_at, connected_at, created_at from everwake.whatsapp_channels where tenant_id = %L',
                 v_schema, p_tenant);
  return v_schema;
end $$;

-- after a migration adds columns, the views are re-created to show them
create or replace function everwake.refresh_tenant_views()
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id, slug from everwake.tenants loop
    execute format('drop schema if exists %I cascade', 'r_' || r.slug);
    perform everwake.provision_tenant_views(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function everwake.slugify(p text)
returns text language sql immutable as $$
  select left(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'),
                                            '^_+|_+$', '', 'g'), '^([0-9])', 'r\1'), 40)
$$;

create or replace function everwake.currency_symbol(p_currency text)
returns text language sql immutable as $$
  select case upper(p_currency)
    when 'EGP' then 'ج' when 'SAR' then 'ر.س' when 'AED' then 'د.إ' when 'QAR' then 'ر.ق'
    when 'KWD' then 'د.ك' when 'BHD' then 'د.ب' when 'OMR' then 'ر.ع' when 'JOD' then 'د.أ'
    when 'USD' then '$' when 'EUR' then '€' else upper(p_currency) end
$$;

-- ---------------------------------------------------------------------
-- Sign a restaurant up. The caller becomes its owner.
-- ---------------------------------------------------------------------
create or replace function everwake.create_tenant(p_name_ar text, p_name_en text, p_slug text default null,
                                                  p_country text default 'EG', p_timezone text default 'Africa/Cairo',
                                                  p_currency text default 'EGP', p_language text default 'ar')
returns uuid language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_uid   uuid := everwake.current_user_id();
  v_slug  text;
  v_base  text;
  v_i     int := 1;
  v_id    uuid;
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
begin
  if coalesce(btrim(p_name_ar), '') = '' and coalesce(btrim(p_name_en), '') = '' then
    raise exception 'the restaurant needs a name';
  end if;
  v_base := coalesce(nullif(everwake.slugify(p_slug), ''), nullif(everwake.slugify(p_name_en), ''),
                     'restaurant_' || substr(md5(random()::text), 1, 6));
  if length(v_base) < 2 or v_base !~ '^[a-z]' then v_base := 'r_' || v_base; end if;
  v_slug := v_base;
  while exists (select 1 from everwake.tenants where slug = v_slug) loop
    v_i := v_i + 1;
    v_slug := left(v_base, 36) || '_' || v_i;
  end loop;

  insert into everwake.tenants (slug, name_ar, name_en, country, timezone, currency, currency_symbol_ar,
                                default_language, order_no_prefix, profile)
  values (v_slug, coalesce(nullif(btrim(p_name_ar), ''), btrim(p_name_en)), coalesce(nullif(btrim(p_name_en), ''), btrim(p_name_ar)),
          upper(coalesce(p_country, 'EG')), coalesce(p_timezone, 'Africa/Cairo'), upper(coalesce(p_currency, 'EGP')),
          everwake.currency_symbol(coalesce(p_currency, 'EGP')), case when p_language = 'en' then 'en' else 'ar' end,
          coalesce(nullif(upper(left(regexp_replace(v_slug, '[^a-z]', '', 'g'), 3)), ''), 'EW'),
          jsonb_build_object('brand_facts', jsonb_build_array()))
  returning id into v_id;

  if v_uid is not null then
    insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
    values (v_id, v_uid, 'owner', v_email, split_part(coalesce(v_email, ''), '@', 1));
  end if;
  perform everwake.provision_tenant_views(v_id);
  perform everwake.rebuild_snapshot(v_id);
  return v_id;
end $$;

create or replace function everwake.my_tenants()
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'slug', t.slug, 'name_ar', t.name_ar, 'name_en', t.name_en, 'status', t.status,
           'agent_enabled', t.agent_enabled, 'currency', t.currency, 'currency_symbol', t.currency_symbol_ar,
           'timezone', t.timezone, 'default_language', t.default_language,
           'role', everwake.member_role(t.id)) order by t.name_en), '[]'::jsonb)
    from everwake.tenants t
   where everwake.member_role(t.id) is not null
$$;

-- ---------------------------------------------------------------------
-- What still stands between the restaurant and going live
-- ---------------------------------------------------------------------
create or replace function everwake.onboarding_checklist(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t   everwake.tenants%rowtype;
  s   jsonb;
  pr  jsonb;
  n_br int; n_br_ok int; n_br_deliv int; n_br_zoned int; n_items int; n_priced int; n_photos int;
  n_pages int; n_ch int; n_ch_ok int; n_test int; n_cat int; n_know int;
  items jsonb := '[]'::jsonb;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  pr := everwake.merged_profile(t.profile);

  select count(*), count(*) filter (where coalesce(address_ar, '') <> '' and hours <> '{}'::jsonb),
         count(*) filter (where delivery_enabled),
         count(*) filter (where delivery_enabled and (exists (select 1 from everwake.delivery_zones z where z.branch_id = b.id and z.is_active)
                                                     or (lat is not null and lng is not null)))
    into n_br, n_br_ok, n_br_deliv, n_br_zoned
    from everwake.branches b where b.tenant_id = p_tenant and b.is_active;
  select count(*), count(*) filter (where price is not null) into n_items, n_priced
    from everwake.menu_items where tenant_id = p_tenant and is_active;
  select count(*) into n_cat from everwake.menu_categories where tenant_id = p_tenant and is_active;
  select count(distinct i.id) into n_photos from everwake.menu_items i join everwake.item_media m on m.item_id = i.id
   where i.tenant_id = p_tenant and i.is_active;
  select count(*) into n_pages from everwake.menu_media where tenant_id = p_tenant and is_active;
  select count(*), count(*) filter (where status = 'connected') into n_ch, n_ch_ok
    from everwake.whatsapp_channels where tenant_id = p_tenant and is_active;
  select count(*) into n_test from everwake.orders where tenant_id = p_tenant and status <> 'draft';
  select count(*) into n_know from everwake.knowledge_entries where tenant_id = p_tenant and is_active;

  items := jsonb_build_array(
    jsonb_build_object('key', 'profile', 'label', 'Restaurant profile and the agent''s name', 'required', true,
                       'done', coalesce(pr ->> 'about_ar', '') <> '' or coalesce(pr ->> 'about_en', '') <> '',
                       'detail', 'Tell the agent what the restaurant is, its tone and its key facts.', 'href', 'settings/agent'),
    jsonb_build_object('key', 'branches', 'label', 'Branches with address and opening hours', 'required', true,
                       'done', n_br > 0 and n_br_ok = n_br,
                       'detail', n_br_ok || ' of ' || n_br || ' branches complete', 'href', 'branches'),
    jsonb_build_object('key', 'zones', 'label', 'Delivery zones', 'required', n_br_deliv > 0,
                       'done', n_br > 0 and (n_br_deliv = 0 or n_br_zoned = n_br_deliv),
                       'detail', n_br_zoned || ' of ' || n_br_deliv || ' delivering branches have a zone or a map pin', 'href', 'zones'),
    jsonb_build_object('key', 'menu', 'label', 'Menu with prices', 'required', true,
                       'done', n_cat > 0 and n_priced >= 3,
                       'detail', n_priced || ' of ' || n_items || ' dishes have a price', 'href', 'menu'),
    jsonb_build_object('key', 'photos', 'label', 'Dish photos', 'required', false,
                       'done', n_items > 0 and n_photos * 2 >= n_items,
                       'detail', n_photos || ' of ' || n_items || ' dishes have a photo', 'href', 'menu'),
    jsonb_build_object('key', 'menu_pages', 'label', 'Full menu pictures or PDF', 'required', false,
                       'done', n_pages > 0, 'detail', n_pages || ' pages', 'href', 'menu/pages'),
    jsonb_build_object('key', 'payment', 'label', 'Payment methods', 'required', true,
                       'done', jsonb_array_length(coalesce(s -> 'payment_methods', '[]'::jsonb)) > 0,
                       'detail', coalesce((select string_agg(x, ', ') from jsonb_array_elements_text(s -> 'payment_methods') x), ''),
                       'href', 'settings/ordering'),
    jsonb_build_object('key', 'knowledge', 'label', 'Answers to common questions', 'required', false,
                       'done', n_know > 0, 'detail', n_know || ' answers', 'href', 'settings/knowledge'),
    jsonb_build_object('key', 'whatsapp', 'label', 'WhatsApp number connected', 'required', true,
                       'done', n_ch_ok > 0, 'detail', n_ch_ok || ' of ' || n_ch || ' numbers connected', 'href', 'settings/whatsapp'),
    jsonb_build_object('key', 'test_order', 'label', 'A test order placed from a test number', 'required', false,
                       'done', n_test > 0, 'detail', n_test || ' orders so far', 'href', 'settings/ordering'));

  return jsonb_build_object(
    'status', t.status, 'live_at', t.live_at, 'items', items,
    'ready', not exists (select 1 from jsonb_array_elements(items) i
                          where (i ->> 'required')::boolean and not (i ->> 'done')::boolean));
end $$;

create or replace function everwake.go_live(p_tenant uuid, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c jsonb;
begin
  perform everwake.require_role(p_tenant, array['owner']);
  c := everwake.onboarding_checklist(p_tenant);
  if not (c ->> 'ready')::boolean and not (p_force and everwake.is_platform_admin()) then
    return jsonb_build_object('live', false, 'checklist', c);
  end if;
  update everwake.tenants set status = 'live', live_at = coalesce(live_at, now()) where id = p_tenant;
  return jsonb_build_object('live', true);
end $$;

-- ---------------------------------------------------------------------
-- Publish a reviewed menu import
-- p_menu = {"categories":[{"name_ar","name_en","items":[{"name_ar","name_en","description_ar",
--           "price","unit","tags":[],"aliases":[],"is_signature","options":[{"label_ar","label_en",
--           "required","min","max","choices":[{"name_ar","name_en","price_delta"}]}]}]}]}
-- merge   = add new dishes, update the ones that match by name
-- replace = the same, and archive dishes that are not in the import
--
-- p_branch: the menu of ONE branch (012). The restaurant's dishes stay as
-- they are; for that branch only:
--   · a dish already on the menu (same name) is put on its menu, at the
--     imported price when it differs from the restaurant's, and its
--     choices (same names) at the imported choice prices
--   · a new dish (or category) is created on that branch's menu only
--   · replace = dishes not in the import come off that branch's menu
--     (nothing is archived)
-- ---------------------------------------------------------------------
create or replace function everwake.publish_menu(p_tenant uuid, p_menu jsonb, p_mode text default 'merge',
                                                 p_import uuid default null, p_branch uuid default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  cat      jsonb;
  it       jsonb;
  grp      jsonb;
  ch       jsonb;
  v_cat    uuid;
  v_item   uuid;
  v_group  uuid;
  v_csort  int := 0;
  v_isort  int;
  v_level  int;
  v_osort  int;
  v_seen   uuid[] := '{}';
  n_cat_new int := 0; n_new int := 0; n_upd int := 0; n_arch int := 0; n_unlisted int := 0; n_choice int := 0;
  v_unit   text;
  v_kept   jsonb;
  v_was    everwake.menu_items%rowtype;
  v_price  numeric;
  v_cbr    uuid[];
  v_cact   boolean;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if p_mode not in ('merge', 'replace') then raise exception 'mode must be merge or replace'; end if;
  if p_branch is not null and not exists (select 1 from everwake.branches where id = p_branch and tenant_id = p_tenant) then
    raise exception 'branch not found';
  end if;

  for cat in select * from jsonb_array_elements(coalesce(p_menu -> 'categories', '[]'::jsonb)) loop
    v_csort := v_csort + 10;
    continue when coalesce(btrim(cat ->> 'name_ar'), btrim(cat ->> 'name_en'), '') = '';
    v_cat := null;
    select id, branch_ids, is_active into v_cat, v_cbr, v_cact from everwake.menu_categories
     where tenant_id = p_tenant
       and (everwake.norm(name_ar) = everwake.norm(coalesce(cat ->> 'name_ar', cat ->> 'name_en'))
            or (nullif(cat ->> 'name_en', '') is not null and everwake.norm(name_en) = everwake.norm(cat ->> 'name_en')))
     limit 1;
    if v_cat is null then
      insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort, branch_ids)
      values (p_tenant, coalesce(nullif(btrim(cat ->> 'name_ar'), ''), btrim(cat ->> 'name_en')), nullif(btrim(cat ->> 'name_en'), ''), v_csort,
              case when p_branch is not null then array[p_branch] end)
      returning id into v_cat;
      n_cat_new := n_cat_new + 1;
    elsif p_branch is null then
      update everwake.menu_categories set is_active = true, sort = v_csort,
             name_en = coalesce(nullif(btrim(cat ->> 'name_en'), ''), name_en)
       where id = v_cat;
    else
      -- the branch serves this category; a hidden one comes back for this branch only
      update everwake.menu_categories
         set is_active = true,
             branch_ids = case when not v_cact then array[p_branch]
                               when branch_ids is null or p_branch = any(branch_ids) then branch_ids
                               else branch_ids || p_branch end,
             name_en = coalesce(name_en, nullif(btrim(cat ->> 'name_en'), ''))
       where id = v_cat;
    end if;

    v_isort := 0;
    for it in select * from jsonb_array_elements(coalesce(cat -> 'items', '[]'::jsonb)) loop
      v_isort := v_isort + 10;
      continue when coalesce(btrim(it ->> 'name_ar'), btrim(it ->> 'name_en'), '') = '';
      v_unit := case when it ->> 'unit' in ('portion', 'piece', 'kg', 'person') then it ->> 'unit' else 'portion' end;
      v_price := nullif(it ->> 'price', '')::numeric;
      v_item := null;
      select id into v_item from everwake.menu_items
       where tenant_id = p_tenant
         and (everwake.norm(name_ar) = everwake.norm(coalesce(it ->> 'name_ar', it ->> 'name_en'))
              or (nullif(it ->> 'name_en', '') is not null and everwake.norm(name_en) = everwake.norm(it ->> 'name_en')))
         and not (id = any(v_seen))
       order by is_active desc
       limit 1;
      if v_item is null then
        insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, description_ar, description_en,
                                         unit, price, qty_step, min_qty, tags, is_signature, sort, source_import_id)
        values (p_tenant, v_cat, coalesce(nullif(btrim(it ->> 'name_ar'), ''), btrim(it ->> 'name_en')),
                nullif(btrim(it ->> 'name_en'), ''),
                coalesce((select array_agg(btrim(a)) from jsonb_array_elements_text(it -> 'aliases') a where btrim(a) <> ''), '{}'),
                nullif(btrim(it ->> 'description_ar'), ''), nullif(btrim(it ->> 'description_en'), ''),
                v_unit, v_price,
                case when v_unit = 'kg' then 0.25 end, case when v_unit = 'kg' then 0.5 end,
                coalesce((select array_agg(lower(btrim(a))) from jsonb_array_elements_text(it -> 'tags') a where btrim(a) <> ''), '{}'),
                coalesce((it ->> 'is_signature')::boolean, false), v_isort, p_import)
        returning id into v_item;
        n_new := n_new + 1;
        if p_branch is not null then
          -- a dish from this branch's menu: on this branch only
          insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, is_listed)
          select p_tenant, v_item, b.id, false from everwake.branches b where b.tenant_id = p_tenant and b.id <> p_branch;
        end if;
      elsif p_branch is null then
        update everwake.menu_items
           set category_id = v_cat, is_active = true, sort = v_isort, unit = v_unit,
               name_en = coalesce(nullif(btrim(it ->> 'name_en'), ''), name_en),
               description_ar = coalesce(nullif(btrim(it ->> 'description_ar'), ''), description_ar),
               description_en = coalesce(nullif(btrim(it ->> 'description_en'), ''), description_en),
               price = coalesce(v_price, price),
               aliases = case when jsonb_array_length(coalesce(it -> 'aliases', '[]'::jsonb)) > 0
                              then (select array_agg(distinct x) from unnest(aliases || (select array_agg(btrim(a)) from jsonb_array_elements_text(it -> 'aliases') a where btrim(a) <> '')) x)
                              else aliases end,
               is_signature = coalesce((it ->> 'is_signature')::boolean, is_signature),
               source_import_id = coalesce(p_import, source_import_id)
         where id = v_item;
        n_upd := n_upd + 1;
      else
        -- the restaurant's dish, now on this branch's menu at this branch's price
        select * into v_was from everwake.menu_items where id = v_item;
        update everwake.menu_items
           set is_active = true,
               name_en = coalesce(name_en, nullif(btrim(it ->> 'name_en'), '')),
               description_ar = coalesce(description_ar, nullif(btrim(it ->> 'description_ar'), '')),
               description_en = coalesce(description_en, nullif(btrim(it ->> 'description_en'), ''))
         where id = v_item;
        if not v_was.is_active then
          -- an archived dish comes back for this branch only
          insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed)
          select p_tenant, v_item, b.id, false from everwake.branches b where b.tenant_id = p_tenant and b.id <> p_branch
          on conflict (item_id, branch_id) do update set is_listed = false;
        end if;
        insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed, price)
        values (p_tenant, v_item, p_branch, true, case when v_price is distinct from v_was.price then v_price end)
        on conflict (item_id, branch_id) do update
          set is_listed = true,
              price = case when v_price is null then mb.price
                           when v_price is distinct from v_was.price then v_price end;
        n_upd := n_upd + 1;
      end if;
      v_seen := v_seen || v_item;

      if jsonb_array_length(coalesce(it -> 'options', '[]'::jsonb)) > 0 then
        if p_branch is not null and exists (select 1 from everwake.menu_option_groups where item_id = v_item) then
          -- the dish has its choices: this branch's choice prices, by name
          insert into everwake.menu_option_branches as x (tenant_id, option_id, branch_id, item_id, price_delta)
          select distinct on (o.id) p_tenant, o.id, p_branch, v_item,
                 nullif(coalesce(nullif(c ->> 'price_delta', '')::numeric, 0), o.price_delta)
            from jsonb_array_elements(it -> 'options') gj
            cross join jsonb_array_elements(coalesce(gj -> 'choices', '[]'::jsonb)) c
            join everwake.menu_option_groups g on g.item_id = v_item
            join everwake.menu_options o on o.group_id = g.id
                 and everwake.norm(o.name_ar) = everwake.norm(coalesce(nullif(c ->> 'name_ar', ''), c ->> 'name_en'))
           order by o.id, (everwake.norm(g.label_ar) = everwake.norm(gj ->> 'label_ar')) desc
          on conflict (option_id, branch_id) do update set price_delta = excluded.price_delta, is_available = true;
          get diagnostics v_level = row_count;
          n_choice := n_choice + v_level;
        else
          -- the choices are replaced as a whole when the import carries any
          v_kept := everwake.choice_overrides(v_item);
          delete from everwake.menu_option_groups where item_id = v_item;
          v_level := 0;
          for grp in select * from jsonb_array_elements(it -> 'options') loop
            continue when jsonb_array_length(coalesce(grp -> 'choices', '[]'::jsonb)) = 0;
            v_level := v_level + 1;
            insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
            values (p_tenant, v_item, v_level,
                    coalesce(nullif(btrim(grp ->> 'label_ar'), ''), nullif(btrim(grp ->> 'label_en'), ''), 'اختيار'),
                    nullif(btrim(grp ->> 'label_en'), ''),
                    coalesce((grp ->> 'required')::boolean, false),
                    greatest(0, coalesce((grp ->> 'min')::int, case when coalesce((grp ->> 'required')::boolean, false) then 1 else 0 end)),
                    nullif(grp ->> 'max', '')::int)
            returning id into v_group;
            v_osort := 0;
            for ch in select * from jsonb_array_elements(grp -> 'choices') loop
              v_osort := v_osort + 10;
              continue when coalesce(btrim(ch ->> 'name_ar'), btrim(ch ->> 'name_en'), '') = '';
              insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, price_delta, sort)
              values (p_tenant, v_group, coalesce(nullif(btrim(ch ->> 'name_ar'), ''), btrim(ch ->> 'name_en')),
                      nullif(btrim(ch ->> 'name_en'), ''), coalesce(nullif(ch ->> 'price_delta', '')::numeric, 0), v_osort);
            end loop;
          end loop;
          perform everwake.restore_choice_overrides(v_item, v_kept);
        end if;
      end if;
    end loop;
  end loop;

  if p_mode = 'replace' and p_branch is null then
    update everwake.menu_items set is_active = false
     where tenant_id = p_tenant and is_active and not (id = any(v_seen));
    get diagnostics n_arch = row_count;
  elsif p_mode = 'replace' then
    insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed)
    select p_tenant, i.id, p_branch, false
      from everwake.menu_items i
     where i.tenant_id = p_tenant and i.is_active and not (i.id = any(v_seen))
    on conflict (item_id, branch_id) do update set is_listed = false where mb.is_listed;
    get diagnostics n_unlisted = row_count;
  end if;

  if p_import is not null then
    update everwake.menu_imports
       set status = 'published', published_at = now(), published_by = everwake.current_user_id(), extracted = p_menu,
           branch_id = p_branch
     where id = p_import and tenant_id = p_tenant;
  end if;

  return jsonb_build_object('categories_created', n_cat_new, 'items_created', n_new, 'items_updated', n_upd,
                            'items_archived', n_arch, 'items_unlisted', n_unlisted, 'choice_prices', n_choice,
                            'branch_id', p_branch);
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
create or replace function everwake.analytics(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t    everwake.tenants%rowtype;
  s    jsonb;
  v    jsonb;
  v_comm numeric;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  v_comm := coalesce((s ->> 'aggregator_commission_percent')::numeric, 25);

  with o as (
    select * from everwake.orders
     where tenant_id = p_tenant and placed_at >= p_from and placed_at < p_to and status <> 'draft'
  ), good as (select * from o where status not in ('rejected', 'cancelled')),
  conv as (
    select count(distinct m.wa_id) as n
      from everwake.messages m
     where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
  )
  select jsonb_build_object(
    'currency', t.currency,
    'currency_symbol', t.currency_symbol_ar,
    'orders', (select count(*) from good),
    'revenue', (select coalesce(sum(total), 0) from good),
    'average_order', (select coalesce(round(avg(total), 2), 0) from good),
    'cancelled', (select count(*) from o where status in ('rejected', 'cancelled')),
    'discounts', (select coalesce(sum(discount_total), 0) from good),
    'delivery_share', (select coalesce(round(100.0 * count(*) filter (where delivery_method = 'delivery') / nullif(count(*), 0), 1), 0) from good),
    'conversations', (select n from conv),
    'conversion_percent', (select case when (select n from conv) = 0 then 0
                                       else round(100.0 * count(distinct wa_id) / (select n from conv), 1) end from good),
    'new_customers', (select count(*) from everwake.customers where tenant_id = p_tenant and first_seen_at >= p_from and first_seen_at < p_to),
    'returning_orders', (select count(*) from good g
                          where exists (select 1 from everwake.orders x where x.customer_id = g.customer_id and x.status <> 'draft'
                                          and x.placed_at < g.placed_at and x.status not in ('rejected', 'cancelled'))),
    'commission_percent', v_comm,
    'commission_saved', (select coalesce(round(sum(total) * v_comm / 100, 2), 0) from good),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue', r) order by d)
                          from (select (placed_at at time zone t.timezone)::date as d, count(*) as n, sum(total) as r
                                  from good group by 1) x), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n) order by h)
                           from (select extract(hour from placed_at at time zone t.timezone)::int as h, count(*) as n
                                   from good group by 1) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch', coalesce(b.name_ar, '—'), 'orders', x.n, 'revenue', x.r) order by x.r desc)
                             from (select branch_id, count(*) as n, sum(total) as r from good group by 1) x
                             left join everwake.branches b on b.id = x.branch_id), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'revenue', r) order by r desc nulls last)
                             from (select oi.name, sum(oi.quantity) as q, sum(oi.line_total) as r
                                     from everwake.order_items oi join good g on g.id = oi.order_id
                                    where not oi.is_gift
                                    group by oi.name order by sum(oi.line_total) desc nulls last limit 10) x), '[]'::jsonb),
    'agent', (select jsonb_build_object(
                'turns', count(*),
                'avg_reply_seconds', coalesce(round(avg(duration_total_ms) / 1000.0, 1), 0),
                'repairs', count(*) filter (where repair_used),
                'tokens', coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0))
                from everwake.agent_events where tenant_id = p_tenant and created_at >= p_from and created_at < p_to),
    'handoffs', (select count(*) from everwake.conversations
                  where tenant_id = p_tenant and attention_at >= p_from and attention_at < p_to))
  into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- The WhatsApp number. Secrets are written here and never read back by
-- the dashboard (see the column grants in 007).
-- ---------------------------------------------------------------------
create or replace function everwake.save_channel(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  c    everwake.whatsapp_channels%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if v_id is null then
    insert into everwake.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key,
                                            default_branch_id, cloud_phone_number_id, cloud_access_token)
    values (p_tenant, coalesce(nullif(p ->> 'provider', ''), 'evolution'), nullif(p ->> 'label', ''),
            nullif(everwake.digits(p ->> 'phone_number'), ''), nullif(btrim(p ->> 'instance_name'), ''),
            nullif(rtrim(btrim(p ->> 'base_url'), '/'), ''), nullif(btrim(p ->> 'api_key'), ''),
            nullif(p ->> 'default_branch_id', '')::uuid, nullif(btrim(p ->> 'cloud_phone_number_id'), ''),
            nullif(btrim(p ->> 'cloud_access_token'), ''))
    returning * into c;
  else
    update everwake.whatsapp_channels
       set label = coalesce(p ->> 'label', label),
           phone_number = coalesce(nullif(everwake.digits(p ->> 'phone_number'), ''), phone_number),
           instance_name = coalesce(nullif(btrim(p ->> 'instance_name'), ''), instance_name),
           base_url = coalesce(nullif(rtrim(btrim(p ->> 'base_url'), '/'), ''), base_url),
           api_key = coalesce(nullif(btrim(p ->> 'api_key'), ''), api_key),
           cloud_phone_number_id = coalesce(nullif(btrim(p ->> 'cloud_phone_number_id'), ''), cloud_phone_number_id),
           cloud_access_token = coalesce(nullif(btrim(p ->> 'cloud_access_token'), ''), cloud_access_token),
           default_branch_id = case when p ? 'default_branch_id' then nullif(p ->> 'default_branch_id', '')::uuid else default_branch_id end,
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           webhook_token = case when coalesce((p ->> 'rotate_token')::boolean, false)
                                then replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') else webhook_token end
     where id = v_id and tenant_id = p_tenant
    returning * into c;
    if not found then raise exception 'number not found'; end if;
  end if;
  return jsonb_build_object('id', c.id, 'instance_name', c.instance_name, 'webhook_token', c.webhook_token,
                            'has_api_key', c.api_key is not null, 'status', c.status);
end $$;

-- remove a WhatsApp number. Chats, orders and messages stay (they only lose the
-- link to it); replies still waiting to be sent go out from the restaurant's
-- other number, if it has one. Messages arriving later for its instance are ignored.
create or replace function everwake.remove_channel(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  c       everwake.whatsapp_channels%rowtype;
  v_other uuid;
  n       int := 0;
begin
  select * into c from everwake.whatsapp_channels where id = p_channel;
  if not found then raise exception 'number not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager']);
  select id into v_other from everwake.whatsapp_channels
   where tenant_id = c.tenant_id and id <> c.id and is_active
   order by created_at limit 1;
  if v_other is not null then
    update everwake.outbox set channel_id = v_other where channel_id = c.id and status = 'queued';
    get diagnostics n = row_count;
  end if;
  delete from everwake.whatsapp_channels where id = c.id;
  return jsonb_build_object('removed', c.id, 'instance_name', c.instance_name,
                            'other_number', v_other is not null, 'queued_moved', n);
end $$;

-- the webhook token is needed once, to paste the webhook URL into Evolution
create or replace function everwake.channel_webhook_token(p_channel uuid)
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare c everwake.whatsapp_channels%rowtype;
begin
  select * into c from everwake.whatsapp_channels where id = p_channel;
  if not found then raise exception 'number not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager']);
  return c.webhook_token;
end $$;

-- ---------------------------------------------------------------------
-- The team
-- ---------------------------------------------------------------------
create or replace function everwake.invite_member(p_tenant uuid, p_email text, p_role text default 'staff',
                                                  p_branch_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_id uuid;
begin
  perform everwake.require_role(p_tenant, array['owner']);
  if p_role not in ('owner', 'manager', 'staff') then raise exception 'unknown role'; end if;
  insert into everwake.tenant_invites (tenant_id, email, role, branch_ids, invited_by)
  values (p_tenant, lower(btrim(p_email)), p_role, p_branch_ids, everwake.current_user_id())
  on conflict (tenant_id, email) do update
    set role = excluded.role, branch_ids = excluded.branch_ids, accepted_at = null, accepted_by = null
  returning id into v_id;
  return jsonb_build_object('invite_id', v_id);
end $$;

-- run after every sign-in: joins the restaurants this e-mail was invited to
create or replace function everwake.accept_invites()
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_uid   uuid := everwake.current_user_id();
  v_email text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  r       record;
  n       int := 0;
begin
  if v_uid is null or v_email is null then return 0; end if;
  for r in select * from everwake.tenant_invites where email = v_email and accepted_at is null loop
    insert into everwake.tenant_members (tenant_id, user_id, role, branch_ids, email, display_name)
    values (r.tenant_id, v_uid, r.role, r.branch_ids, v_email, split_part(v_email, '@', 1))
    on conflict (tenant_id, user_id) do update set role = excluded.role, branch_ids = excluded.branch_ids;
    update everwake.tenant_invites set accepted_at = now(), accepted_by = v_uid where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function everwake.update_member(p_tenant uuid, p_user uuid, p_role text,
                                                  p_branch_ids uuid[] default null, p_display_name text default null)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner']);
  if p_role not in ('owner', 'manager', 'staff') then raise exception 'unknown role'; end if;
  if p_role <> 'owner' and (select role from everwake.tenant_members where tenant_id = p_tenant and user_id = p_user) = 'owner'
     and (select count(*) from everwake.tenant_members where tenant_id = p_tenant and role = 'owner') = 1 then
    raise exception 'a restaurant always keeps at least one owner';
  end if;
  update everwake.tenant_members
     set role = p_role, branch_ids = p_branch_ids, display_name = coalesce(nullif(btrim(p_display_name), ''), display_name)
   where tenant_id = p_tenant and user_id = p_user;
end $$;

create or replace function everwake.remove_member(p_tenant uuid, p_user uuid)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner']);
  if (select role from everwake.tenant_members where tenant_id = p_tenant and user_id = p_user) = 'owner'
     and (select count(*) from everwake.tenant_members where tenant_id = p_tenant and role = 'owner') = 1 then
    raise exception 'a restaurant always keeps at least one owner';
  end if;
  delete from everwake.tenant_members where tenant_id = p_tenant and user_id = p_user;
end $$;

-- ---------------------------------------------------------------------
-- A dish's choices, saved as a whole (levels in the order given)
-- p_groups = [{"label_ar","label_en","required","min","max",
--              "options":[{"name_ar","name_en","aliases":[],"price_delta","extra_charge","is_available"}]}]
-- ---------------------------------------------------------------------
create or replace function everwake.save_item_choices(p_item uuid, p_groups jsonb)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_tenant uuid;
  g jsonb; o jsonb;
  v_group uuid;
  v_level int := 0;
  v_sort int;
  v_kept jsonb;
begin
  select tenant_id into v_tenant from everwake.menu_items where id = p_item;
  if v_tenant is null then raise exception 'dish not found'; end if;
  perform everwake.require_role(v_tenant, array['owner', 'manager']);
  v_kept := everwake.choice_overrides(p_item);            -- the branches' own choice prices (012)
  delete from everwake.menu_option_groups where item_id = p_item;
  for g in select * from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) loop
    continue when jsonb_array_length(coalesce(g -> 'options', '[]'::jsonb)) = 0 or coalesce(btrim(g ->> 'label_ar'), '') = '';
    v_level := v_level + 1;
    insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
    values (v_tenant, p_item, v_level, btrim(g ->> 'label_ar'), nullif(btrim(g ->> 'label_en'), ''),
            coalesce((g ->> 'required')::boolean, false),
            greatest(0, coalesce(nullif(g ->> 'min', '')::int, case when coalesce((g ->> 'required')::boolean, false) then 1 else 0 end)),
            nullif(g ->> 'max', '')::int)
    returning id into v_group;
    v_sort := 0;
    for o in select * from jsonb_array_elements(g -> 'options') loop
      continue when coalesce(btrim(o ->> 'name_ar'), '') = '';
      v_sort := v_sort + 10;
      insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, aliases, price_delta, extra_charge, is_available, sort)
      values (v_tenant, v_group, btrim(o ->> 'name_ar'), nullif(btrim(o ->> 'name_en'), ''),
              coalesce((select array_agg(btrim(a)) from jsonb_array_elements_text(o -> 'aliases') a where btrim(a) <> ''), '{}'),
              coalesce(nullif(o ->> 'price_delta', '')::numeric, 0), coalesce((o ->> 'extra_charge')::boolean, false),
              coalesce((o ->> 'is_available')::boolean, true), v_sort);
    end loop;
  end loop;
  perform everwake.restore_choice_overrides(p_item, v_kept);
  return v_level;
end $$;

-- ================= 007_security.sql =================
-- =====================================================================
-- Everwake Orders · 007 · who can see and change what
--
-- Three kinds of caller:
--   · the n8n engine and maintenance scripts — a database role (or the
--     Supabase service role): full access, no user
--   · a dashboard user — Supabase role `authenticated` with a JWT: sees
--     only the restaurants they belong to (row level security), edits
--     only what their role allows, and does everything sensitive through
--     the functions in 005/006
--   · anon — nothing at all
-- Roles inside a restaurant: owner (everything), manager (everything
-- but the team and the WhatsApp secrets' owner-only actions), staff
-- (orders, conversations, stock and busy switches, the agent switch).
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- the restaurants the caller belongs to (evaluated once per query)
create or replace function everwake.my_tenant_ids()
returns uuid[] language sql stable security definer set search_path = everwake, pg_temp as $$
  select case
    when everwake.current_user_id() is null then '{}'::uuid[]
    when everwake.is_platform_admin() then coalesce((select array_agg(id) from everwake.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from everwake.tenant_members where user_id = everwake.current_user_id()), '{}')
  end
$$;

create or replace function everwake.my_editor_tenant_ids()
returns uuid[] language sql stable security definer set search_path = everwake, pg_temp as $$
  select case
    when everwake.current_user_id() is null then '{}'::uuid[]
    when everwake.is_platform_admin() then coalesce((select array_agg(id) from everwake.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from everwake.tenant_members
                    where user_id = everwake.current_user_id() and role in ('owner', 'manager')), '{}')
  end
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on schema everwake from public;
grant usage on schema everwake to authenticated, service_role;

revoke all on all tables in schema everwake from public, anon, authenticated;
revoke all on all sequences in schema everwake from public, anon, authenticated;
revoke execute on all functions in schema everwake from public, anon, authenticated;
alter default privileges in schema everwake revoke execute on functions from public;

grant all on all tables in schema everwake to service_role;
grant all on all sequences in schema everwake to service_role;
grant execute on all functions in schema everwake to service_role;

-- read: every table the dashboard shows
grant select on everwake.tenants, everwake.tenant_members, everwake.branches, everwake.delivery_zones,
                everwake.menu_categories, everwake.menu_items, everwake.menu_option_groups, everwake.menu_options,
                everwake.menu_item_branches, everwake.item_media, everwake.menu_media, everwake.menu_imports,
                everwake.offers, everwake.knowledge_entries, everwake.customers, everwake.customer_identities,
                everwake.customer_addresses, everwake.conversations, everwake.messages, everwake.outbox,
                everwake.orders, everwake.order_items, everwake.order_events, everwake.agent_pauses,
                everwake.pause_contacts, everwake.agent_events, everwake.menu_snapshot, everwake.audit_log,
                everwake.tenant_invites, everwake.platform_admins
  to authenticated;
-- the WhatsApp number without its secrets
grant select (id, tenant_id, provider, label, phone_number, instance_name, base_url, cloud_phone_number_id,
              default_branch_id, status, is_active, last_inbound_at, connected_at, created_at, updated_at)
  on everwake.whatsapp_channels to authenticated;

-- write: what the restaurant configures (RLS narrows it to owners/managers)
grant insert, update, delete on everwake.branches, everwake.delivery_zones, everwake.menu_categories,
                                everwake.menu_items, everwake.menu_option_groups, everwake.menu_options,
                                everwake.menu_item_branches, everwake.item_media, everwake.menu_media,
                                everwake.offers, everwake.knowledge_entries
  to authenticated;
grant insert, update on everwake.menu_imports to authenticated;
grant update (name_ar, name_en, timezone, currency, currency_symbol_ar, default_language, order_no_prefix, profile, settings)
  on everwake.tenants to authenticated;
grant update (full_name, alt_phone, staff_notes, tags, is_blocked, marketing_opt_out, food_prefs)
  on everwake.customers to authenticated;
grant delete on everwake.customer_addresses to authenticated;

-- functions the dashboard calls
grant execute on function
  everwake.current_user_id(), everwake.member_role(uuid), everwake.is_platform_admin(), everwake.my_tenant_ids(),
  everwake.my_editor_tenant_ids(), everwake.can_see_branch(uuid, uuid),
  everwake.norm(text), everwake.digits(text), everwake.fmt_money(numeric), everwake.haversine_km(double precision, double precision, double precision, double precision),
  everwake.point_in_polygon(double precision, double precision, jsonb), everwake.day_windows(jsonb, int),
  everwake.is_open_at(jsonb, timestamp), everwake.branch_state(uuid), everwake.zones_at(uuid, double precision, double precision),
  everwake.match_area(uuid, text), everwake.default_settings(), everwake.default_profile(), everwake.merged_settings(jsonb),
  everwake.merged_profile(jsonb), everwake.render_template(text, jsonb),
  everwake.create_tenant(text, text, text, text, text, text, text), everwake.my_tenants(),
  everwake.onboarding_checklist(uuid), everwake.go_live(uuid, boolean),
  everwake.publish_menu(uuid, jsonb, text, uuid, uuid), everwake.save_item_choices(uuid, jsonb),
  everwake.analytics(uuid, timestamptz, timestamptz),
  everwake.save_channel(uuid, jsonb), everwake.remove_channel(uuid), everwake.channel_webhook_token(uuid),
  everwake.invite_member(uuid, text, text, uuid[]), everwake.accept_invites(),
  everwake.update_member(uuid, uuid, text, uuid[], text), everwake.remove_member(uuid, uuid),
  everwake.set_agent_enabled(uuid, boolean, text, boolean), everwake.pause_status(uuid),
  everwake.take_over(bigint, text), everwake.hand_back(bigint),
  everwake.send_staff_message(bigint, text, text, text, text, text),
  everwake.mark_read(bigint), everwake.resolve_attention(bigint),
  everwake.set_order_status(bigint, text, text, boolean, text),
  everwake.set_item_availability(uuid, boolean, uuid, timestamptz), everwake.set_option_availability(uuid, boolean),
  everwake.set_branch_busy(uuid, int, text), everwake.set_branch_accepting(uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tenants', 'platform_admins', 'tenant_members', 'tenant_invites', 'branches', 'delivery_zones',
                           'whatsapp_channels', 'menu_categories', 'menu_items', 'menu_option_groups', 'menu_options',
                           'menu_item_branches', 'item_media', 'menu_media', 'menu_imports', 'offers', 'knowledge_entries',
                           'customers', 'customer_identities', 'customer_addresses', 'conversations', 'messages', 'outbox',
                           'inbound_buffer', 'conversation_locks', 'orders', 'order_items', 'order_events', 'agent_pauses',
                           'pause_contacts', 'agent_events', 'menu_snapshot', 'audit_log'] loop
    execute format('alter table everwake.%I enable row level security', t);
  end loop;

  -- members read their restaurant's rows
  foreach t in array array['tenant_members', 'branches', 'delivery_zones', 'whatsapp_channels', 'menu_categories',
                           'menu_items', 'menu_option_groups', 'menu_options', 'menu_item_branches', 'item_media',
                           'menu_media', 'offers', 'knowledge_entries', 'customers', 'customer_identities',
                           'customer_addresses', 'conversations', 'messages', 'outbox', 'agent_pauses', 'pause_contacts',
                           'menu_snapshot'] loop
    execute format('create policy member_read on everwake.%I for select to authenticated
                      using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]))', t);
  end loop;

  -- owners and managers change the configuration
  foreach t in array array['branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_option_groups',
                           'menu_options', 'menu_item_branches', 'item_media', 'menu_media', 'menu_imports', 'offers',
                           'knowledge_entries', 'customer_addresses'] loop
    execute format('create policy editor_write on everwake.%I for all to authenticated
                      using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
                      with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))', t);
  end loop;
end $$;

create policy member_read on everwake.tenants for select to authenticated
  using (id = any ((select everwake.my_tenant_ids())::uuid[]));
create policy editor_update on everwake.tenants for update to authenticated
  using (id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (id = any ((select everwake.my_editor_tenant_ids())::uuid[]));

create policy self_read on everwake.platform_admins for select to authenticated
  using (user_id = everwake.current_user_id());

create policy owner_read on everwake.tenant_invites for select to authenticated
  using (everwake.member_role(tenant_id) = 'owner');

-- staff note, tags, block: any team member
create policy member_update on everwake.customers for update to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));

-- orders: branch staff see their branches only
create policy member_read on everwake.orders for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]) and everwake.can_see_branch(tenant_id, branch_id));
create policy member_read on everwake.order_items for select to authenticated
  using (exists (select 1 from everwake.orders o where o.id = order_id));
create policy member_read on everwake.order_events for select to authenticated
  using (exists (select 1 from everwake.orders o where o.id = order_id));

create policy member_read on everwake.menu_imports for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));

-- telemetry and the audit trail: owners and managers
create policy editor_read on everwake.agent_events for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy editor_read on everwake.audit_log for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));

-- ================= 008_drivers.sql =================
-- =====================================================================
-- Everwake Orders · 008 · drivers
--
-- The restaurant's own drivers (طيارين). Added from the dashboard with a
-- name and a WhatsApp number; they sign in from a link sent to that number
-- (no password) and see only the orders given to them. Their phone sends
-- its location while they deliver, so the customer hears "on the way"
-- with the driver's name and number, then "about 5 minutes away", and the
-- agent can say where the order is.
--
-- Drivers never use Supabase auth: the dashboard's server calls the
-- driver_* functions with the service role and the driver's session token.
-- =====================================================================

create table everwake.drivers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references everwake.tenants(id) on delete cascade,
  name                  text not null,
  phone                 text not null,                -- international digits: 2010…
  branch_ids            uuid[] not null default '{}', -- empty = every branch
  is_active             boolean not null default true,
  login_code_hash       text,                         -- one-time sign-in link, hashed
  login_code_expires_at timestamptz,
  login_code_sent_at    timestamptz,
  last_lat              double precision,
  last_lng              double precision,
  last_accuracy_m       real,
  last_loc_at           timestamptz,
  last_seen_at          timestamptz,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, phone)
);
create index drivers_phone_idx on everwake.drivers (phone) where is_active;

-- a signed-in phone; the token itself is only in the driver's cookie
create table everwake.driver_sessions (
  token_hash   text primary key,
  driver_id    uuid not null references everwake.drivers(id) on delete cascade,
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index driver_sessions_driver_idx on everwake.driver_sessions (driver_id);

alter table everwake.orders
  add column driver_id          uuid references everwake.drivers(id) on delete set null,
  add column driver_assigned_at timestamptz,
  add column delivery_km_left   numeric(6, 2),       -- road estimate from the driver's last position
  add column delivery_eta_min   int,
  add column delivery_track_at  timestamptz,
  add column near_notified_at   timestamptz;         -- "about 5 minutes away" was sent
create index orders_driver_idx on everwake.orders (driver_id, status) where driver_id is not null;

alter table everwake.messages drop constraint messages_sender_check;
alter table everwake.messages add constraint messages_sender_check
  check (sender in ('customer', 'agent', 'staff', 'system', 'driver'));
alter table everwake.outbox drop constraint outbox_purpose_check;
alter table everwake.outbox add constraint outbox_purpose_check
  check (purpose in ('staff_reply', 'order_status', 'pause_notice', 'resume_notice', 'order_ticket', 'broadcast', 'test',
                     'driver', 'driver_chat'));
alter table everwake.order_events drop constraint order_events_by_role_check;
alter table everwake.order_events add constraint order_events_by_role_check
  check (by_role in ('agent', 'staff', 'system', 'driver'));

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- a phone as WhatsApp wants it: Egyptian 01xxxxxxxxx → 201xxxxxxxxx
create or replace function everwake.wa_phone(p text, p_country text default 'EG')
returns text language plpgsql immutable as $$
declare d text := everwake.digits(p);
begin
  if d like '00%' then d := substr(d, 3); end if;
  if coalesce(p_country, 'EG') = 'EG' then
    if d ~ '^01[0125][0-9]{8}$' then d := '2' || d;
    elsif d ~ '^1[0125][0-9]{8}$' then d := '20' || d;
    end if;
  end if;
  return case when length(d) between 8 and 15 then d end;
end $$;

create or replace function everwake.token_hash(p text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- 256 random bits, as 64 hex characters
create or replace function everwake.random_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- road distance and minutes from a straight line: streets add about a
-- third, a delivery bike in town averages ~22 km/h (settings can say otherwise)
create or replace function everwake.delivery_estimate(p_tenant uuid, lat1 double precision, lng1 double precision,
                                                      lat2 double precision, lng2 double precision)
returns jsonb language sql stable as $$
  select case when everwake.haversine_km(lat1, lng1, lat2, lng2) is null then null else
    jsonb_build_object(
      'km', round(everwake.haversine_km(lat1, lng1, lat2, lng2) * 1.35, 1),
      'min', greatest(1, ceil(everwake.haversine_km(lat1, lng1, lat2, lng2) * 1.35 * 60
                               / coalesce((select nullif(everwake.merged_settings(t.settings) ->> 'driver_speed_kmh', '')::numeric
                                             from everwake.tenants t where t.id = p_tenant), 22))::int))
  end
$$;

-- a message to a driver's own WhatsApp (not a customer conversation)
create or replace function everwake.queue_driver_message(p_driver uuid, p_body text)
returns bigint language plpgsql as $$
declare d everwake.drivers%rowtype; v_ch uuid; v_out bigint;
begin
  select * into d from everwake.drivers where id = p_driver;
  select ch.id into v_ch from everwake.whatsapp_channels ch
   where ch.tenant_id = d.tenant_id and ch.is_active order by ch.created_at limit 1;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body, created_by)
  values (d.tenant_id, v_ch, d.phone, 'driver', p_body, everwake.current_user_id())
  returning id into v_out;
  return v_out;
end $$;

-- the customer's number for the driver: the one they gave, else their WhatsApp number when it is a number
create or replace function everwake.order_customer_phone(o everwake.orders)
returns text language sql stable as $$
  select coalesce(nullif(everwake.digits(o.customer ->> 'phone'), ''),
                  (select case when not c.phone_hidden then nullif(everwake.digits(c.phone), '') end
                     from everwake.customers c where c.id = o.customer_id),
                  case when o.wa_id ~ '^[0-9]{8,15}$' then o.wa_id end)
$$;

-- "the driver Ahmed — 0100… · about 20 minutes" for the customer's messages
create or replace function everwake.driver_line(o everwake.orders, p_lang text)
returns text language plpgsql stable as $$
declare d everwake.drivers%rowtype; e jsonb; v_local text;
begin
  if o.driver_id is null then return null; end if;
  select * into d from everwake.drivers where id = o.driver_id;
  if not found then return null; end if;
  v_local := case when d.phone like '20%' then '0' || substr(d.phone, 3) else '+' || d.phone end;
  if d.last_loc_at > now() - interval '3 minutes' then
    e := everwake.delivery_estimate(o.tenant_id, d.last_lat, d.last_lng,
                                    (o.location ->> 'lat')::double precision, (o.location ->> 'lng')::double precision);
  end if;
  if p_lang = 'en' then
    return 'Your driver: ' || d.name || ' — ' || v_local
           || case when e is not null then ' · about ' || (e ->> 'min') || ' min away' else '' end;
  end if;
  return 'الطيار: ' || d.name || ' — ' || v_local
         || case when e is not null then ' · هيوصلك خلال حوالي ' || (e ->> 'min') || ' دقيقة' else '' end;
end $$;

-- ---------------------------------------------------------------------
-- The dashboard: add, change and assign drivers (any team member)
-- ---------------------------------------------------------------------
create or replace function everwake.save_driver(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_phone text;
  v_name  text := nullif(btrim(coalesce(p ->> 'name', '')), '');
  v_br    uuid[];
  d       everwake.drivers%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  v_phone := everwake.wa_phone(p ->> 'phone', (select country from everwake.tenants where id = p_tenant));
  if v_id is null and (v_name is null or v_phone is null) then
    raise exception 'A driver needs a name and a WhatsApp number';
  end if;
  if p ? 'phone' and v_phone is null then raise exception 'That WhatsApp number does not look right'; end if;
  if p ? 'branch_ids' then
    select coalesce(array_agg(b.id), '{}') into v_br
      from everwake.branches b
     where b.tenant_id = p_tenant and b.id::text in (select jsonb_array_elements_text(p -> 'branch_ids'));
  end if;
  if v_id is null then
    insert into everwake.drivers (tenant_id, name, phone, branch_ids, created_by)
    values (p_tenant, v_name, v_phone, coalesce(v_br, '{}'), everwake.current_user_id())
    returning * into d;
  else
    update everwake.drivers
       set name = coalesce(v_name, name),
           phone = coalesce(v_phone, phone),
           branch_ids = coalesce(v_br, branch_ids),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           updated_at = now()
     where id = v_id and tenant_id = p_tenant
    returning * into d;
    if not found then raise exception 'Driver not found'; end if;
    -- switched off: signed out everywhere, and off their orders
    if not d.is_active then
      delete from everwake.driver_sessions where driver_id = d.id;
      update everwake.orders set driver_id = null, driver_assigned_at = null
       where driver_id = d.id and status in ('placed', 'accepted', 'preparing', 'ready');
    end if;
  end if;
  return jsonb_build_object('id', d.id, 'phone', d.phone);
exception when unique_violation then
  raise exception 'A driver with this number already exists';
end $$;

-- a sign-in link for the driver, sent to their WhatsApp; returned too, to copy
create or replace function everwake.invite_driver(p_driver uuid, p_base text)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare d everwake.drivers%rowtype; v_code text := everwake.random_token(); v_link text; v_t text;
begin
  select * into d from everwake.drivers where id = p_driver;
  if not found then raise exception 'Driver not found'; end if;
  perform everwake.require_role(d.tenant_id, array['owner', 'manager', 'staff']);
  if not d.is_active then raise exception 'This driver is switched off'; end if;
  update everwake.drivers
     set login_code_hash = everwake.token_hash(v_code), login_code_expires_at = now() + interval '7 days',
         login_code_sent_at = now()
   where id = d.id;
  v_link := rtrim(p_base, '/') || '/d/' || d.id || '.' || v_code;
  select name_ar into v_t from everwake.tenants where id = d.tenant_id;
  perform everwake.queue_driver_message(d.id,
    'أهلاً ' || d.name || ' 👋' || E'\n' || 'ده رابط دخولك كطيار في ' || coalesce(v_t, '') || ':' || E'\n' || v_link
    || E'\n\n' || 'افتحه من موبايلك، وهتلاقي فيه الطلبات اللي معاك والعناوين والخرايط.');
  return jsonb_build_object('link', v_link, 'phone', d.phone);
end $$;

-- give an order to a driver (or take it back with null); the driver hears on WhatsApp
create or replace function everwake.assign_driver(p_order bigint, p_driver uuid, p_base text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare o everwake.orders%rowtype; d everwake.drivers%rowtype;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if o.status not in ('placed', 'accepted', 'preparing', 'ready', 'out_for_delivery') then
    raise exception 'this order is % and cannot change', o.status;
  end if;
  if p_driver is not null then
    select * into d from everwake.drivers where id = p_driver and tenant_id = o.tenant_id;
    if not found or not d.is_active then raise exception 'Driver not found'; end if;
    if cardinality(d.branch_ids) > 0 and o.branch_id is not null and not (o.branch_id = any(d.branch_ids)) then
      raise exception 'This driver does not deliver for this branch';
    end if;
  end if;
  update everwake.orders
     set driver_id = p_driver, driver_assigned_at = case when p_driver is null then null else now() end,
         near_notified_at = null, delivery_km_left = null, delivery_eta_min = null, delivery_track_at = null
   where id = o.id;
  if p_driver is not null and p_base is not null then
    perform everwake.queue_driver_message(d.id,
      '🛵 طلب جديد معاك: ' || coalesce(o.order_no, '') || E'\n' || coalesce(o.address_text, '')
      || E'\n' || 'افتح طلباتك: ' || rtrim(p_base, '/') || '/driver');
  end if;
  insert into everwake.order_events (tenant_id, order_id, status, note, by_user, by_role)
  values (o.tenant_id, o.id, o.status,
          case when p_driver is null then 'driver removed' else 'driver: ' || d.name end,
          everwake.current_user_id(), case when everwake.current_user_id() is null then 'system' else 'staff' end);
  return jsonb_build_object('order_id', o.id, 'driver_id', p_driver);
end $$;

-- per driver, between two times: deliveries, cash collected, minutes on the road
create or replace function everwake.driver_report(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.name) from (
    select d.id as driver_id, d.name, d.is_active,
           count(o.id) as delivered,
           coalesce(sum(o.total) filter (where coalesce(o.payment_method, 'cash') ilike '%cash%'
                                            or o.payment_method ilike '%كاش%'), 0) as cash,
           coalesce(sum(o.total), 0) as total,
           round(avg(extract(epoch from (o.completed_at - o.out_for_delivery_at)) / 60)
                 filter (where o.out_for_delivery_at is not null))::int as avg_minutes
      from everwake.drivers d
      left join everwake.orders o on o.driver_id = d.id and o.status = 'delivered'
                                 and o.completed_at >= p_from and o.completed_at < p_to
     where d.tenant_id = p_tenant
     group by d.id, d.name, d.is_active) r), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- The driver's phone (service role only, with the session token)
-- ---------------------------------------------------------------------

-- "send me my link": every restaurant this number drives for sends one
-- (at most one a minute each); the answer never says whether it exists
create or replace function everwake.driver_request_login(p_phone text, p_base text)
returns int language plpgsql as $$
declare d record; v_code text; n int := 0;
begin
  for d in select dr.*, t.name_ar as t_name from everwake.drivers dr join everwake.tenants t on t.id = dr.tenant_id
            where dr.is_active and dr.phone = everwake.wa_phone(p_phone, t.country)
              and (dr.login_code_sent_at is null or dr.login_code_sent_at < now() - interval '1 minute') loop
    v_code := everwake.random_token();
    update everwake.drivers
       set login_code_hash = everwake.token_hash(v_code), login_code_expires_at = now() + interval '1 day',
           login_code_sent_at = now()
     where id = d.id;
    perform everwake.queue_driver_message(d.id,
      'رابط دخولك كطيار في ' || d.t_name || ':' || E'\n' || rtrim(p_base, '/') || '/d/' || d.id || '.' || v_code);
    n := n + 1;
  end loop;
  return n;
end $$;

-- the link opened: a session for this phone (the link works once)
create or replace function everwake.driver_redeem(p_driver uuid, p_code text, p_user_agent text default null)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype; v_token text := everwake.random_token();
begin
  select * into d from everwake.drivers where id = p_driver for update;
  if not found or not d.is_active or d.login_code_hash is null or d.login_code_expires_at < now()
     or d.login_code_hash <> everwake.token_hash(p_code) then
    return jsonb_build_object('ok', false);
  end if;
  update everwake.drivers set login_code_hash = null, login_code_expires_at = null, last_seen_at = now() where id = d.id;
  insert into everwake.driver_sessions (token_hash, driver_id, tenant_id, user_agent)
  values (everwake.token_hash(v_token), d.id, d.tenant_id, left(p_user_agent, 300));
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;

create or replace function everwake.driver_from_token(p_token text)
returns everwake.drivers language plpgsql as $$
declare d everwake.drivers%rowtype; s everwake.driver_sessions%rowtype;
begin
  select * into s from everwake.driver_sessions where token_hash = everwake.token_hash(p_token);
  if found then select * into d from everwake.drivers where id = s.driver_id and is_active; end if;
  if s.token_hash is null or d.id is null then
    raise exception 'signed out' using errcode = '28000';
  end if;
  if s.last_seen_at < now() - interval '1 minute' then
    update everwake.driver_sessions set last_seen_at = now() where token_hash = s.token_hash;
    update everwake.drivers set last_seen_at = now() where id = d.id;
  end if;
  return d;
end $$;

-- everything the driver's screen shows
create or replace function everwake.driver_home(p_token text)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); t everwake.tenants%rowtype;
begin
  select * into t from everwake.tenants where id = d.tenant_id;
  return jsonb_build_object(
    'driver', jsonb_build_object('id', d.id, 'name', d.name, 'phone', d.phone),
    'restaurant', jsonb_build_object('name_ar', t.name_ar, 'name_en', t.name_en, 'currency', t.currency_symbol_ar,
                                     'logo_url', t.profile -> 'brand' ->> 'logo_url', 'color', t.profile -> 'brand' ->> 'color'),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_no', o.order_no, 'status', o.status, 'placed_at', o.placed_at,
        'customer_name', coalesce(nullif(o.customer ->> 'full_name', ''), c.full_name, c.display_name),
        'customer_phone', everwake.order_customer_phone(o),
        'address_text', o.address_text, 'address', o.address, 'location', o.location, 'notes', o.notes,
        'total', o.total, 'delivery_fee', o.delivery_fee, 'payment_method', o.payment_method,
        'km_left', o.delivery_km_left, 'eta_min', o.delivery_eta_min,
        'branch', jsonb_build_object('name', b.name_ar, 'address', b.address_ar, 'phone', b.phone,
                                     'lat', b.lat, 'lng', b.lng, 'maps_url', b.maps_url),
        'items', coalesce((select jsonb_agg(jsonb_build_object('name', oi.name, 'quantity', oi.quantity, 'unit', oi.unit,
                                                               'choices', oi.choices, 'notes', oi.notes) order by oi.line_no)
                             from everwake.order_items oi where oi.order_id = o.id), '[]'::jsonb))
        order by (o.status = 'out_for_delivery') desc, o.driver_assigned_at)
      from everwake.orders o
      left join everwake.customers c on c.id = o.customer_id
      left join everwake.branches b on b.id = o.branch_id
     where o.driver_id = d.id and o.status in ('placed', 'accepted', 'preparing', 'ready', 'out_for_delivery')), '[]'::jsonb),
    'today', (select jsonb_build_object('delivered', count(*),
                                        'cash', coalesce(sum(o.total) filter (where coalesce(o.payment_method, 'cash') ilike '%cash%'
                                                                                 or o.payment_method ilike '%كاش%'), 0))
                from everwake.orders o
               where o.driver_id = d.id and o.status = 'delivered'
                 and o.completed_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone));
end $$;

-- picked up and leaving (the customer hears it, with the driver's name and number), or delivered
create or replace function everwake.driver_action(p_token text, p_order bigint, p_action text)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); o everwake.orders%rowtype; r jsonb;
begin
  select * into o from everwake.orders where id = p_order and driver_id = d.id;
  if not found then raise exception 'This order is not yours'; end if;
  if p_action = 'pick_up' then
    if o.status not in ('accepted', 'preparing', 'ready') then raise exception 'the order is %', o.status; end if;
    r := everwake.set_order_status(o.id, 'out_for_delivery');
  elsif p_action = 'delivered' then
    if o.status <> 'out_for_delivery' then raise exception 'the order is %', o.status; end if;
    r := everwake.set_order_status(o.id, 'delivered');
  else
    raise exception 'unknown action %', p_action;
  end if;
  update everwake.order_events set by_role = 'driver', note = coalesce(note, 'driver: ' || d.name)
   where id = (select max(id) from everwake.order_events where order_id = o.id);
  return r;
end $$;

-- the phone's position: the order's distance, and "about 5 minutes away" once
create or replace function everwake.driver_ping(p_token text, p_lat double precision, p_lng double precision,
                                                p_accuracy real default null)
returns jsonb language plpgsql as $$
declare
  d  everwake.drivers%rowtype := everwake.driver_from_token(p_token);
  o  everwake.orders%rowtype;
  e  jsonb;
  n  int := 0;
  v_near int;
  v_lang text;
  res jsonb := '[]'::jsonb;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'bad position'; end if;
  update everwake.drivers set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy, last_loc_at = now()
   where id = d.id;
  v_near := coalesce((select nullif(everwake.merged_settings(t.settings) ->> 'driver_near_minutes', '')::int
                        from everwake.tenants t where t.id = d.tenant_id), 5);
  for o in select * from everwake.orders where driver_id = d.id and status = 'out_for_delivery' for update loop
    e := everwake.delivery_estimate(o.tenant_id, p_lat, p_lng,
                                    (o.location ->> 'lat')::double precision, (o.location ->> 'lng')::double precision);
    continue when e is null;
    update everwake.orders
       set delivery_km_left = (e ->> 'km')::numeric, delivery_eta_min = (e ->> 'min')::int, delivery_track_at = now()
     where id = o.id;
    -- close: tell the customer once (not when they were this close at pick-up: that message said it)
    if o.near_notified_at is null and (e ->> 'min')::int <= v_near then
      update everwake.orders set near_notified_at = now() where id = o.id;
      if o.out_for_delivery_at < now() - interval '2 minutes' then
        v_lang := everwake.customer_language(o.tenant_id, o.wa_id);
        perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status',
          case when v_lang = 'en' then '🛵 ' || d.name || ' is almost there — about ' || (e ->> 'min') || ' min away.'
               else '🛵 الطيار ' || d.name || ' قرّب يوصلك — حوالي ' || (e ->> 'min') || ' دقايق.' end);
        n := n + 1;
      end if;
    end if;
    res := res || jsonb_build_object('order_id', o.id, 'km', e -> 'km', 'min', e -> 'min');
  end loop;
  return jsonb_build_object('orders', res, 'notified', n);
end $$;

-- the chat with the customer, from the restaurant's WhatsApp number
create or replace function everwake.driver_chat(p_token text, p_order bigint)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); o everwake.orders%rowtype;
begin
  select * into o from everwake.orders where id = p_order and driver_id = d.id;
  if not found then raise exception 'This order is not yours'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'at') from (
    select jsonb_build_object('id', m.id, 'from', case when m.direction = 'inbound' then 'customer' else m.sender end,
                              'kind', m.kind, 'text', m.body, 'at', m.created_at, 'status', m.status) as x
      from everwake.messages m
     where m.tenant_id = o.tenant_id and m.wa_id = o.wa_id
       and m.created_at >= least(coalesce(o.driver_assigned_at, o.placed_at), now() - interval '30 minutes')
     order by m.created_at desc limit 60) q), '[]'::jsonb);
end $$;

create or replace function everwake.driver_send(p_token text, p_order bigint, p_text text)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); o everwake.orders%rowtype;
begin
  select * into o from everwake.orders where id = p_order and driver_id = d.id;
  if not found then raise exception 'This order is not yours'; end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then raise exception 'empty message'; end if;
  return everwake.queue_customer_message(o.tenant_id, o.wa_id, 'driver_chat',
    '🛵 ' || d.name || ': ' || left(btrim(p_text), 1000), p_sender => 'driver');
end $$;

create or replace function everwake.driver_logout(p_token text)
returns void language sql as $$
  delete from everwake.driver_sessions where token_hash = everwake.token_hash(p_token)
$$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.drivers enable row level security;
alter table everwake.driver_sessions enable row level security;
create policy member_read on everwake.drivers for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));

grant all on everwake.drivers, everwake.driver_sessions to service_role;
grant select (id, tenant_id, name, phone, branch_ids, is_active, login_code_sent_at, last_lat, last_lng,
              last_accuracy_m, last_loc_at, last_seen_at, created_at, updated_at)
  on everwake.drivers to authenticated;

revoke execute on all functions in schema everwake from public, anon;
-- the driver's phone reaches these only through the dashboard's server
revoke execute on function
  everwake.queue_driver_message(uuid, text), everwake.driver_request_login(text, text),
  everwake.driver_redeem(uuid, text, text), everwake.driver_from_token(text), everwake.driver_home(text),
  everwake.driver_action(text, bigint, text), everwake.driver_ping(text, double precision, double precision, real),
  everwake.driver_chat(text, bigint), everwake.driver_send(text, bigint, text), everwake.driver_logout(text)
  from authenticated;
grant execute on all functions in schema everwake to service_role;
grant execute on function
  everwake.save_driver(uuid, jsonb), everwake.invite_driver(uuid, text), everwake.assign_driver(bigint, uuid, text),
  everwake.driver_report(uuid, timestamptz, timestamptz), everwake.wa_phone(text, text)
  to authenticated;

-- ================= 009_growth.sql =================
-- =====================================================================
-- Everwake Orders · 009 · growth and reports
--
-- What an owner wants to see that a delivery app never shows them:
--   · the commission WhatsApp saved them (today, this month, ever)
--   · which QR card or link brought which customers (the link pre-fills
--     "… عرفتكم من <source>", so the first message says where they came from)
--   · the sales they are missing: carts never finished, customers outside the
--     delivery zones, people who wrote while every branch was closed,
--     rejected / cancelled orders, chats that ended without an order
--   · a daily summary on their own WhatsApp, at the hour they choose
-- =====================================================================

create table everwake.report_runs (
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  kind       text not null default 'daily',
  local_day  date not null,
  recipients int not null default 0,
  sent_at    timestamptz not null default now(),
  primary key (tenant_id, kind, local_day)
);

alter table everwake.outbox drop constraint outbox_purpose_check;
alter table everwake.outbox add constraint outbox_purpose_check
  check (purpose in ('staff_reply', 'order_status', 'pause_notice', 'resume_notice', 'order_ticket', 'broadcast', 'test',
                     'driver', 'driver_chat', 'report'));

-- 1,234 — money as people read it
create or replace function everwake.fmt_int(n numeric)
returns text language sql immutable as $$
  select case when n is null then '0' else to_char(round(n), 'FM999,999,999,990') end
$$;

-- ---------------------------------------------------------------------
-- The commission WhatsApp saved
-- ---------------------------------------------------------------------
create or replace function everwake.savings(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t everwake.tenants%rowtype;
  v_pct numeric;
  v_today timestamptz;
  v_month timestamptz;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into t from everwake.tenants where id = p_tenant;
  v_pct := coalesce((everwake.merged_settings(t.settings) ->> 'aggregator_commission_percent')::numeric, 25);
  v_today := date_trunc('day', now() at time zone t.timezone) at time zone t.timezone;
  v_month := date_trunc('month', now() at time zone t.timezone) at time zone t.timezone;
  return (
    select jsonb_build_object(
      'commission_percent', v_pct,
      'today', round(coalesce(sum(total) filter (where placed_at >= v_today), 0) * v_pct / 100, 2),
      'month', round(coalesce(sum(total) filter (where placed_at >= v_month), 0) * v_pct / 100, 2),
      'all_time', round(coalesce(sum(total), 0) * v_pct / 100, 2),
      'orders_today', count(*) filter (where placed_at >= v_today),
      'orders_month', count(*) filter (where placed_at >= v_month),
      'orders_all', count(*),
      'revenue_month', coalesce(sum(total) filter (where placed_at >= v_month), 0),
      'since', min(placed_at))
      from everwake.orders
     where tenant_id = p_tenant and placed_at is not null and status not in ('draft', 'rejected', 'cancelled'));
end $$;

-- ---------------------------------------------------------------------
-- Where customers came from: the sources the restaurant's links name
-- ---------------------------------------------------------------------
create or replace function everwake.growth_sources(p_tenant uuid, p_from timestamptz, p_to timestamptz, p_sources text[])
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare v_pct numeric;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  v_pct := coalesce((select (everwake.merged_settings(settings) ->> 'aggregator_commission_percent')::numeric
                       from everwake.tenants where id = p_tenant), 25);
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.chats desc, r.source) from (
    with firsts as (
      -- the first message of each customer that names a source
      select distinct on (m.wa_id) m.wa_id, m.created_at, m.body
        from everwake.messages m
       where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
         and m.body like '%عرفتكم من%'
       order by m.wa_id, m.created_at
    )
    select s.source,
           count(distinct f.wa_id) as chats,
           count(distinct o.wa_id) as customers,
           count(o.id) as orders,
           coalesce(sum(o.total), 0) as revenue,
           round(coalesce(sum(o.total), 0) * v_pct / 100, 2) as commission_saved
      from unnest(p_sources) s(source)
      left join firsts f on f.body like '%عرفتكم من ' || s.source || '%'
      left join everwake.orders o on o.tenant_id = p_tenant and o.wa_id = f.wa_id and o.placed_at >= f.created_at
                                 and o.status not in ('draft', 'rejected', 'cancelled')
     group by s.source) r), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- The sales the restaurant is missing (no role check: the daily report
-- uses it too; the dashboard calls lost_sales below)
-- ---------------------------------------------------------------------
create or replace function everwake.lost_sales_data(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable as $$
declare
  t everwake.tenants%rowtype;
begin
  select * into t from everwake.tenants where id = p_tenant;
  return jsonb_build_object(
    -- carts with dishes in them that never became an order (quiet for an hour or more)
    'abandoned', (
      with d as (
        select o.*, coalesce(o.conversation_id, c.id) as conv_id, coalesce(cu.full_name, cu.display_name) as name
          from everwake.orders o
          left join everwake.conversations c on c.tenant_id = o.tenant_id and c.wa_id = o.wa_id
          left join everwake.customers cu on cu.id = coalesce(o.customer_id, c.customer_id)
         where o.tenant_id = p_tenant and o.status = 'draft'
           and o.updated_at >= p_from and o.updated_at < p_to and o.updated_at < now() - interval '1 hour'
           and jsonb_array_length(coalesce(o.cart -> 'items', '[]'::jsonb)) > 0)
      select jsonb_build_object(
        'count', (select count(*) from d),
        'value', (select coalesce(sum(nullif(total, 0)), sum(subtotal), 0) from d),
        'carts', coalesce((select jsonb_agg(jsonb_build_object(
                    'conversation_id', conv_id, 'wa_id', wa_id, 'name', name, 'at', updated_at,
                    'total', coalesce(nullif(total, 0), subtotal),
                    'items', (select string_agg(coalesce(i ->> 'display_name', i ->> 'item_name') || ' ×' || (i ->> 'quantity'), '، ')
                                from jsonb_array_elements(cart -> 'items') i where not coalesce((i ->> 'gift')::boolean, false)))
                    order by updated_at desc)
                    from (select * from d order by updated_at desc limit 30) x), '[]'::jsonb),
        'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', n, 'carts', c) order by c desc)
                                 from (select coalesce(i ->> 'display_name', i ->> 'item_name') as n, count(*) as c
                                         from d, jsonb_array_elements(d.cart -> 'items') i
                                        where not coalesce((i ->> 'gift')::boolean, false)
                                        group by 1 order by 2 desc limit 8) x), '[]'::jsonb))),
    -- a pin outside every delivery zone, and no order since
    'out_of_area', (
      with x as (
        select c.wa_id, c.id as conversation_id, (c.state -> 'location' ->> 'lat')::double precision as lat,
               (c.state -> 'location' ->> 'lng')::double precision as lng,
               coalesce(nullif(c.state -> 'location' -> 'geo' ->> 'district', ''), nullif(c.state -> 'location' -> 'geo' ->> 'city', ''), '—') as area,
               (c.state -> 'location' ->> 'at')::timestamptz as at
          from everwake.conversations c
         where c.tenant_id = p_tenant and c.state -> 'location' ->> 'in_delivery_area' = 'false'
           and (c.state -> 'location' ->> 'at')::timestamptz >= p_from and (c.state -> 'location' ->> 'at')::timestamptz < p_to
           and not exists (select 1 from everwake.orders o where o.tenant_id = p_tenant and o.wa_id = c.wa_id
                             and o.status not in ('draft', 'rejected', 'cancelled')
                             and o.placed_at >= (c.state -> 'location' ->> 'at')::timestamptz))
      select jsonb_build_object(
        'count', (select count(*) from x),
        'areas', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'count', n) order by n desc)
                             from (select area, count(*) as n from x group by area order by 2 desc limit 10) a), '[]'::jsonb),
        'points', coalesce((select jsonb_agg(jsonb_build_object('lat', lat, 'lng', lng, 'area', area)) from x where lat is not null), '[]'::jsonb))),
    -- wrote while every branch with opening hours was closed, and ordered nothing within 12 hours
    'while_closed', (
      with firsts as (
        select distinct on (m.wa_id, (m.created_at at time zone t.timezone)::date) m.wa_id, m.created_at
          from everwake.messages m
         where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
         order by m.wa_id, (m.created_at at time zone t.timezone)::date, m.created_at
      ), closed as (
        select f.* from firsts f
         where exists (select 1 from everwake.branches b where b.tenant_id = p_tenant and b.is_active and b.hours <> '{}'::jsonb)
           and not exists (select 1 from everwake.branches b
                            where b.tenant_id = p_tenant and b.is_active
                              and coalesce(everwake.is_open_at(b.hours, (f.created_at at time zone t.timezone)::timestamp), true))
           and not exists (select 1 from everwake.orders o where o.tenant_id = p_tenant and o.wa_id = f.wa_id
                             and o.status not in ('draft', 'rejected', 'cancelled')
                             and o.placed_at >= f.created_at and o.placed_at < f.created_at + interval '12 hours'))
      select jsonb_build_object(
        'count', (select count(*) from closed),
        'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'count', n) order by h)
                               from (select extract(hour from created_at at time zone t.timezone)::int as h, count(*) as n
                                       from closed group by 1) x), '[]'::jsonb))),
    'refused', (
      with r as (select * from everwake.orders where tenant_id = p_tenant and status in ('rejected', 'cancelled')
                    and placed_at >= p_from and placed_at < p_to)
      select jsonb_build_object(
        'count', (select count(*) from r),
        'value', (select coalesce(sum(total), 0) from r),
        'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc)
                               from (select coalesce(nullif(btrim(reject_reason), ''), '—') as reason, count(*) as n
                                       from r group by 1 order by 2 desc limit 8) x), '[]'::jsonb))),
    -- talked to the restaurant, never ordered in the period
    'no_order_chats', (
      select count(distinct m.wa_id)
        from everwake.messages m
       where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
         and not exists (select 1 from everwake.orders o where o.tenant_id = p_tenant and o.wa_id = m.wa_id
                           and o.status <> 'draft' and o.placed_at >= p_from)),
    'agent_off', (select count(*) from everwake.pause_contacts
                   where tenant_id = p_tenant and first_message_at >= p_from and first_message_at < p_to),
    'handoffs', (select count(*) from everwake.conversations
                  where tenant_id = p_tenant and attention_at >= p_from and attention_at < p_to));
end $$;

create or replace function everwake.lost_sales(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  return everwake.lost_sales_data(p_tenant, p_from, p_to);
end $$;

-- ---------------------------------------------------------------------
-- The daily report on the owner's WhatsApp
-- settings.daily_report = { enabled, numbers: ["010…"], time: "10:00" }
-- It covers the 24 hours before it is sent.
-- ---------------------------------------------------------------------
create or replace function everwake.report_text(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns text language plpgsql stable as $$
declare
  t   everwake.tenants%rowtype;
  s   jsonb;
  v_pct numeric;
  a   record;
  l   jsonb;
  v   text;
  x   text;
  sym text;
begin
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  v_pct := coalesce((s ->> 'aggregator_commission_percent')::numeric, 25);
  sym := ' ' || coalesce(nullif(t.currency_symbol_ar, ''), 'ج');
  select count(*) filter (where status not in ('rejected', 'cancelled')) as orders,
         count(*) filter (where status in ('rejected', 'cancelled')) as refused,
         count(*) filter (where status not in ('rejected', 'cancelled') and delivery_method = 'delivery') as delivery,
         coalesce(sum(total) filter (where status not in ('rejected', 'cancelled')), 0) as revenue
    into a
    from everwake.orders where tenant_id = p_tenant and status <> 'draft' and placed_at >= p_from and placed_at < p_to;
  l := everwake.lost_sales_data(p_tenant, p_from, p_to);

  v := '📊 تقرير ' || coalesce(nullif(t.name_ar, ''), t.name_en) || E'\n'
       || 'من ' || to_char(p_from at time zone t.timezone, 'DD/MM HH24:MI') || ' لـ ' || to_char(p_to at time zone t.timezone, 'DD/MM HH24:MI')
       || E'\n\n'
       || '🧾 الطلبات: ' || a.orders || case when a.orders > 0 then ' (' || a.delivery || ' توصيل · ' || (a.orders - a.delivery) || ' استلام)' else '' end
       || case when a.refused > 0 then ' · اتلغى/اترفض ' || a.refused else '' end || E'\n'
       || '💰 المبيعات: ' || everwake.fmt_int(a.revenue) || sym
       || case when a.orders > 0 then ' · متوسط الطلب ' || everwake.fmt_int(a.revenue / a.orders) || sym else '' end || E'\n'
       || '💸 وفّرت عمولة: ' || everwake.fmt_int(a.revenue * v_pct / 100) || sym || ' (مقارنة بـ ' || trim_scale(v_pct) || '% عمولة التطبيقات)';

  select string_agg(i || '. ' || name || ' (' || trim_scale(q) || ')', ' · ' order by i) into x
    from (select row_number() over (order by sum(oi.quantity) desc) as i, oi.name, sum(oi.quantity) as q
            from everwake.order_items oi join everwake.orders o on o.id = oi.order_id
           where o.tenant_id = p_tenant and o.status not in ('draft', 'rejected', 'cancelled')
             and o.placed_at >= p_from and o.placed_at < p_to and not oi.is_gift
           group by oi.name order by sum(oi.quantity) desc limit 3) q;
  if x is not null then v := v || E'\n' || '🔥 الأكتر طلباً: ' || x; end if;

  if (select count(*) from everwake.branches where tenant_id = p_tenant and is_active) > 1 then
    select string_agg(coalesce(b.name_ar, '—') || ' ' || n || ' · ' || everwake.fmt_int(r) || sym, ' | ' order by r desc) into x
      from (select branch_id, count(*) as n, sum(total) as r from everwake.orders
             where tenant_id = p_tenant and status not in ('draft', 'rejected', 'cancelled') and placed_at >= p_from and placed_at < p_to
             group by branch_id) q left join everwake.branches b on b.id = q.branch_id;
    if x is not null then v := v || E'\n' || '🏪 الفروع: ' || x; end if;
  end if;

  v := v || E'\n' || '👥 عملاء جداد: ' || (select count(*) from everwake.customers where tenant_id = p_tenant and first_seen_at >= p_from and first_seen_at < p_to);

  select string_agg(d.name || ' ' || n || ' طلب' || case when c > 0 then ' (كاش ' || everwake.fmt_int(c) || sym || ')' else '' end, ' · ' order by n desc) into x
    from (select driver_id, count(*) as n,
                 coalesce(sum(total) filter (where coalesce(payment_method, 'cash') ilike '%cash%' or payment_method ilike '%كاش%'), 0) as c
            from everwake.orders where tenant_id = p_tenant and status = 'delivered' and driver_id is not null
             and completed_at >= p_from and completed_at < p_to group by driver_id) q
    join everwake.drivers d on d.id = q.driver_id;
  if x is not null then v := v || E'\n' || '🛵 الطيارين: ' || x; end if;

  -- table bookings (010): asked for in the period, and what still waits for the team
  select case when count(*) = 0 and count(*) filter (where status = 'requested') = 0 then null
              else count(*) || ' طلب حجز' || case when count(*) filter (where status = 'requested') > 0
                                                 then ' · مستنيين تأكيد: ' || count(*) filter (where status = 'requested') else '' end end
    into x
    from everwake.reservations where tenant_id = p_tenant and status <> 'draft' and requested_at >= p_from and requested_at < p_to;
  if x is not null then v := v || E'\n' || '🍽 الحجوزات: ' || x; end if;

  v := v || E'\n\n' || '⚠️ فرص ضايعة:'
       || E'\n' || '• سلات مكملتش: ' || (l -> 'abandoned' ->> 'count')
       || case when (l -> 'abandoned' ->> 'value')::numeric > 0 then ' (بقيمة ' || everwake.fmt_int((l -> 'abandoned' ->> 'value')::numeric) || sym || ')' else '' end
       || E'\n' || '• برّه مناطق التوصيل: ' || (l -> 'out_of_area' ->> 'count')
       || coalesce(' — أكتر منطقة: ' || (select ar ->> 'area' from jsonb_array_elements(l -> 'out_of_area' -> 'areas') ar
                                        where ar ->> 'area' <> '—' limit 1), '')
       || E'\n' || '• كتبوا والفروع مقفولة: ' || (l -> 'while_closed' ->> 'count')
       || case when (l ->> 'handoffs')::int > 0 then E'\n' || '🙋 محادثات محتاجة حد من الفريق: ' || (l ->> 'handoffs') else '' end;
  return v;
end $$;

-- the dashboard's preview and "send it now"
create or replace function everwake.report_preview(p_tenant uuid)
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  return everwake.report_text(p_tenant, now() - interval '24 hours', now());
end $$;

create or replace function everwake.queue_report(p_tenant uuid, p_body text)
returns int language plpgsql as $$
declare t everwake.tenants%rowtype; v_ch uuid; v_to text; n int := 0;
begin
  select * into t from everwake.tenants where id = p_tenant;
  select ch.id into v_ch from everwake.whatsapp_channels ch where ch.tenant_id = p_tenant and ch.is_active order by ch.created_at limit 1;
  for v_to in select distinct everwake.wa_phone(x, t.country)
                from jsonb_array_elements_text(coalesce(everwake.merged_settings(t.settings) -> 'daily_report' -> 'numbers', '[]'::jsonb)) x loop
    continue when v_to is null;
    insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body, created_by)
    values (p_tenant, v_ch, v_to, 'report', p_body, everwake.current_user_id());
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function everwake.send_report_now(p_tenant uuid)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  return everwake.queue_report(p_tenant, everwake.report_text(p_tenant, now() - interval '24 hours', now()));
end $$;

-- from the housekeeping, every minute: each restaurant's report once a day, at its hour
create or replace function everwake.send_due_reports()
returns int language plpgsql as $$
declare r record; n int := 0; v_sent int;
begin
  for r in
    select t.id, (now() at time zone t.timezone) as local_now,
           coalesce(nullif(everwake.merged_settings(t.settings) -> 'daily_report' ->> 'time', ''), '10:00')::time as at_time
      from everwake.tenants t
     where t.status in ('onboarding', 'live')
       and coalesce((everwake.merged_settings(t.settings) -> 'daily_report' ->> 'enabled')::boolean, false)
       and jsonb_array_length(coalesce(everwake.merged_settings(t.settings) -> 'daily_report' -> 'numbers', '[]'::jsonb)) > 0
  loop
    continue when r.local_now::time < r.at_time;
    continue when exists (select 1 from everwake.report_runs where tenant_id = r.id and kind = 'daily' and local_day = r.local_now::date);
    v_sent := everwake.queue_report(r.id, everwake.report_text(r.id, now() - interval '24 hours', now()));
    insert into everwake.report_runs (tenant_id, kind, local_day, recipients) values (r.id, 'daily', r.local_now::date, v_sent);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.report_runs enable row level security;
grant all on everwake.report_runs to service_role;
revoke execute on all functions in schema everwake from public, anon;
revoke execute on function everwake.lost_sales_data(uuid, timestamptz, timestamptz), everwake.report_text(uuid, timestamptz, timestamptz),
  everwake.queue_report(uuid, text), everwake.send_due_reports() from authenticated;
grant execute on all functions in schema everwake to service_role;
grant execute on function
  everwake.savings(uuid), everwake.growth_sources(uuid, timestamptz, timestamptz, text[]),
  everwake.lost_sales(uuid, timestamptz, timestamptz), everwake.report_preview(uuid), everwake.send_report_now(uuid),
  everwake.fmt_int(numeric)
  to authenticated;

-- ================= 010_reservations.sql =================
-- =====================================================================
-- Everwake Orders · 010 · table bookings (dine-in)
--
-- A branch takes bookings on WhatsApp, by phone only (the agent gives the
-- number), or not at all. The agent gathers the booking in conversation —
-- branch, day, time, guests, name, phone, and an occasion or special
-- request if there is one — through the manage_reservation tool, which
-- checks every value (in the future, not too far ahead, while the branch is
-- open, not more guests than the branch seats). It writes the summary the
-- customer confirms; only a booking whose summary they agreed to, unchanged
-- since, is sent. Sending it puts a ticket on the branch's operations
-- WhatsApp and on the dashboard's Reservations page; the team confirms with
-- the customer, and confirming or declining there tells the customer.
-- =====================================================================

alter table everwake.branches
  add column reservations           text not null default 'off' check (reservations in ('off', 'whatsapp', 'phone')),
  add column reservation_note_ar    text,             -- e.g. "الحجز في الويك إند بالتليفون بس"
  add column reservation_max_guests int;              -- null = the restaurant's default
alter table everwake.tenants add column reservation_seq bigint not null default 1000;

create table everwake.reservations (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references everwake.tenants(id) on delete cascade,
  ref_no          text,
  wa_id           text not null,
  conversation_id bigint references everwake.conversations(id) on delete set null,
  customer_id     bigint references everwake.customers(id) on delete set null,
  branch_id       uuid references everwake.branches(id) on delete set null,
  status          text not null default 'draft'
                  check (status in ('draft', 'requested', 'confirmed', 'declined', 'cancelled', 'seated', 'no_show')),
  reserve_date    date,
  reserve_time    time,
  reserved_for    timestamptz,
  guests          int,
  occasion        text,
  full_name       text,
  phone           text,
  requests        text,
  source          text not null default 'whatsapp_agent',
  changed_at      timestamptz not null default now(),   -- last change to what the customer confirms
  summary_at      timestamptz,                          -- when the summary was shown
  requested_at    timestamptz,
  decided_at      timestamptz,
  decided_by      uuid,
  decline_reason  text,
  ops_notified    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, ref_no)
);
create unique index reservations_one_draft_uidx on everwake.reservations (tenant_id, wa_id) where status = 'draft';
create index reservations_board_idx on everwake.reservations (tenant_id, status, reserved_for);
create index reservations_customer_idx on everwake.reservations (tenant_id, wa_id, reserved_for desc);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- which branches book how, and the restaurant's rules
create or replace function everwake.reservation_setup(p_tenant uuid)
returns jsonb language sql stable as $$
  with s as (select everwake.merged_settings(settings) as s from everwake.tenants where id = p_tenant)
  select jsonb_build_object(
    'enabled', exists (select 1 from everwake.branches b where b.tenant_id = p_tenant and b.is_active and b.reservations = 'whatsapp'),
    'branches', coalesce((select jsonb_agg(jsonb_build_object(
                   'id', b.id, 'code', b.code, 'name_ar', b.name_ar, 'name_en', b.name_en, 'mode', b.reservations,
                   'note', b.reservation_note_ar, 'phone', b.phone, 'hours_text', b.hours_text_ar,
                   'max_guests', coalesce(b.reservation_max_guests, nullif(s.s ->> 'reservation_max_guests', '')::int, 20))
                   order by b.sort, b.name_ar)
                   from everwake.branches b where b.tenant_id = p_tenant and b.is_active and b.reservations <> 'off'), '[]'::jsonb),
    'occasions', coalesce(s.s -> 'reservation_occasions',
                          '["عيد ميلاد", "عيد جواز", "خطوبة", "اجتماع عمل", "عزومة عائلية"]'::jsonb),
    'lead_minutes', coalesce(nullif(s.s ->> 'reservation_lead_minutes', '')::int, 60),
    'days_ahead', coalesce(nullif(s.s ->> 'reservation_days_ahead', '')::int, 30))
  from s
$$;

create or replace function everwake.local_phone(p text)
returns text language sql immutable as $$
  select case when p is null then null when p ~ '^20[0-9]{10}$' then '0' || substr(p, 3) else p end
$$;

-- a booking as people read it
create or replace function everwake.reservation_view(r everwake.reservations)
returns jsonb language sql stable as $$
  select case when r.id is null then null else jsonb_strip_nulls(jsonb_build_object(
    'ref_no', r.ref_no, 'status', r.status,
    'branch', (select b.name_ar from everwake.branches b where b.id = r.branch_id),
    'branch_code', (select b.code from everwake.branches b where b.id = r.branch_id),
    'date', to_char(r.reserve_date, 'YYYY-MM-DD'),
    'day', case when r.reserve_date is not null then
             (array['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'])[extract(dow from r.reserve_date)::int + 1]
             || ' ' || to_char(r.reserve_date, 'DD/MM') end,
    'time', to_char(r.reserve_time, 'HH24:MI'),
    'time_ar', case when r.reserve_time is not null then
                 to_char(r.reserve_time, 'FMHH12:MI') || case when r.reserve_time < '12:00' then ' صباحاً' else ' مساءً' end end,
    'guests', r.guests, 'occasion', r.occasion, 'full_name', r.full_name, 'phone', everwake.local_phone(r.phone),
    'requests', r.requests,
    'summary', case when r.summary_at is null then 'not shown yet'
                    when r.summary_at >= r.changed_at then 'shown and still matches — a clear yes can be sent now'
                    else 'shown before, but something changed since — show the updated summary' end)) end
$$;

-- the summary the customer confirms (their language)
create or replace function everwake.reservation_summary(r everwake.reservations, p_lang text)
returns text language plpgsql stable as $$
declare v jsonb := everwake.reservation_view(r);
begin
  if p_lang = 'en' then
    return 'Your booking:' || E'\n'
      || '🏪 Branch: ' || coalesce(v ->> 'branch', '') || E'\n'
      || '📅 ' || to_char(r.reserve_date, 'Dy DD/MM') || ' · ' || to_char(r.reserve_time, 'FMHH12:MI AM') || E'\n'
      || '👥 ' || r.guests || case when r.guests = 1 then ' guest' else ' guests' end || E'\n'
      || coalesce('🎉 Occasion: ' || r.occasion || E'\n', '')
      || '👤 ' || coalesce(r.full_name, '') || ' · 📞 ' || coalesce(v ->> 'phone', '')
      || coalesce(E'\n' || '📝 ' || r.requests, '');
  end if;
  return 'تفاصيل الحجز:' || E'\n'
    || '🏪 الفرع: ' || coalesce(v ->> 'branch', '') || E'\n'
    || '📅 ' || coalesce(v ->> 'day', '') || ' · الساعة ' || coalesce(v ->> 'time_ar', '') || E'\n'
    || '👥 ' || r.guests || case when r.guests between 3 and 10 then ' أشخاص' else ' شخص' end || E'\n'
    || coalesce('🎉 المناسبة: ' || r.occasion || E'\n', '')
    || '👤 باسم: ' || coalesce(r.full_name, '') || ' · 📞 ' || coalesce(v ->> 'phone', '')
    || coalesce(E'\n' || '📝 طلبات خاصة: ' || r.requests, '');
end $$;

-- the ticket for the branch team
create or replace function everwake.reservation_ticket(r everwake.reservations, p_headline text)
returns text language sql stable as $$
  select p_headline || ' ' || coalesce(r.ref_no, '') || E'\n'
    || '🏪 فرع ' || coalesce((select name_ar from everwake.branches where id = r.branch_id), '') || E'\n'
    || '📅 ' || coalesce(v ->> 'day', '') || ' · الساعة ' || coalesce(v ->> 'time_ar', '') || E'\n'
    || '👥 ' || r.guests || ' أشخاص' || coalesce(' · 🎉 ' || r.occasion, '') || E'\n'
    || '👤 ' || coalesce(r.full_name, '') || ' · 📞 ' || coalesce(v ->> 'phone', '')
    || coalesce(E'\n' || '📝 ' || r.requests, '')
  from (select everwake.reservation_view(r) as v) x
$$;

create or replace function everwake.queue_reservation_ticket(r everwake.reservations, p_body text)
returns boolean language plpgsql as $$
declare v_to text; v_ch uuid;
begin
  select everwake.wa_phone(coalesce(nullif(b.ops_whatsapp, ''), nullif(everwake.merged_settings(t.settings) ->> 'ops_whatsapp', '')), t.country)
    into v_to
    from everwake.tenants t left join everwake.branches b on b.id = r.branch_id
   where t.id = r.tenant_id;
  if v_to is null then return false; end if;
  select ch.id into v_ch from everwake.whatsapp_channels ch where ch.tenant_id = r.tenant_id and ch.is_active order by ch.created_at limit 1;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body) values (r.tenant_id, v_ch, v_to, 'order_ticket', p_body);
  return true;
end $$;

-- ---------------------------------------------------------------------
-- The agent's tool
-- actions: update (details_json with any of branch, date YYYY-MM-DD,
-- time HH:MM, guests, full_name, phone, occasion, requests) · summary ·
-- submit · cancel · status
-- ---------------------------------------------------------------------
create or replace function everwake.reservation_tool(p_tenant uuid, p_wa text, p_action text, p_details text)
returns jsonb language plpgsql as $$
declare
  t        everwake.tenants%rowtype;
  setup    jsonb := everwake.reservation_setup(p_tenant);
  v        jsonb;
  r        everwake.reservations%rowtype;
  b        everwake.branches%rowtype;
  bset     jsonb;
  conv     everwake.conversations%rowtype;
  cust     everwake.customers%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  problems jsonb := '[]'::jsonb;
  missing  text[] := '{}';
  v_local  timestamp;
  v_txt    text;
  v_d      date;
  v_t      time;
  v_n      int;
  v_max    int;
  v_changed boolean := false;
  v_ready  boolean;
  v_lang   text := everwake.customer_language(p_tenant, p_wa);
  upcoming jsonb;
begin
  select * into t from everwake.tenants where id = p_tenant;
  begin
    v := coalesce(nullif(btrim(coalesce(p_details, '')), '')::jsonb, '{}'::jsonb);
  exception when others then
    v := '{}'::jsonb;
    problems := problems || jsonb_build_object('problem', 'BAD_DETAILS_JSON', 'fact', 'details_json was not a JSON object — send {"field":"value"}');
  end;
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;

  upcoming := coalesce((select jsonb_agg(everwake.reservation_view(x) order by x.reserved_for)
                          from everwake.reservations x
                         where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status in ('requested', 'confirmed')
                           and x.reserved_for > now() - interval '3 hours'), '[]'::jsonb);

  if not coalesce((setup ->> 'enabled')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'NOT_TAKEN_ON_WHATSAPP',
      'fact', 'this restaurant does not take table bookings on WhatsApp',
      'by_phone', (select coalesce(jsonb_agg(jsonb_build_object('branch', x ->> 'name_ar', 'phone', x ->> 'phone', 'note', x ->> 'note')), '[]'::jsonb)
                     from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'phone'),
      'upcoming', upcoming);
  end if;
  if v_action not in ('update', 'summary', 'submit', 'cancel', 'status') then
    return jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION', 'fact', 'action is one of: update, summary, submit, cancel, status');
  end if;

  -- ---- cancel -----------------------------------------------------------
  if v_action = 'cancel' then
    delete from everwake.reservations where tenant_id = p_tenant and wa_id = p_wa and status = 'draft' returning * into r;
    if found then return jsonb_build_object('ok', true, 'status', 'DRAFT_DISCARDED', 'upcoming', upcoming); end if;
    select * into r from everwake.reservations
     where tenant_id = p_tenant and wa_id = p_wa and status in ('requested', 'confirmed') and reserved_for > now()
       and (nullif(v ->> 'ref_no', '') is null or upper(ref_no) = upper(v ->> 'ref_no'))
     order by reserved_for limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CANCEL', 'upcoming', upcoming); end if;
    update everwake.reservations set status = 'cancelled', decided_at = now(), decline_reason = 'cancelled by the customer on WhatsApp'
     where id = r.id returning * into r;
    perform everwake.queue_reservation_ticket(r, everwake.reservation_ticket(r, '❌ العميل لغى الحجز'));
    return jsonb_build_object('ok', true, 'status', 'CANCELLED', 'reservation', everwake.reservation_view(r),
                              'fact', 'cancelled; the branch team was told');
  end if;

  -- ---- the booking in progress -------------------------------------------------
  select * into r from everwake.reservations where tenant_id = p_tenant and wa_id = p_wa and status = 'draft' for update;
  if not found and v_action = 'status' then
    return jsonb_build_object('ok', true, 'status', 'NO_BOOKING_IN_PROGRESS', 'upcoming', upcoming);
  end if;
  if not found then
    select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
    select * into cust from everwake.customers where id = conv.customer_id;
    insert into everwake.reservations (tenant_id, wa_id, conversation_id, customer_id, full_name, phone)
    values (p_tenant, p_wa, conv.id, cust.id, nullif(cust.full_name, ''),
            case when not coalesce(cust.phone_hidden, false) then everwake.wa_phone(coalesce(cust.phone, case when p_wa ~ '^[0-9]+$' then p_wa end), t.country) end)
    returning * into r;
    -- one branch takes bookings: that is the branch
    if jsonb_array_length((select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp')) = 1
       and (select count(*) from jsonb_array_elements(setup -> 'branches')) = 1 then
      update everwake.reservations set branch_id = (setup -> 'branches' -> 0 ->> 'id')::uuid where id = r.id returning * into r;
    end if;
  end if;

  if v_action = 'update' then
    -- branch
    if nullif(btrim(coalesce(v ->> 'branch', '')), '') is not null then
      v_txt := everwake.norm(v ->> 'branch');
      select * into b from everwake.branches x
       where x.tenant_id = p_tenant and x.is_active
         and (everwake.norm(x.code) = v_txt or everwake.norm(x.name_ar) = v_txt or everwake.norm(coalesce(x.name_en, '')) = v_txt
              or v_txt = any (select everwake.norm(a) from unnest(x.aliases) a)
              or (length(v_txt) >= 3 and (everwake.norm(x.name_ar) like '%' || v_txt || '%' or v_txt like '%' || everwake.norm(x.name_ar) || '%')))
       order by (everwake.norm(x.code) = v_txt or everwake.norm(x.name_ar) = v_txt) desc, x.sort
       limit 1;
      if b.id is null then
        problems := problems || jsonb_build_object('problem', 'BRANCH_UNKNOWN', 'said', v ->> 'branch',
          'branches_taking_bookings', (select jsonb_agg(x ->> 'name_ar') from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp'));
      elsif b.reservations = 'phone' then
        problems := problems || jsonb_build_object('problem', 'BOOKED_BY_PHONE_ONLY', 'branch', b.name_ar, 'phone', b.phone, 'note', b.reservation_note_ar,
          'fact', 'this branch takes bookings by phone only — give them the number');
      elsif b.reservations = 'off' then
        problems := problems || jsonb_build_object('problem', 'NO_BOOKINGS_AT_THIS_BRANCH', 'branch', b.name_ar,
          'no_seating', b.dine_in is false,          -- delivery and pickup only (012)
          'branches_taking_bookings', (select jsonb_agg(x ->> 'name_ar') from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp'));
      elsif r.branch_id is distinct from b.id then
        r.branch_id := b.id; v_changed := true;
      end if;
    end if;
    -- day and time
    if nullif(btrim(coalesce(v ->> 'date', '')), '') is not null then
      begin
        v_d := to_date(btrim(v ->> 'date'), 'YYYY-MM-DD');
        if btrim(v ->> 'date') !~ '^\d{4}-\d{1,2}-\d{1,2}$' then raise exception 'format'; end if;
        if r.reserve_date is distinct from v_d then r.reserve_date := v_d; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'DATE_FORMAT', 'said', v ->> 'date', 'fact', 'send the date as YYYY-MM-DD, worked out from "Now" in FACTS');
      end;
    end if;
    if nullif(btrim(coalesce(v ->> 'time', '')), '') is not null then
      begin
        v_txt := btrim(v ->> 'time');
        if v_txt ~ '^\d{1,2}$' then v_txt := v_txt || ':00'; end if;
        if v_txt !~ '^\d{1,2}:\d{2}$' then raise exception 'format'; end if;
        v_t := v_txt::time;
        if r.reserve_time is distinct from v_t then r.reserve_time := v_t; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'TIME_FORMAT', 'said', v ->> 'time', 'fact', 'send the time as HH:MM on the 24-hour clock (9 at night = 21:00)');
      end;
    end if;
    -- guests
    if nullif(btrim(coalesce(v ->> 'guests', '')), '') is not null then
      begin
        v_n := (v ->> 'guests')::numeric::int;
        if v_n < 1 then raise exception 'few'; end if;
        if r.guests is distinct from v_n then r.guests := v_n; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'GUESTS_FORMAT', 'said', v ->> 'guests', 'fact', 'guests is a whole number');
      end;
    end if;
    -- who
    if v ? 'full_name' and nullif(btrim(v ->> 'full_name'), '') is not null and r.full_name is distinct from btrim(v ->> 'full_name') then
      r.full_name := left(btrim(v ->> 'full_name'), 80); v_changed := true;
    end if;
    if nullif(btrim(coalesce(v ->> 'phone', '')), '') is not null then
      v_txt := everwake.wa_phone(v ->> 'phone', t.country);
      if v_txt is null then
        problems := problems || jsonb_build_object('problem', 'PHONE_FORMAT', 'said', v ->> 'phone', 'fact', 'that does not look like a phone number — ask again');
      elsif r.phone is distinct from v_txt then r.phone := v_txt; v_changed := true;
      end if;
    end if;
    if v ? 'occasion' and r.occasion is distinct from nullif(btrim(v ->> 'occasion'), '') then
      r.occasion := left(nullif(btrim(v ->> 'occasion'), ''), 80); v_changed := true;
    end if;
    if v ? 'requests' and r.requests is distinct from nullif(btrim(v ->> 'requests'), '') then
      r.requests := left(nullif(btrim(v ->> 'requests'), ''), 400); v_changed := true;
    end if;
    if v_changed then
      update everwake.reservations
         set branch_id = r.branch_id, reserve_date = r.reserve_date, reserve_time = r.reserve_time, guests = r.guests,
             full_name = r.full_name, phone = r.phone, occasion = r.occasion, requests = r.requests,
             changed_at = clock_timestamp(), updated_at = now()
       where id = r.id returning * into r;
    end if;
  end if;

  -- ---- does it work as it stands? ---------------------------------------------------
  b := null;
  if r.branch_id is not null then
    select * into b from everwake.branches where id = r.branch_id;
    select x into bset from jsonb_array_elements(setup -> 'branches') x where x ->> 'id' = r.branch_id::text;
    v_max := coalesce((bset ->> 'max_guests')::int, 20);
  end if;
  if r.reserve_date is not null and r.reserve_time is not null then
    v_local := r.reserve_date + r.reserve_time;
    r.reserved_for := v_local at time zone t.timezone;
    update everwake.reservations set reserved_for = r.reserved_for where id = r.id and reserved_for is distinct from r.reserved_for;
    if r.reserved_for < now() + make_interval(mins => (setup ->> 'lead_minutes')::int) then
      problems := problems || jsonb_build_object('problem', 'TOO_SOON',
        'fact', 'bookings are taken at least ' || (setup ->> 'lead_minutes') || ' minutes ahead — suggest a later time, or the branch number for right now',
        'earliest', to_char((now() + make_interval(mins => (setup ->> 'lead_minutes')::int)) at time zone t.timezone, 'YYYY-MM-DD HH24:MI'));
    elsif r.reserved_for > now() + make_interval(days => (setup ->> 'days_ahead')::int) then
      problems := problems || jsonb_build_object('problem', 'TOO_FAR_AHEAD', 'fact', 'bookings are taken up to ' || (setup ->> 'days_ahead') || ' days ahead');
    elsif b.id is not null and everwake.is_open_at(b.hours, v_local) = false then
      problems := problems || jsonb_build_object('problem', 'BRANCH_CLOSED_AT_THAT_TIME', 'branch', b.name_ar, 'hours', b.hours_text_ar,
        'fact', 'the branch is closed at that time — suggest a time within its hours');
    end if;
  end if;
  if r.guests is not null and v_max is not null and r.guests > v_max then
    problems := problems || jsonb_build_object('problem', 'GROUP_TOO_LARGE', 'max_guests', v_max,
      'fact', 'more than ' || v_max || ' guests is arranged by the team — take their details and mark a handoff');
  end if;

  if r.branch_id is null then missing := array_append(missing, 'branch'); end if;
  if r.reserve_date is null then missing := array_append(missing, 'date'); end if;
  if r.reserve_time is null then missing := array_append(missing, 'time'); end if;
  if r.guests is null then missing := array_append(missing, 'guests'); end if;
  if r.full_name is null then missing := array_append(missing, 'full_name'); end if;
  if r.phone is null then missing := array_append(missing, 'phone'); end if;
  v_ready := cardinality(missing) = 0
             and not exists (select 1 from jsonb_array_elements(problems) p
                              where p ->> 'problem' in ('TOO_SOON', 'TOO_FAR_AHEAD', 'BRANCH_CLOSED_AT_THAT_TIME', 'GROUP_TOO_LARGE'));

  if v_action = 'summary' then
    if not v_ready then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'reservation', everwake.reservation_view(r),
                                'missing', to_jsonb(missing), 'problems', problems);
    end if;
    update everwake.reservations set summary_at = clock_timestamp() where id = r.id returning * into r;
    return jsonb_build_object('ok', true, 'status', 'SUMMARY_READY', 'summary_text', everwake.reservation_summary(r, v_lang),
      'fact', 'show this summary as it is and ask them to confirm; send it only after a clear yes');
  end if;

  if v_action = 'submit' then
    if not v_ready then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'reservation', everwake.reservation_view(r),
                                'missing', to_jsonb(missing), 'problems', problems);
    end if;
    if r.summary_at is null or r.summary_at < r.changed_at then
      return jsonb_build_object('ok', false, 'error', 'SUMMARY_NOT_CONFIRMED',
        'fact', 'show the summary first (action summary) and send only after they say yes to it — it changed since, or was never shown');
    end if;
    update everwake.tenants set reservation_seq = reservation_seq + 1 where id = p_tenant returning * into t;
    update everwake.reservations
       set status = 'requested', requested_at = now(), updated_at = now(), ref_no = t.order_no_prefix || '-R' || t.reservation_seq
     where id = r.id returning * into r;
    update everwake.reservations
       set ops_notified = everwake.queue_reservation_ticket(r, everwake.reservation_ticket(r, '🍽 طلب حجز ترابيزة')
                            || E'\n\n' || 'كلّموا العميل وأكّدوا الحجز، وبعدها دوسوا «تأكيد» في صفحة الحجوزات عشان يوصله تأكيد على الواتساب.')
     where id = r.id returning * into r;
    return jsonb_build_object('ok', true, 'status', 'REQUESTED', 'ref_no', r.ref_no, 'reservation', everwake.reservation_view(r),
      'fact', 'sent to the branch team — they will contact the customer to confirm it. It is NOT confirmed yet: say so, warmly, with the reference number.');
  end if;

  -- update / status
  return jsonb_build_object('ok', true, 'status', case when v_changed then 'SAVED' else 'UNCHANGED' end,
    'reservation', everwake.reservation_view(r), 'missing', to_jsonb(missing), 'problems', problems,
    'ready_for_summary', v_ready, 'occasions', setup -> 'occasions', 'upcoming', upcoming);
end $$;

-- ---------------------------------------------------------------------
-- The dashboard: confirm, decline, seated, no-show, cancel
-- ---------------------------------------------------------------------
create or replace function everwake.set_reservation_status(p_id bigint, p_status text, p_note text default null,
                                                            p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  r      everwake.reservations%rowtype;
  s      jsonb;
  v      jsonb;
  v_lang text;
  v_body text;
  v_sent boolean := false;
  v_tpl  text;
begin
  select * into r from everwake.reservations where id = p_id for update;
  if not found or r.status = 'draft' then raise exception 'Booking not found'; end if;
  perform everwake.require_role(r.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(r.tenant_id, r.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if not (
       (r.status = 'requested' and p_status in ('confirmed', 'declined', 'cancelled'))
    or (r.status = 'confirmed' and p_status in ('seated', 'no_show', 'cancelled'))) then
    raise exception 'This booking is % and cannot become %', r.status, p_status;
  end if;
  update everwake.reservations
     set status = p_status, decided_at = now(), decided_by = everwake.current_user_id(), updated_at = now(),
         decline_reason = case when p_status in ('declined', 'cancelled') then nullif(btrim(coalesce(p_note, '')), '') else decline_reason end
   where id = r.id returning * into r;

  if coalesce(p_notify, true) and p_status in ('confirmed', 'declined', 'cancelled') then
    s := everwake.merged_settings((select settings from everwake.tenants where id = r.tenant_id));
    v_lang := everwake.customer_language(r.tenant_id, r.wa_id);
    v := everwake.reservation_view(r);
    v_tpl := nullif(btrim(coalesce(s -> 'templates' ->> ('reservation_' || p_status || '_' || v_lang), '')), '');
    v_body := coalesce(nullif(everwake.render_template(v_tpl, jsonb_build_object('ref_no', r.ref_no, 'branch', v ->> 'branch',
                                                  'day', v ->> 'day', 'time', v ->> 'time_ar', 'guests', r.guests,
                                                  'reason', coalesce(nullif(btrim(coalesce(p_note, '')), ''), ''))), ''),
      case
        when v_lang = 'en' and p_status = 'confirmed' then
          'Your table is confirmed ✅ ' || r.ref_no || E'\n' || coalesce(v ->> 'branch', '') || ' · ' || to_char(r.reserve_date, 'Dy DD/MM')
          || ' · ' || to_char(r.reserve_time, 'FMHH12:MI AM') || ' · ' || r.guests || ' guests' || E'\n' || 'See you then!'
        when v_lang = 'en' and p_status = 'declined' then
          'Sorry, we could not confirm booking ' || r.ref_no || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '. Shall we look at another time?'
        when v_lang = 'en' then 'Booking ' || r.ref_no || ' is cancelled' || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '.'
        when p_status = 'confirmed' then
          'تم تأكيد حجزك ✅ ' || r.ref_no || E'\n' || '🏪 ' || coalesce(v ->> 'branch', '') || ' · 📅 ' || coalesce(v ->> 'day', '')
          || ' · الساعة ' || coalesce(v ->> 'time_ar', '') || ' · 👥 ' || r.guests || E'\n' || 'مستنيينك!'
        when p_status = 'declined' then
          'للأسف مش هنقدر نأكد الحجز ' || r.ref_no || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '. تحب نشوف معاد تاني؟'
        else 'تم إلغاء الحجز ' || r.ref_no || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '.'
      end);
    perform everwake.queue_customer_message(r.tenant_id, r.wa_id, 'order_status', v_body, p_user => everwake.current_user_id());
    v_sent := true;
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'notified', v_sent);
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.reservations enable row level security;
-- branch staff see their branches' bookings; a booking still being written in the chat is not shown
create policy member_read on everwake.reservations for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]) and everwake.can_see_branch(tenant_id, branch_id) and status <> 'draft');
grant select on everwake.reservations to authenticated;
grant all on everwake.reservations to service_role;

revoke execute on all functions in schema everwake from public, anon;
revoke execute on function everwake.reservation_tool(uuid, text, text, text),
  everwake.queue_reservation_ticket(everwake.reservations, text) from authenticated;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.set_reservation_status(bigint, text, text, boolean), everwake.reservation_setup(uuid),
  everwake.reservation_view(everwake.reservations), everwake.local_phone(text)
  to authenticated;

-- ================= 011_payments.sql =================
-- =====================================================================
-- Everwake Orders · 011 · paying online (Paymob)
--
-- A restaurant connects its own Paymob account (the money goes straight
-- to its bank; Everwake never holds it). Customers who choose "online"
-- get a payment link right after the agent places their order — a short
-- link on the dashboard's address that opens Paymob's checkout (card,
-- mobile wallet, whatever the restaurant switched on). Paymob tells the
-- dashboard when they pay; the order shows Paid, the customer and the
-- branch are told on WhatsApp, and the agent knows. Unpaid links get one
-- reminder and then expire, and the branch is asked to call the customer.
--
-- Payment links are made by the dashboard (it holds the Paymob calls and
-- checks Paymob's signature); this file keeps the rules and the records.
--
-- The secret key and the HMAC secret are kept in Supabase Vault: encrypted,
-- so a database backup or export shows only scrambled text. Only the
-- dashboard's server (service role) gets them back, through two functions.
-- =====================================================================

-- Supabase Vault (on by default in Supabase; local tests load a stand-in)
do $$
begin
  if to_regnamespace('vault') is null and exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension supabase_vault;
  end if;
end $$;

alter table everwake.orders
  add column payment_status text not null default 'none'
             check (payment_status in ('none', 'pending', 'paid', 'expired', 'refunded')),
  add column paid_at        timestamptz,
  add column paid_amount    numeric(12, 2);

-- one Paymob account per restaurant; the two secrets are only Vault ids here
create table everwake.payment_accounts (
  tenant_id             uuid primary key references everwake.tenants(id) on delete cascade,
  provider              text not null default 'paymob' check (provider in ('paymob')),
  enabled               boolean not null default false,
  public_key            text,
  secret_key_id         uuid,             -- the secret key, encrypted in Supabase Vault
  hmac_secret_id        uuid,             -- the HMAC secret, encrypted in Supabase Vault
  secret_hint           text,             -- the secret key's last 4 characters, to recognise it
  card_integration_id   bigint,
  wallet_integration_id bigint,
  other_integration_ids bigint[] not null default '{}',
  link_minutes          int not null default 60 check (link_minutes between 10 and 1440),
  reminder_minutes      int not null default 15 check (reminder_minutes between 0 and 1440),   -- 0 = no reminder
  billing_email         text,             -- Paymob asks for an e-mail; customers on WhatsApp rarely give one
  dashboard_url         text,             -- where links are made and Paymob reports payments (set by the settings page)
  is_live               boolean not null default false,
  last_callback_at      timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table everwake.payments (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references everwake.tenants(id) on delete cascade,
  order_id          bigint not null references everwake.orders(id) on delete cascade,
  provider          text not null default 'paymob',
  ref               text not null unique,       -- in the short link, and Paymob's special_reference
  amount            numeric(12, 2) not null,
  currency          text not null default 'EGP',
  status            text not null default 'creating'
                    check (status in ('creating', 'pending', 'paid', 'expired', 'replaced', 'cancelled', 'refunded')),
  link_url          text,                       -- Paymob's checkout page
  intention_id      text,
  provider_order_id bigint,
  transaction_id    bigint,
  method            text,                       -- card, wallet…
  card_brand        text,
  card_last4        text,
  attempts          int not null default 0,
  last_error        text,
  expires_at        timestamptz not null,
  reminded_at       timestamptz,
  paid_at           timestamptz,
  created_by        text not null default 'agent' check (created_by in ('agent', 'staff')),
  created_by_user   uuid,
  is_live           boolean not null default false,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index payments_order_idx on everwake.payments (order_id, created_at desc);
create index payments_open_idx on everwake.payments (status, expires_at) where status in ('creating', 'pending');
create index payments_provider_idx on everwake.payments (tenant_id, provider_order_id);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- a secret into Vault (new, or replacing the one at p_id); returns its id
create or replace function everwake.vault_put(p_id uuid, p_value text, p_name text)
returns uuid language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_id uuid;
begin
  if to_regnamespace('vault') is null then
    raise exception 'Supabase Vault is off: Supabase → Database → Extensions → turn on supabase_vault';
  end if;
  v_id := coalesce(p_id, (select s.id from vault.secrets s where s.name = p_name));
  if v_id is not null and exists (select 1 from vault.secrets s where s.id = v_id) then
    perform vault.update_secret(v_id, p_value);
    return v_id;
  end if;
  return vault.create_secret(p_value, p_name, 'Everwake Orders — a restaurant''s payment secret');
end $$;

-- a secret back from Vault (the dashboard's server only)
create or replace function everwake.vault_get(p_id uuid)
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  if p_id is null or to_regnamespace('vault') is null then return null; end if;
  -- only the secrets of a restaurant's payment account, nothing else kept in Vault
  if not exists (select 1 from everwake.payment_accounts a where p_id in (a.secret_key_id, a.hmac_secret_id)) then return null; end if;
  return (select s.decrypted_secret from vault.decrypted_secrets s where s.id = p_id);
end $$;

-- a restaurant removed: its secrets go too
create or replace function everwake.payment_account_forget()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  if to_regnamespace('vault') is not null then
    delete from vault.secrets where id in (old.secret_key_id, old.hmac_secret_id);
  end if;
  return old;
end $$;
create trigger payment_accounts_forget after delete on everwake.payment_accounts
  for each row execute function everwake.payment_account_forget();

-- 590 → "590ج", 12.5 → "12.5ج"
create or replace function everwake.money_text(n numeric, sym text)
returns text language sql immutable as $$
  select trim_scale(round(coalesce(n, 0), 2))::text || coalesce(sym, '')
$$;

-- "9:30 مساءً" / "9:30 PM" in the restaurant's clock
create or replace function everwake.local_clock(p timestamptz, p_tz text, p_lang text default 'ar')
returns text language sql stable as $$
  select case when p_lang = 'en' then to_char(p at time zone p_tz, 'FMHH12:MI AM')
              else to_char(p at time zone p_tz, 'FMHH12:MI')
                   || case when (p at time zone p_tz)::time < '12:00' then ' صباحاً' else ' مساءً' end end
$$;

-- a message to the branch's operations WhatsApp (or the restaurant's)
create or replace function everwake.queue_ops_ticket(p_tenant uuid, p_branch uuid, p_body text)
returns boolean language plpgsql as $$
declare v_to text; v_ch uuid;
begin
  select everwake.wa_phone(coalesce(nullif(b.ops_whatsapp, ''), nullif(everwake.merged_settings(t.settings) ->> 'ops_whatsapp', '')), t.country)
    into v_to
    from everwake.tenants t left join everwake.branches b on b.id = p_branch
   where t.id = p_tenant;
  if v_to is null then return false; end if;
  select ch.id into v_ch from everwake.whatsapp_channels ch where ch.tenant_id = p_tenant and ch.is_active order by ch.created_at limit 1;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body) values (p_tenant, v_ch, v_to, 'order_ticket', p_body);
  return true;
end $$;

-- the restaurant's wording if it has one, else ours
create or replace function everwake.payment_message(p_tenant uuid, p_wa text, p_key text, p_vars jsonb)
returns text language plpgsql stable as $$
declare
  v_lang text := everwake.customer_language(p_tenant, p_wa);
  v_tpl  text := nullif(btrim(coalesce(everwake.merged_settings((select settings from everwake.tenants where id = p_tenant))
                                         -> 'templates' ->> (p_key || '_' || v_lang), '')), '');
begin
  if v_tpl is null then
    v_tpl := case p_key || '_' || v_lang
      when 'payment_link_ar' then 'لينك الدفع لطلبك {order_no} — {amount}:' || E'\n' || '{link}' || E'\n' || 'اللينك شغال لحد {until}.'
      when 'payment_link_en' then 'Here is the payment link for order {order_no} — {amount}:' || E'\n' || '{link}' || E'\n' || 'It works until {until}.'
      when 'payment_paid_ar' then 'تم استلام الدفع ✅ {amount} لطلبك {order_no}. شكراً!'
      when 'payment_paid_en' then 'Payment received ✅ {amount} for your order {order_no}. Thank you!'
      when 'payment_reminder_ar' then 'لسه مستنيين الدفع لطلبك {order_no} ({amount}) 🙏' || E'\n' || '{link}' || E'\n' || 'لو حابب تدفع كاش عند الاستلام قولّنا.'
      when 'payment_reminder_en' then 'We are still waiting for the payment for order {order_no} ({amount}) 🙏' || E'\n' || '{link}' || E'\n' || 'Prefer cash on delivery? Just tell us.'
      when 'payment_cash_ar' then 'تمام، طلبك {order_no} هيتدفع كاش عند الاستلام.'
      when 'payment_cash_en' then 'All set — order {order_no} will be paid in cash on delivery.'
      else '' end;
  end if;
  return everwake.render_template(v_tpl, p_vars);
end $$;

-- the short link customers get: on the dashboard's address, so it is short, says
-- "already paid" or "expired" instead of an error, and leads back to WhatsApp
create or replace function everwake.payment_short_url(p_tenant uuid, p_ref text)
returns text language sql stable as $$
  select a.dashboard_url || '/p/' || p_ref from everwake.payment_accounts a where a.tenant_id = p_tenant
$$;

-- ---------------------------------------------------------------------
-- The restaurant's settings (owners and managers)
-- ---------------------------------------------------------------------
create or replace function everwake.payment_account_view(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare a everwake.payment_accounts%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into a from everwake.payment_accounts where tenant_id = p_tenant;
  if not found then return jsonb_build_object('connected', false); end if;
  return jsonb_build_object(
    'connected', a.enabled, 'provider', a.provider, 'public_key', a.public_key,
    'has_secret_key', a.secret_key_id is not null, 'secret_hint', case when a.secret_key_id is not null then '…' || a.secret_hint end,
    'has_hmac_secret', a.hmac_secret_id is not null,
    'card_integration_id', a.card_integration_id, 'wallet_integration_id', a.wallet_integration_id,
    'other_integration_ids', to_jsonb(a.other_integration_ids), 'link_minutes', a.link_minutes,
    'reminder_minutes', a.reminder_minutes, 'billing_email', a.billing_email, 'dashboard_url', a.dashboard_url,
    'is_live', a.is_live, 'last_callback_at', a.last_callback_at, 'last_error', a.last_error, 'updated_at', a.updated_at);
end $$;

create or replace function everwake.save_payment_account(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  a      everwake.payment_accounts%rowtype;
  t      everwake.tenants%rowtype;
  v_txt  text;
  v_pm   jsonb;
  v_ids  bigint[];
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  insert into everwake.payment_accounts (tenant_id) values (p_tenant) on conflict do nothing;
  select * into a from everwake.payment_accounts where tenant_id = p_tenant for update;

  if p ? 'public_key' then a.public_key := nullif(btrim(p ->> 'public_key'), ''); end if;
  -- secrets go straight into Vault and are never shown back; an empty field keeps the saved one
  if nullif(btrim(coalesce(p ->> 'secret_key', '')), '') is not null then
    v_txt := btrim(p ->> 'secret_key');
    a.secret_key_id := everwake.vault_put(a.secret_key_id, v_txt, 'everwake_paymob_secret_key_' || p_tenant);
    a.secret_hint := right(v_txt, 4);
    a.is_live := position('_live_' in v_txt) > 0;
  end if;
  if nullif(btrim(coalesce(p ->> 'hmac_secret', '')), '') is not null then
    a.hmac_secret_id := everwake.vault_put(a.hmac_secret_id, btrim(p ->> 'hmac_secret'), 'everwake_paymob_hmac_' || p_tenant);
  end if;
  if p ? 'card_integration_id' then a.card_integration_id := nullif(everwake.digits(p ->> 'card_integration_id'), '')::bigint; end if;
  if p ? 'wallet_integration_id' then a.wallet_integration_id := nullif(everwake.digits(p ->> 'wallet_integration_id'), '')::bigint; end if;
  if p ? 'other_integration_ids' then
    select coalesce(array_agg(x::bigint), '{}') into a.other_integration_ids
      from (select nullif(everwake.digits(v), '') as x from jsonb_array_elements_text(coalesce(p -> 'other_integration_ids', '[]'::jsonb)) v) q
     where x is not null;
  end if;
  if p ? 'link_minutes' then a.link_minutes := greatest(10, least(1440, coalesce((p ->> 'link_minutes')::int, 60))); end if;
  if p ? 'reminder_minutes' then a.reminder_minutes := greatest(0, least(1440, coalesce((p ->> 'reminder_minutes')::int, 15))); end if;
  if p ? 'billing_email' then a.billing_email := nullif(btrim(p ->> 'billing_email'), ''); end if;
  if nullif(btrim(coalesce(p ->> 'dashboard_url', '')), '') is not null then
    a.dashboard_url := regexp_replace(btrim(p ->> 'dashboard_url'), '/+$', '');
  end if;
  if p ? 'enabled' then a.enabled := coalesce((p ->> 'enabled')::boolean, false); end if;

  v_ids := array_remove(array[a.card_integration_id, a.wallet_integration_id], null) || a.other_integration_ids;
  if a.enabled then
    v_txt := case
      when a.public_key is null then 'the public key'
      when a.secret_key_id is null then 'the secret key'
      when a.hmac_secret_id is null then 'the HMAC secret'
      when cardinality(v_ids) = 0 then 'at least one integration ID'
      when a.dashboard_url is null then 'the dashboard address' end;
    if v_txt is not null then raise exception 'Paymob needs % before it can be switched on', v_txt; end if;
    if (a.public_key like '%\_live\_%') <> a.is_live then
      raise exception 'The public key and the secret key must both be test keys or both be live keys';
    end if;
  end if;

  update everwake.payment_accounts
     set public_key = a.public_key, secret_key_id = a.secret_key_id, hmac_secret_id = a.hmac_secret_id,
         secret_hint = a.secret_hint, is_live = a.is_live,
         card_integration_id = a.card_integration_id, wallet_integration_id = a.wallet_integration_id,
         other_integration_ids = a.other_integration_ids, link_minutes = a.link_minutes,
         reminder_minutes = a.reminder_minutes, billing_email = a.billing_email, dashboard_url = a.dashboard_url,
         enabled = a.enabled, last_error = case when a.enabled then null else last_error end, updated_at = now()
   where tenant_id = p_tenant;

  -- "online" is offered to customers exactly while Paymob is switched on
  select * into t from everwake.tenants where id = p_tenant for update;
  v_pm := coalesce(t.settings -> 'payment_methods', everwake.merged_settings(t.settings) -> 'payment_methods', '["cash"]'::jsonb);
  v_pm := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(v_pm) x where x <> 'online'), '[]'::jsonb);
  if a.enabled then v_pm := v_pm || '["online"]'::jsonb; end if;
  update everwake.tenants set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('payment_methods', v_pm) where id = p_tenant;

  return everwake.payment_account_view(p_tenant);
end $$;

-- who may make a link for this order (any team member who sees its branch),
-- or test the account (owners and managers)
create or replace function everwake.payment_authorize(p_order bigint default null, p_tenant uuid default null)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare o everwake.orders%rowtype;
begin
  if p_order is null then
    perform everwake.require_role(p_tenant, array['owner', 'manager']);
    return jsonb_build_object('tenant_id', p_tenant);
  end if;
  select * into o from everwake.orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  return jsonb_build_object('tenant_id', o.tenant_id, 'order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- Making a link (the dashboard's server calls these, with the service role)
-- ---------------------------------------------------------------------

-- right after the agent places an order: does it need a link, and where to ask for one?
create or replace function everwake.payment_after_place(p_tenant uuid, p_order_no text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'needed', coalesce(o.payment_method = 'online' and o.payment_status <> 'paid' and a.enabled and a.dashboard_url is not null, false),
    'endpoint', a.dashboard_url || '/api/pay/link',
    'tenant_id', p_tenant, 'order_no', p_order_no)
  from everwake.orders o
  left join everwake.payment_accounts a on a.tenant_id = o.tenant_id
  where o.tenant_id = p_tenant and o.order_no = p_order_no
$$;

-- everything Paymob needs for one link, and a payment row waiting for it.
-- p_order_no null = a test link from the settings page (no order, no row).
create or replace function everwake.payment_prepare(p_tenant uuid, p_order_no text, p_amount numeric default null,
                                                     p_by uuid default null)
returns jsonb language plpgsql as $$
declare
  a       everwake.payment_accounts%rowtype;
  t       everwake.tenants%rowtype;
  o       everwake.orders%rowtype;
  c       jsonb;
  v_ids   bigint[];
  v_amt   numeric;
  v_ref   text;
  v_id    bigint;
  v_name  text;
  v_phone text;
  v_why   text;
  v_cents bigint;
begin
  select * into a from everwake.payment_accounts where tenant_id = p_tenant;
  v_ids := array_remove(array[a.card_integration_id, a.wallet_integration_id], null) || coalesce(a.other_integration_ids, '{}');
  if a.tenant_id is null or not a.enabled or a.secret_key_id is null or a.public_key is null or cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'error', 'NOT_CONNECTED', 'fact', 'paying online is not set up for this restaurant');
  end if;
  select * into t from everwake.tenants where id = p_tenant;

  if p_order_no is null then
    v_ref := 'test-' || substr(everwake.random_token(), 1, 10);
    v_cents := round(coalesce(p_amount, 10) * 100)::bigint;
    return jsonb_build_object('ok', true, 'test', true, 'ref', v_ref, 'amount', coalesce(p_amount, 10), 'amount_cents', v_cents,
      'currency', t.currency, 'secret_key', everwake.vault_get(a.secret_key_id), 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
      'expiration', 900,
      'billing', jsonb_build_object('first_name', 'Everwake', 'last_name', 'Test', 'phone_number', '+201000000000',
                                    'email', coalesce(a.billing_email, 'customer@everwake.tech'), 'street', 'NA', 'building', 'NA',
                                    'floor', 'NA', 'apartment', 'NA', 'city', 'NA', 'state', 'NA', 'country', 'EG'),
      'items', jsonb_build_array(jsonb_build_object('name', 'Test payment', 'amount', v_cents, 'quantity', 1)),
      'notification_url', a.dashboard_url || '/api/pay/paymob/' || p_tenant,
      'redirection_url', null, 'short_url', null);
  end if;

  select * into o from everwake.orders where tenant_id = p_tenant and order_no = p_order_no for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;
  if o.status in ('draft', 'rejected', 'cancelled') then
    return jsonb_build_object('ok', false, 'error', 'ORDER_CLOSED', 'fact', 'the order is ' || o.status);
  end if;
  if o.payment_status = 'paid' then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_PAID', 'fact', 'this order is already paid');
  end if;

  if p_amount is null then
    -- a link is only for a total that will not change
    v_why := case
      when o.delivery_method = 'delivery' and o.delivery_fee is null then 'the delivery fee is still to be confirmed by the branch'
      when o.vat is null and (select b.vat_percent from everwake.branches b where b.id = o.branch_id) is null
        then 'the branch still adds its fees to this total'
      when exists (select 1 from jsonb_array_elements(coalesce(o.cart -> 'items', '[]'::jsonb)) i
                    where i ->> 'price_known' = 'false' or i ->> 'extra_charge' = 'true')
        then 'a price in the order is still to be confirmed by the branch' end;
    if v_why is not null then
      update everwake.conversations
         set needs_attention = true, attention_at = now(),
             attention_reason = 'لينك الدفع للطلب ' || o.order_no || ' بعد ما الفرع يأكد الإجمالي'
       where tenant_id = p_tenant and wa_id = o.wa_id;
      return jsonb_build_object('ok', false, 'error', 'TOTAL_NOT_FINAL', 'reason', v_why,
        'fact', 'no payment link yet: ' || v_why || '. The team confirms the total and sends the link.');
    end if;
  end if;
  v_amt := round(coalesce(p_amount, o.total), 2);
  if v_amt < 1 then return jsonb_build_object('ok', false, 'error', 'AMOUNT_TOO_SMALL'); end if;
  v_cents := round(v_amt * 100)::bigint;

  v_ref := substr(everwake.random_token(), 1, 12);
  insert into everwake.payments (tenant_id, order_id, ref, amount, currency, expires_at, created_by, created_by_user, is_live)
  values (p_tenant, o.id, v_ref, v_amt, o.currency, now() + make_interval(mins => a.link_minutes),
          case when p_by is null then 'agent' else 'staff' end, p_by, a.is_live)
  returning id into v_id;

  c := coalesce(o.customer, '{}'::jsonb);
  v_name := coalesce(nullif(btrim(c ->> 'full_name'), ''), 'Customer');
  v_phone := coalesce(nullif(everwake.digits(c ->> 'phone'), ''), nullif(everwake.digits(o.wa_id), ''), '201000000000');
  return jsonb_build_object('ok', true, 'payment_id', v_id, 'ref', v_ref, 'order_no', o.order_no, 'amount', v_amt,
    'amount_cents', v_cents, 'currency', o.currency, 'currency_symbol', t.currency_symbol_ar,
    'secret_key', everwake.vault_get(a.secret_key_id), 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
    'expiration', a.link_minutes * 60,
    'billing', jsonb_build_object(
      'first_name', left(split_part(v_name, ' ', 1), 50),
      'last_name', left(coalesce(nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), 'NA'), 50),
      'phone_number', '+' || v_phone, 'email', coalesce(a.billing_email, 'customer@everwake.tech'),
      'street', coalesce(nullif(o.address ->> 'street', ''), 'NA'), 'building', coalesce(nullif(o.address ->> 'building', ''), 'NA'),
      'floor', coalesce(nullif(o.address ->> 'floor', ''), 'NA'), 'apartment', coalesce(nullif(o.address ->> 'apartment', ''), 'NA'),
      'city', coalesce(nullif(o.address ->> 'city', ''), 'NA'), 'state', 'NA', 'country', 'EG'),
    'items', jsonb_build_array(jsonb_build_object('name', 'طلب ' || o.order_no, 'amount', v_cents, 'quantity', 1,
                                                  'description', coalesce(t.name_ar, t.name_en))),
    'notification_url', a.dashboard_url || '/api/pay/paymob/' || p_tenant,
    'redirection_url', a.dashboard_url || '/p/' || v_ref || '/done',
    'short_url', a.dashboard_url || '/p/' || v_ref);
end $$;

-- Paymob made the checkout: the link is live (and, from the dashboard, sent)
create or replace function everwake.payment_link_saved(p_payment bigint, p_link text, p_intention text,
                                                        p_provider_order bigint, p_send boolean default false)
returns jsonb language plpgsql as $$
declare
  p      everwake.payments%rowtype;
  o      everwake.orders%rowtype;
  t      everwake.tenants%rowtype;
  v_url  text;
  v_body text;
begin
  update everwake.payments
     set status = 'pending', link_url = p_link, intention_id = p_intention, provider_order_id = p_provider_order, updated_at = now()
   where id = p_payment and status = 'creating'
  returning * into p;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_WAITING_FOR_A_LINK'); end if;
  -- one open link per order: the new one replaces the old (only now that it exists — a failed try keeps the old one)
  update everwake.payments set status = 'replaced', updated_at = now()
   where order_id = p.order_id and id <> p.id and status in ('creating', 'pending');
  update everwake.orders set payment_status = 'pending', updated_at = now()
   where id = p.order_id and payment_status <> 'paid' returning * into o;
  if not found then select * into o from everwake.orders where id = p.order_id; end if;
  select * into t from everwake.tenants where id = p.tenant_id;
  v_url := everwake.payment_short_url(p.tenant_id, p.ref);

  if p_send then
    v_body := everwake.payment_message(p.tenant_id, o.wa_id, 'payment_link', jsonb_build_object(
      'order_no', o.order_no, 'amount', everwake.money_text(p.amount, t.currency_symbol_ar), 'link', v_url,
      'until', everwake.local_clock(p.expires_at, t.timezone, everwake.customer_language(p.tenant_id, o.wa_id))));
    perform everwake.queue_customer_message(p.tenant_id, o.wa_id, 'order_status', v_body, p_user => p.created_by_user);
  end if;
  insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, note, notified)
  values (p.tenant_id, o.id, 'payment_link', case when p.created_by = 'agent' then 'agent' else 'staff' end, p.created_by_user,
          everwake.money_text(p.amount, t.currency_symbol_ar), p_send or p.created_by = 'agent');

  return jsonb_build_object('ok', true, 'status', 'LINK_READY', 'link', v_url, 'amount', p.amount,
    'valid_until', everwake.local_clock(p.expires_at, t.timezone, everwake.customer_language(p.tenant_id, o.wa_id)),
    'expires_at', p.expires_at, 'sent', p_send);
end $$;

-- Paymob refused: nothing is live; the restaurant sees why
create or replace function everwake.payment_link_failed(p_payment bigint, p_error text)
returns jsonb language plpgsql as $$
declare p everwake.payments%rowtype;
begin
  update everwake.payments set status = 'cancelled', last_error = left(p_error, 500), updated_at = now()
   where id = p_payment and status = 'creating' returning * into p;
  if not found then return jsonb_build_object('ok', false); end if;
  update everwake.payment_accounts set last_error = left(p_error, 500), updated_at = now() where tenant_id = p.tenant_id;
  update everwake.conversations c
     set needs_attention = true, attention_at = now(),
         attention_reason = 'لينك الدفع مطلعش للطلب ' || o.order_no || ' — ابعتوه من صفحة الطلبات أو حوّلوه كاش'
    from everwake.orders o
   where o.id = p.order_id and c.tenant_id = o.tenant_id and c.wa_id = o.wa_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Paymob reports a payment (the dashboard checked its signature first)
-- p: transaction_id, provider_order_id, merchant_order_id (= our ref),
--    success, pending, amount_cents, currency, is_refunded, is_voided,
--    method, card_brand, card_last4, error
-- ---------------------------------------------------------------------
create or replace function everwake.payment_callback(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare
  pay     everwake.payments%rowtype;
  o       everwake.orders%rowtype;
  t       everwake.tenants%rowtype;
  v_amt   text;
  v_body  text;
  v_twice boolean;
  v_ok    boolean := coalesce((p ->> 'success')::boolean, false);
  v_pend  boolean := coalesce((p ->> 'pending')::boolean, false);
  v_back  boolean := coalesce((p ->> 'is_refunded')::boolean, false) or coalesce((p ->> 'is_voided')::boolean, false);
begin
  update everwake.payment_accounts set last_callback_at = now() where tenant_id = p_tenant;
  select * into pay from everwake.payments
   where tenant_id = p_tenant
     and (ref = nullif(p ->> 'merchant_order_id', '')
          or (nullif(p ->> 'merchant_order_id', '') is null and provider_order_id = nullif(p ->> 'provider_order_id', '')::bigint))
   order by id desc limit 1 for update;
  if not found then return jsonb_build_object('ok', true, 'matched', false); end if;
  select * into o from everwake.orders where id = pay.order_id for update;
  select * into t from everwake.tenants where id = pay.tenant_id;
  v_amt := everwake.money_text(pay.amount, t.currency_symbol_ar);

  -- money given back from Paymob's dashboard
  if v_back then
    if pay.status = 'paid' then
      update everwake.payments set status = 'refunded', raw = p, updated_at = now() where id = pay.id;
      update everwake.orders set payment_status = 'refunded', updated_at = now() where id = o.id;
      insert into everwake.order_events (tenant_id, order_id, status, by_role, note)
      values (o.tenant_id, o.id, 'payment_refunded', 'system', v_amt);
      perform everwake.queue_ops_ticket(o.tenant_id, o.branch_id, '↩️ اترد مبلغ ' || v_amt || ' للطلب ' || o.order_no);
      return jsonb_build_object('ok', true, 'matched', true, 'status', 'refunded', 'queued', true);
    end if;
    return jsonb_build_object('ok', true, 'matched', true, 'status', pay.status);
  end if;

  if v_pend then
    update everwake.payments set raw = p, updated_at = now() where id = pay.id;
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'pending');
  end if;

  if not v_ok then
    -- a declined card: they can try again on the same link until it expires
    update everwake.payments set attempts = attempts + 1, last_error = left(coalesce(nullif(p ->> 'error', ''), 'declined'), 300),
                                 raw = p, updated_at = now()
     where id = pay.id;
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'declined');
  end if;

  if pay.status = 'paid' then return jsonb_build_object('ok', true, 'matched', true, 'status', 'paid', 'duplicate', true); end if;
  if (p ->> 'amount_cents')::bigint is distinct from round(pay.amount * 100)::bigint then
    update everwake.payments set last_error = 'AMOUNT_MISMATCH ' || (p ->> 'amount_cents'), raw = p, updated_at = now() where id = pay.id;
    perform everwake.queue_ops_ticket(o.tenant_id, o.branch_id,
      '⚠️ دفع أونلاين بمبلغ مختلف للطلب ' || o.order_no || ' — راجعوا لوحة Paymob');
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'amount_mismatch', 'queued', true);
  end if;

  -- paid (a late payment on an expired or replaced link still counts: the money arrived)
  v_twice := o.payment_status = 'paid';
  update everwake.payments
     set status = 'paid', paid_at = now(), transaction_id = nullif(p ->> 'transaction_id', '')::bigint,
         method = nullif(p ->> 'method', ''), card_brand = nullif(p ->> 'card_brand', ''), card_last4 = nullif(p ->> 'card_last4', ''),
         last_error = null, raw = p, updated_at = now()
   where id = pay.id;
  update everwake.orders
     set payment_status = 'paid', paid_at = coalesce(paid_at, now()), paid_amount = coalesce(paid_amount, 0) + pay.amount, updated_at = now()
   where id = o.id;
  insert into everwake.order_events (tenant_id, order_id, status, by_role, note, notified)
  values (o.tenant_id, o.id, 'payment_paid', 'system',
          v_amt || coalesce(' · ' || nullif(concat_ws(' ', p ->> 'card_brand', nullif(p ->> 'card_last4', '')), ''), ''), true);
  if o.status not in ('rejected', 'cancelled') then
    v_body := everwake.payment_message(o.tenant_id, o.wa_id, 'payment_paid',
                                       jsonb_build_object('order_no', o.order_no, 'amount', v_amt));
    perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status', v_body);
  end if;
  perform everwake.queue_ops_ticket(o.tenant_id, o.branch_id,
    case when v_twice then '⚠️ الطلب ' || o.order_no || ' اتدفع أونلاين مرتين (' || v_amt || ' زيادة) — رجّعوا الفرق من لوحة Paymob'
         when o.status in ('rejected', 'cancelled') then '⚠️ الطلب ' || o.order_no || ' (' || o.status || ') اتدفع أونلاين ' || v_amt || ' — رجّعوا المبلغ من لوحة Paymob'
         else '💳 اتدفع أونلاين: ' || o.order_no || ' — ' || v_amt end);
  update everwake.conversations
     set needs_attention = false, attention_reason = null
   where tenant_id = o.tenant_id and wa_id = o.wa_id and attention_reason like '%' || o.order_no || '%';
  return jsonb_build_object('ok', true, 'matched', true, 'status', 'paid', 'order_no', o.order_no, 'queued', true);
end $$;

create or replace function everwake.payment_hmac_secret(p_tenant uuid)
returns text language sql stable as $$
  select everwake.vault_get(hmac_secret_id) from everwake.payment_accounts where tenant_id = p_tenant
$$;

-- the short link's page: where to send the customer, or what to tell them
create or replace function everwake.payment_public(p_ref text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'tenant_id', p.tenant_id, 'ref', p.ref, 'status', p.status, 'link_url', p.link_url,
    'expired', p.expires_at < now(), 'amount', p.amount, 'amount_text', everwake.money_text(p.amount, t.currency_symbol_ar),
    'order_no', o.order_no, 'order_paid', o.payment_status = 'paid',
    'restaurant', coalesce(t.name_ar, t.name_en), 'restaurant_en', t.name_en,
    'logo_url', t.profile -> 'brand' ->> 'logo_url', 'color', t.profile -> 'brand' ->> 'color',
    'whatsapp', (select ch.phone_number from everwake.whatsapp_channels ch where ch.tenant_id = p.tenant_id and ch.is_active
                  order by ch.created_at limit 1),
    'language', everwake.customer_language(p.tenant_id, o.wa_id))
  from everwake.payments p
  join everwake.orders o on o.id = p.order_id
  join everwake.tenants t on t.id = p.tenant_id
  where p.ref = p_ref
$$;

-- ---------------------------------------------------------------------
-- Every minute (from the housekeeping): one reminder, then the link expires
-- and the branch is asked to call the customer
-- ---------------------------------------------------------------------
create or replace function everwake.payment_due()
returns int language plpgsql as $$
declare
  r      record;
  n      int := 0;
  v_body text;
begin
  for r in
    select p.*, o.wa_id, o.order_no, o.branch_id, t.currency_symbol_ar as sym, t.timezone
      from everwake.payments p
      join everwake.payment_accounts a on a.tenant_id = p.tenant_id
      join everwake.orders o on o.id = p.order_id
      join everwake.tenants t on t.id = p.tenant_id
     where p.status = 'pending' and p.reminded_at is null and a.reminder_minutes > 0
       and p.created_at < now() - make_interval(mins => a.reminder_minutes) and p.expires_at > now() + interval '2 minutes'
       and o.payment_status = 'pending' and o.status not in ('rejected', 'cancelled')
     for update of p skip locked
  loop
    update everwake.payments set reminded_at = now() where id = r.id;
    v_body := everwake.payment_message(r.tenant_id, r.wa_id, 'payment_reminder', jsonb_build_object(
      'order_no', r.order_no, 'amount', everwake.money_text(r.amount, r.sym), 'link', everwake.payment_short_url(r.tenant_id, r.ref),
      'until', everwake.local_clock(r.expires_at, r.timezone, everwake.customer_language(r.tenant_id, r.wa_id))));
    perform everwake.queue_customer_message(r.tenant_id, r.wa_id, 'order_status', v_body);
    n := n + 1;
  end loop;

  for r in
    select p.*, o.wa_id, o.order_no, o.branch_id, o.status as order_status, o.payment_status as order_payment
      from everwake.payments p join everwake.orders o on o.id = p.order_id
     where p.status in ('creating', 'pending') and p.expires_at < now()
     for update of p skip locked
  loop
    update everwake.payments set status = 'expired', updated_at = now() where id = r.id;
    if r.order_payment = 'pending' and r.order_status not in ('rejected', 'cancelled') then
      update everwake.orders set payment_status = 'expired', updated_at = now() where id = r.order_id;
      insert into everwake.order_events (tenant_id, order_id, status, by_role) values (r.tenant_id, r.order_id, 'payment_expired', 'system');
      perform everwake.queue_ops_ticket(r.tenant_id, r.branch_id,
        '⚠️ الطلب ' || r.order_no || ': لينك الدفع خلص ومتدفعش — كلّموا العميل، ابعتوا لينك جديد أو حوّلوه كاش من صفحة الطلبات.');
      update everwake.conversations
         set needs_attention = true, attention_at = now(), attention_reason = 'الدفع أونلاين مكملش للطلب ' || r.order_no
       where tenant_id = r.tenant_id and wa_id = r.wa_id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- The team: pay in cash instead, or mark it paid another way
-- ---------------------------------------------------------------------
create or replace function everwake.set_order_payment(p_order bigint, p_action text, p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  o everwake.orders%rowtype;
  t everwake.tenants%rowtype;
  v_sent boolean := false;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  select * into t from everwake.tenants where id = o.tenant_id;

  if p_action = 'cash' then
    if o.payment_status = 'paid' then raise exception 'This order is already paid online'; end if;
    update everwake.payments set status = 'cancelled', updated_at = now() where order_id = o.id and status in ('creating', 'pending');
    update everwake.orders set payment_method = 'cash', payment_status = 'none', updated_at = now() where id = o.id;
    if coalesce(p_notify, true) then
      perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status',
        everwake.payment_message(o.tenant_id, o.wa_id, 'payment_cash', jsonb_build_object('order_no', o.order_no)),
        p_user => everwake.current_user_id());
      v_sent := true;
    end if;
    insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, notified)
    values (o.tenant_id, o.id, 'payment_cash', 'staff', everwake.current_user_id(), v_sent);
  elsif p_action = 'mark_paid' then
    update everwake.payments set status = 'cancelled', updated_at = now() where order_id = o.id and status in ('creating', 'pending');
    update everwake.orders set payment_status = 'paid', paid_at = now(), paid_amount = o.total, updated_at = now() where id = o.id;
    insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, note)
    values (o.tenant_id, o.id, 'payment_paid', 'staff', everwake.current_user_id(), 'marked paid by the team');
  else
    raise exception 'action is cash or mark_paid';
  end if;
  update everwake.conversations
     set needs_attention = false, attention_reason = null
   where tenant_id = o.tenant_id and wa_id = o.wa_id and attention_reason like '%' || o.order_no || '%';
  return jsonb_build_object('id', o.id, 'action', p_action, 'notified', v_sent);
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.payment_accounts enable row level security;     -- no policies: only through the functions above
alter table everwake.payments enable row level security;
create policy member_read on everwake.payments for select to authenticated
  using (exists (select 1 from everwake.orders o where o.id = order_id));
grant select (id, tenant_id, order_id, provider, ref, amount, currency, status, link_url, method, card_brand, card_last4,
              attempts, last_error, expires_at, reminded_at, paid_at, created_by, created_by_user, is_live, created_at, updated_at)
  on everwake.payments to authenticated;
grant all on everwake.payment_accounts, everwake.payments to service_role;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.payment_account_view(uuid), everwake.save_payment_account(uuid, jsonb),
  everwake.payment_authorize(bigint, uuid), everwake.set_order_payment(bigint, text, boolean),
  everwake.money_text(numeric, text)
  to authenticated;

-- ================= 012_branch_differences.sql =================
-- =====================================================================
-- Everwake Orders · 012 · branches that differ
--
-- The branches of one restaurant rarely sell the same things the same
-- way. Each branch can have:
--   · its own menu — dishes and whole categories on or off, its own dish
--     prices (menu_item_branches, 001), its own choice prices and choices
--     it doesn't have (menu_option_branches), categories only some
--     branches serve (menu_categories.branch_ids)
--   · seating or not (branches.dine_in): no seating → no table bookings
--     and no "dine-in only" dishes there
--   · its own payment methods (branches.payment_methods; empty = the
--     restaurant's, Settings → Ordering)
--
-- The dashboard edits one branch's menu many dishes at a time
-- (branch_menu_update), sets a branch up like another one or back to the
-- restaurant's menu (copy_branch_menu), and imports a menu for one branch
-- (publish_menu with a branch, 006). The agent reads all of it from the
-- branch's snapshot (003).
-- =====================================================================

alter table everwake.branches
  add column dine_in         boolean,   -- seating: true / false; null = not said (the agent promises nothing)
  add column payment_methods text[]     -- null = the restaurant's list
    check (payment_methods <@ array['cash', 'card', 'wallet', 'instapay', 'online'] and cardinality(payment_methods) > 0),
  add constraint branches_bookings_need_seating check (dine_in is not false or reservations = 'off');

alter table everwake.menu_categories
  add column branch_ids uuid[];         -- null = every branch; else only these

alter table everwake.menu_imports
  add column branch_id uuid references everwake.branches(id) on delete set null;  -- imported for one branch

-- per-branch choices: a choice has its dish's price and is offered at every
-- branch unless a row here says otherwise
create table everwake.menu_option_branches (
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  option_id    uuid not null references everwake.menu_options(id) on delete cascade,
  branch_id    uuid not null references everwake.branches(id) on delete cascade,
  item_id      uuid not null references everwake.menu_items(id) on delete cascade,
  price_delta  numeric(10, 2),          -- null = the choice's own price
  is_available boolean not null default true,
  updated_at   timestamptz not null default now(),
  primary key (option_id, branch_id)
);
create index menu_option_branches_item_idx on everwake.menu_option_branches (item_id, branch_id);

create trigger menu_option_branches_touch before update on everwake.menu_option_branches
  for each row execute function everwake.touch_updated_at();
create trigger menu_option_branches_menu_rev after insert or update or delete on everwake.menu_option_branches
  for each row execute function everwake.bump_menu_rev();
create trigger menu_option_branches_audit after insert or update or delete on everwake.menu_option_branches
  for each row execute function everwake.audit_change();

-- ---------------------------------------------------------------------
-- The payment methods a branch takes: its own list, or the restaurant's.
-- "online" only while the restaurant's Paymob account is on. No branch
-- given: every method at least one branch takes.
-- ---------------------------------------------------------------------
create or replace function everwake.payment_methods_at(p_tenant uuid, p_branch uuid default null)
returns jsonb language sql stable as $$
  with t as (
    select array(select jsonb_array_elements_text(coalesce(everwake.merged_settings(x.settings) -> 'payment_methods',
                                                           '["cash"]'::jsonb))) as pm,
           exists (select 1 from everwake.payment_accounts a where a.tenant_id = p_tenant and a.enabled) as online
      from everwake.tenants x where x.id = p_tenant
  ), lists as (
    select coalesce(nullif(array(select m from unnest(b.payment_methods) m where m <> 'online' or (select online from t)), '{}'),
                    (select pm from t)) as pm
      from everwake.branches b
     where b.tenant_id = p_tenant and b.is_active and (p_branch is null or b.id = p_branch)
  )
  select to_jsonb(array(
           select k.m from unnest(array['cash', 'card', 'wallet', 'instapay', 'online']) with ordinality k(m, n)
            where k.m = any (coalesce((select array_agg(x) from lists, unnest(lists.pm) x), (select pm from t)))
              and (k.m <> 'online' or (select online from t))
            order by k.n))
$$;

-- ---------------------------------------------------------------------
-- A dish's choices are saved as a whole (006: written again from scratch).
-- The branches' own choice prices and switches are kept across that, on
-- the choice with the same name (in the question with the same name, or
-- at the same level).
-- ---------------------------------------------------------------------
create or replace function everwake.choice_overrides(p_item uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', everwake.norm(g.label_ar), 'level', g.level, 'name', everwake.norm(o.name_ar),
           'branch_id', x.branch_id, 'price_delta', x.price_delta, 'is_available', x.is_available)), '[]'::jsonb)
    from everwake.menu_option_branches x
    join everwake.menu_options o on o.id = x.option_id
    join everwake.menu_option_groups g on g.id = o.group_id
   where x.item_id = p_item
$$;

create or replace function everwake.restore_choice_overrides(p_item uuid, p_kept jsonb)
returns int language plpgsql as $$
declare n int;
begin
  insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id, price_delta, is_available)
  select distinct on (o.id, k ->> 'branch_id')
         o.tenant_id, o.id, (k ->> 'branch_id')::uuid, p_item,
         nullif(k ->> 'price_delta', '')::numeric, coalesce((k ->> 'is_available')::boolean, true)
    from everwake.menu_option_groups g
    join everwake.menu_options o on o.group_id = g.id
    join jsonb_array_elements(coalesce(p_kept, '[]'::jsonb)) k
      on k ->> 'name' = everwake.norm(o.name_ar)
     and (k ->> 'label' = everwake.norm(g.label_ar) or (k ->> 'level')::int = g.level)
    join everwake.branches b on b.id = (k ->> 'branch_id')::uuid
   where g.item_id = p_item
   order by o.id, k ->> 'branch_id', (k ->> 'label' = everwake.norm(g.label_ar)) desc
  on conflict (option_id, branch_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- a price as menus print it: to the nearest p_step (1, 5, …); 0 = to the piastre
create or replace function everwake.round_price(p numeric, p_step numeric)
returns numeric language sql immutable as $$
  select case when p is null then null
              when coalesce(p_step, 0) <= 0 then round(p, 2)
              else round(p / p_step) * p_step end
$$;

-- ---------------------------------------------------------------------
-- Many dishes at one branch at once (the menu page with a branch chosen)
-- p = {"items": ["<item id>", …],
--      "listed": true | false,                        on / off this branch's menu
--      "available": true | false,                     the stock switch at this branch
--      "price": {"mode": "reset" | "set" | "percent" | "amount",
--                "value": 10,                         the price, or +/- % or amount
--                "from": "current" | "restaurant",    what a % or amount starts from
--                "round": 1,                          to the nearest pound (5, 0.5, 0 = exact)
--                "choices": true}}                    a % or a reset also moves the choice prices
-- A price that comes out equal to the restaurant's is stored as "the
-- restaurant's" (no override), so later restaurant price changes reach it.
-- ---------------------------------------------------------------------
create or replace function everwake.branch_menu_update(p_tenant uuid, p_branch uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_items   uuid[];
  v_mode    text := nullif(p -> 'price' ->> 'mode', '');
  v_val     numeric := nullif(p -> 'price' ->> 'value', '')::numeric;
  v_from    text := coalesce(nullif(p -> 'price' ->> 'from', ''), 'current');
  v_round   numeric := coalesce(nullif(p -> 'price' ->> 'round', '')::numeric, 1);
  v_choices boolean := coalesce((p -> 'price' ->> 'choices')::boolean, true);
  n_items   int := 0;
  n_choices int := 0;
  n         int;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if not exists (select 1 from everwake.branches where id = p_branch and tenant_id = p_tenant) then
    raise exception 'branch not found';
  end if;
  if v_mode is not null and v_mode not in ('reset', 'set', 'percent', 'amount') then
    raise exception 'price mode is reset, set, percent or amount';
  end if;
  if v_mode in ('set', 'percent', 'amount') and v_val is null then raise exception 'a price change needs a value'; end if;
  if v_mode = 'set' and v_val < 0 then raise exception 'a price cannot be below zero'; end if;
  if v_mode = 'percent' and v_val <= -100 then raise exception 'a price cannot go down by 100%% or more'; end if;
  if v_from not in ('current', 'restaurant') then raise exception 'from is current or restaurant'; end if;

  select array_agg(i.id) into v_items
    from everwake.menu_items i
   where i.tenant_id = p_tenant
     and i.id in (select x::uuid from jsonb_array_elements_text(coalesce(p -> 'items', '[]'::jsonb)) x);
  if v_items is null then
    return jsonb_build_object('items', 0, 'choices', 0);
  end if;

  -- each dish gets its row for this branch (as it is now: on the menu, the restaurant's price)
  insert into everwake.menu_item_branches (tenant_id, item_id, branch_id)
  select p_tenant, x, p_branch from unnest(v_items) x
  on conflict (item_id, branch_id) do nothing;

  if p ? 'listed' then
    update everwake.menu_item_branches set is_listed = (p ->> 'listed')::boolean
     where branch_id = p_branch and item_id = any(v_items) and is_listed is distinct from (p ->> 'listed')::boolean;
    get diagnostics n = row_count; n_items := greatest(n_items, n);
  end if;

  if p ? 'available' then
    update everwake.menu_item_branches set is_available = (p ->> 'available')::boolean, sold_out_until = null
     where branch_id = p_branch and item_id = any(v_items)
       and (is_available is distinct from (p ->> 'available')::boolean or sold_out_until is not null);
    get diagnostics n = row_count; n_items := greatest(n_items, n);
  end if;

  if v_mode is not null then
    update everwake.menu_item_branches mb
       set price = x.new_price
      from (select mb2.item_id,
                   case when v_mode = 'reset' then null
                        else nullif(greatest(0, everwake.round_price(
                               case v_mode
                                 when 'set' then v_val
                                 when 'percent' then b.base * (1 + v_val / 100)
                                 when 'amount' then b.base + v_val end, v_round)), i.price) end as new_price,
                   b.base
              from everwake.menu_item_branches mb2
              join everwake.menu_items i on i.id = mb2.item_id
              cross join lateral (select case when v_from = 'restaurant' then i.price else coalesce(mb2.price, i.price) end as base) b
             where mb2.branch_id = p_branch and mb2.item_id = any(v_items)) x
     where mb.branch_id = p_branch and mb.item_id = x.item_id
       and (v_mode in ('reset', 'set') or x.base is not null)        -- "+10%" of a price the branch confirms: nothing to move
       and mb.price is distinct from x.new_price;
    get diagnostics n = row_count; n_items := greatest(n_items, n);

    if v_choices and v_mode = 'reset' then
      update everwake.menu_option_branches set price_delta = null
       where branch_id = p_branch and item_id = any(v_items) and price_delta is not null;
      get diagnostics n_choices = row_count;
    elsif v_choices and v_mode = 'percent' then
      insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id)
      select p_tenant, o.id, p_branch, g.item_id
        from everwake.menu_options o join everwake.menu_option_groups g on g.id = o.group_id
       where g.item_id = any(v_items) and o.price_delta <> 0
      on conflict (option_id, branch_id) do nothing;
      update everwake.menu_option_branches x
         set price_delta = nullif(everwake.round_price(
                             (case when v_from = 'restaurant' then o.price_delta else coalesce(x.price_delta, o.price_delta) end)
                             * (1 + v_val / 100), v_round), o.price_delta)
        from everwake.menu_options o
       where o.id = x.option_id and x.branch_id = p_branch and x.item_id = any(v_items)
         and (case when v_from = 'restaurant' then o.price_delta else coalesce(x.price_delta, o.price_delta) end) <> 0
         and x.price_delta is distinct from nullif(everwake.round_price(
                             (case when v_from = 'restaurant' then o.price_delta else coalesce(x.price_delta, o.price_delta) end)
                             * (1 + v_val / 100), v_round), o.price_delta);
      get diagnostics n_choices = row_count;
    end if;
  end if;

  -- rows that change nothing any more
  delete from everwake.menu_item_branches
   where branch_id = p_branch and item_id = any(v_items)
     and is_listed and price is null and is_available and sold_out_until is null;
  delete from everwake.menu_option_branches
   where branch_id = p_branch and item_id = any(v_items) and price_delta is null and is_available;

  return jsonb_build_object('items', n_items, 'choices', n_choices);
end $$;

-- ---------------------------------------------------------------------
-- One branch's menu set up like another's (a new branch "the same as
-- Zamalek"): the same dishes on and off, the same prices, the same choice
-- prices and choices, the same categories. p_from null: back to the
-- restaurant's menu — every dish, the restaurant's prices and choices.
-- The stock switches stay as they are: those are the branch's own, today.
-- ---------------------------------------------------------------------
create or replace function everwake.copy_branch_menu(p_tenant uuid, p_from uuid, p_to uuid)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare n_items int; n_choices int; n_cats int := 0;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if not exists (select 1 from everwake.branches where id = p_to and tenant_id = p_tenant)
     or (p_from is not null and not exists (select 1 from everwake.branches where id = p_from and tenant_id = p_tenant)) then
    raise exception 'branch not found';
  end if;
  if p_from = p_to then raise exception 'choose another branch to copy from'; end if;

  insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed, price)
  select p_tenant, i.id, p_to, coalesce(f.is_listed, true), f.price
    from everwake.menu_items i
    left join everwake.menu_item_branches f on f.item_id = i.id and f.branch_id = p_from
   where i.tenant_id = p_tenant
  on conflict (item_id, branch_id) do update
    set is_listed = excluded.is_listed, price = excluded.price
    where (mb.is_listed, mb.price) is distinct from (excluded.is_listed, excluded.price);
  get diagnostics n_items = row_count;
  delete from everwake.menu_item_branches
   where branch_id = p_to and is_listed and price is null and is_available and sold_out_until is null;

  delete from everwake.menu_option_branches where branch_id = p_to;
  insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id, price_delta, is_available)
  select tenant_id, option_id, p_to, item_id, price_delta, is_available
    from everwake.menu_option_branches where branch_id = p_from;
  get diagnostics n_choices = row_count;

  if p_from is not null then
    update everwake.menu_categories
       set branch_ids = case when p_from = any(branch_ids) then branch_ids || p_to else array_remove(branch_ids, p_to) end
     where tenant_id = p_tenant and branch_ids is not null
       and (p_from = any(branch_ids)) <> coalesce(p_to = any(branch_ids), false);
    get diagnostics n_cats = row_count;
  end if;

  return jsonb_build_object('items', n_items, 'choices', n_choices, 'categories', n_cats);
end $$;

-- ---------------------------------------------------------------------
-- Who can see and change what
-- ---------------------------------------------------------------------
alter table everwake.menu_option_branches enable row level security;
create policy member_read on everwake.menu_option_branches for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
create policy editor_write on everwake.menu_option_branches for all to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
grant select, insert, update, delete on everwake.menu_option_branches to authenticated;
grant all on everwake.menu_option_branches to service_role;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.branch_menu_update(uuid, uuid, jsonb), everwake.copy_branch_menu(uuid, uuid, uuid),
  everwake.payment_methods_at(uuid, uuid)
  to authenticated;

-- ================= 013_test_chat.sql =================
-- =====================================================================
-- Everwake Orders · 013 · the test chat
--
-- The n8n "Everwake — Test Runner" workflow chats with a restaurant's
-- agent from a pretend WhatsApp number (200000000001…99, never a real
-- one). It runs the real Main workflow, so it tests exactly what
-- customers get, but nothing goes out on WhatsApp: Main records the
-- replies without sending them, and no ticket goes to the kitchen.
-- It reaches the agent while the restaurant is still onboarding too
-- (intake, 004).
--
--   test_chat_prepare  finds the restaurant and its WhatsApp channel;
--                      "/reset" forgets the test chat (as if it never
--                      wrote), "/later N" moves it N hours into the past
--   test_chat_result   what the agent did with the last message: its
--                      reply, its plan, each tool call and its answer,
--                      what the checks caught
--
-- Only the database owner (n8n's connection) can run them.
-- =====================================================================

create or replace function everwake.is_test_number(p_wa text)
returns boolean language sql immutable as $$
  select coalesce(p_wa ~ '^20000000000[0-9]$|^2000000000[1-9][0-9]$', false)
$$;

create or replace function everwake.test_chat_prepare(p_restaurant text, p_wa text, p_reset boolean default false,
                                                      p_later_hours numeric default 0)
returns jsonb language plpgsql as $$
declare
  t      everwake.tenants%rowtype;
  ch     everwake.whatsapp_channels%rowtype;
  v_cust bigint[];
  v_back interval := make_interval(secs => greatest(coalesce(p_later_hours, 0), 0) * 3600);
  n      int;
begin
  if not everwake.is_test_number(p_wa) then
    raise exception 'The test chat only uses the pretend numbers 200000000001 to 200000000099, not %', p_wa;
  end if;

  select count(*) into n from everwake.tenants
   where slug = lower(btrim(p_restaurant)) or slug ilike btrim(p_restaurant) || '%'
      or name_en ilike btrim(p_restaurant) || '%' or name_ar = btrim(p_restaurant);
  if n <> 1 then
    raise exception '% restaurants match "%" — use the restaurant''s exact slug', n, p_restaurant;
  end if;
  select * into t from everwake.tenants
   where slug = lower(btrim(p_restaurant)) or slug ilike btrim(p_restaurant) || '%'
      or name_en ilike btrim(p_restaurant) || '%' or name_ar = btrim(p_restaurant);

  select * into ch from everwake.whatsapp_channels
   where tenant_id = t.id and provider = 'evolution' and is_active and instance_name is not null
   order by created_at limit 1;
  if ch.id is null then
    raise exception '% has no WhatsApp number connected yet (Settings → WhatsApp)', t.name_ar;
  end if;

  select coalesce(array_agg(id), '{}') into v_cust from everwake.customers where tenant_id = t.id and wa_id = p_wa;

  if p_reset then
    delete from everwake.orders             where tenant_id = t.id and (wa_id = p_wa or customer_id = any (v_cust));
    delete from everwake.reservations       where tenant_id = t.id and (wa_id = p_wa or customer_id = any (v_cust));
    delete from everwake.outbox             where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.messages           where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.conversations      where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.inbound_buffer     where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.conversation_locks where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.pause_contacts     where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.agent_events       where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.customers          where id = any (v_cust);
  elsif v_back > interval '0' then
    update everwake.messages set created_at = created_at - v_back, sent_at = sent_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.conversations
       set last_message_at = last_message_at - v_back, last_inbound_at = last_inbound_at - v_back,
           last_outbound_at = last_outbound_at - v_back, updated_at = updated_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.customers set last_seen_at = last_seen_at - v_back, last_order_at = last_order_at - v_back
     where id = any (v_cust);
    update everwake.orders set created_at = created_at - v_back, placed_at = placed_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.agent_events set created_at = created_at - v_back where tenant_id = t.id and wa_id = p_wa;
  end if;

  return jsonb_build_object(
    'tenant_id', t.id, 'restaurant', t.name_ar, 'slug', t.slug, 'status', t.status,
    'instance', ch.instance_name, 'token', ch.webhook_token, 'wa_id', p_wa,
    'reset', coalesce(p_reset, false), 'later_hours', greatest(coalesce(p_later_hours, 0), 0),
    'since', now(),
    'last_message_at', (select max(created_at) from everwake.messages
                         where tenant_id = t.id and wa_id = p_wa and direction = 'inbound'));
end $$;

create or replace function everwake.test_chat_result(p_tenant uuid, p_wa text, p_since timestamptz)
returns jsonb language plpgsql stable as $$
declare
  conv everwake.conversations%rowtype;
  ev   everwake.agent_events%rowtype;
begin
  if not everwake.is_test_number(p_wa) then
    raise exception 'not a test chat: %', p_wa;
  end if;
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into ev from everwake.agent_events
   where tenant_id = p_tenant and wa_id = p_wa and created_at >= p_since and stage = 'turn_complete'
   order by id desc limit 1;

  return jsonb_build_object(
    'customer', (select string_agg(body, E'\n' order by id) from everwake.messages
                  where tenant_id = p_tenant and wa_id = p_wa and direction = 'inbound' and created_at >= p_since),
    'replies', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'text', body, 'sender', sender) order by id)
                           from everwake.messages
                          where tenant_id = p_tenant and wa_id = p_wa and direction = 'outbound' and created_at >= p_since), '[]'),
    'turn', case when ev.id is null then null else jsonb_build_object(
              'stage', ev.order_stage, 'seconds', round(ev.duration_total_ms / 1000.0, 1),
              'tokens', coalesce(ev.prompt_tokens, 0) + coalesce(ev.completion_tokens, 0),
              'plan', ev.output -> 'brain', 'tools', ev.output -> 'tools_used', 'tool_problems', ev.output -> 'tool_problems',
              'caught', ev.output -> 'violations', 'rewritten', ev.repair_used,
              'calls', ev.output -> 'tool_calls', 'agent_error', ev.output ->> 'agent_error',
              'order_placed', ev.output ->> 'order_placed_no', 'handoff', ev.output -> 'handoff') end,
    'mode', conv.mode,
    'details', conv.state -> 'customer',
    'branch', (select name_ar from everwake.branches b where b.id::text = conv.state -> 'branch' ->> 'id'),
    'cart', (select jsonb_agg(concat_ws(' ', i ->> 'quantity', coalesce(i ->> 'display_name', i ->> 'item_name'),
                                        nullif(i ->> 'line_total', '') || 'ج'))
               from everwake.orders o, jsonb_array_elements(coalesce(o.cart -> 'items', '[]')) i
              where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'),
    'orders', (select jsonb_agg(order_no || ' ' || status || ' ' || total || 'ج' order by id)
                 from everwake.orders where tenant_id = p_tenant and wa_id = p_wa and status <> 'draft'));
end $$;

revoke execute on function everwake.is_test_number(text),
  everwake.test_chat_prepare(text, text, boolean, numeric),
  everwake.test_chat_result(uuid, text, timestamptz) from public, anon, authenticated;

-- ================= 090_supabase.sql =================
-- =====================================================================
-- Everwake Orders · 090 · Supabase only
-- Run on Supabase after 001–007. Skip on a plain Postgres.
--
--   media   (public)  <tenant_id>/items/…   dish photos the agent sends
--                     <tenant_id>/menus/…   full menu pages / PDF
--                     <tenant_id>/chat/…    pictures staff send in a chat
--   imports (private) <tenant_id>/…         menus uploaded for the AI to read
-- WhatsApp fetches media by URL, so the media bucket is public; nothing
-- private ever goes in it.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 15728640)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public, file_size_limit)
values ('imports', 'imports', false, 31457280)
on conflict (id) do nothing;

grant execute on function everwake.my_tenant_ids(), everwake.my_editor_tenant_ids() to authenticated;

drop policy if exists "everwake media write" on storage.objects;
create policy "everwake media write" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (
    (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text)
    or ((storage.foldername(name))[2] = 'chat'
        and (storage.foldername(name))[1] in (select unnest(everwake.my_tenant_ids())::text))));

drop policy if exists "everwake media change" on storage.objects;
create policy "everwake media change" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text));

drop policy if exists "everwake media delete" on storage.objects;
create policy "everwake media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text));

drop policy if exists "everwake imports" on storage.objects;
create policy "everwake imports" on storage.objects for all to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text))
  with check (bucket_id = 'imports' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text));

-- live dashboard: new orders ring, new messages appear, the switch updates, booking requests ring
do $$
declare t text;
begin
  foreach t in array array['orders', 'conversations', 'messages', 'tenants', 'reservations'] loop
    begin
      execute format('alter publication supabase_realtime add table everwake.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

