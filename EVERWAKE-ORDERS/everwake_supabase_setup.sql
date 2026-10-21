-- Everwake Orders · full database setup for Supabase (migrations 001–008 + 090, in order)
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

-- one dish's choices as the engine reads them
create or replace function everwake.item_choices_json(p_item uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'level', g.level, 'label_ar', g.label_ar, 'label_en', g.label_en,
           'required', g.required, 'min', g.min_select, 'max', g.max_select,
           'options', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', o.name_ar, 'name_en', o.name_en, 'aliases', to_jsonb(o.aliases),
                      'price', o.price_delta, 'extra_charge', o.extra_charge)
                    order by o.sort, o.name_ar)
               from everwake.menu_options o
              where o.group_id = g.id and o.is_available), '[]'::jsonb))
         order by g.level), '[]'::jsonb)
    from everwake.menu_option_groups g
   where g.item_id = p_item
$$;

-- one dish's choices as the model reads them (one line)
create or replace function everwake.item_choices_text(p_item uuid, p_sym text)
returns text language sql stable as $$
  select string_agg(
           g.label_ar
           || ' (' || case when g.required then 'مطلوب' else 'اختياري' end
           || case when coalesce(g.max_select, 99) > 1 and g.max_select is not null then '، لحد ' || g.max_select
                   when g.max_select is null and not g.required then '، أكتر من اختيار'
                   else '' end
           || '): '
           || coalesce((
                select string_agg(o.name_ar
                                  || case when o.price_delta > 0 then ' +' || everwake.fmt_money(o.price_delta) || p_sym
                                          when o.price_delta < 0 then ' ' || everwake.fmt_money(o.price_delta) || p_sym
                                          else '' end
                                  || case when o.extra_charge then ' (+رسوم تسوية يحددها الفرع)' else '' end,
                                  ' / ' order by o.sort, o.name_ar)
                  from everwake.menu_options o
                 where o.group_id = g.id and o.is_available), '—'),
           ' · ' order by g.level)
    from everwake.menu_option_groups g
   where g.item_id = p_item
$$;

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
     and coalesce(mib.is_listed, true);

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
           coalesce(jsonb_object_agg(e.code, jsonb_build_object('levels', everwake.item_choices_json(e.item_id)))
                      filter (where exists (select 1 from everwake.menu_option_groups g where g.item_id = e.item_id)),
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
                    || coalesce(E'\n  اختيارات: ' || everwake.item_choices_text(e.item_id, v_sym), ''),
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

  -- still onboarding: only the restaurant's test numbers reach the agent ----
  if t.status = 'onboarding'
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
    'zones_drawn', exists (select 1 from everwake.delivery_zones where tenant_id = p_tenant and is_active))
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
  n_release int; n_locks int; n_stuck int; n_buf int; n_snap int := 0; n_busy int;
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

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'busy_cleared', n_busy, 'snapshots_rebuilt', n_snap);
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
-- ---------------------------------------------------------------------
create or replace function everwake.publish_menu(p_tenant uuid, p_menu jsonb, p_mode text default 'merge',
                                                 p_import uuid default null)
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
  n_cat_new int := 0; n_new int := 0; n_upd int := 0; n_arch int := 0;
  v_unit   text;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if p_mode not in ('merge', 'replace') then raise exception 'mode must be merge or replace'; end if;

  for cat in select * from jsonb_array_elements(coalesce(p_menu -> 'categories', '[]'::jsonb)) loop
    v_csort := v_csort + 10;
    continue when coalesce(btrim(cat ->> 'name_ar'), btrim(cat ->> 'name_en'), '') = '';
    select id into v_cat from everwake.menu_categories
     where tenant_id = p_tenant
       and (everwake.norm(name_ar) = everwake.norm(coalesce(cat ->> 'name_ar', cat ->> 'name_en'))
            or (nullif(cat ->> 'name_en', '') is not null and everwake.norm(name_en) = everwake.norm(cat ->> 'name_en')))
     limit 1;
    if v_cat is null then
      insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort)
      values (p_tenant, coalesce(nullif(btrim(cat ->> 'name_ar'), ''), btrim(cat ->> 'name_en')), nullif(btrim(cat ->> 'name_en'), ''), v_csort)
      returning id into v_cat;
      n_cat_new := n_cat_new + 1;
    else
      update everwake.menu_categories set is_active = true, sort = v_csort,
             name_en = coalesce(nullif(btrim(cat ->> 'name_en'), ''), name_en)
       where id = v_cat;
    end if;

    v_isort := 0;
    for it in select * from jsonb_array_elements(coalesce(cat -> 'items', '[]'::jsonb)) loop
      v_isort := v_isort + 10;
      continue when coalesce(btrim(it ->> 'name_ar'), btrim(it ->> 'name_en'), '') = '';
      v_unit := case when it ->> 'unit' in ('portion', 'piece', 'kg', 'person') then it ->> 'unit' else 'portion' end;
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
                v_unit, nullif(it ->> 'price', '')::numeric,
                case when v_unit = 'kg' then 0.25 end, case when v_unit = 'kg' then 0.5 end,
                coalesce((select array_agg(lower(btrim(a))) from jsonb_array_elements_text(it -> 'tags') a where btrim(a) <> ''), '{}'),
                coalesce((it ->> 'is_signature')::boolean, false), v_isort, p_import)
        returning id into v_item;
        n_new := n_new + 1;
      else
        update everwake.menu_items
           set category_id = v_cat, is_active = true, sort = v_isort, unit = v_unit,
               name_en = coalesce(nullif(btrim(it ->> 'name_en'), ''), name_en),
               description_ar = coalesce(nullif(btrim(it ->> 'description_ar'), ''), description_ar),
               description_en = coalesce(nullif(btrim(it ->> 'description_en'), ''), description_en),
               price = coalesce(nullif(it ->> 'price', '')::numeric, price),
               aliases = case when jsonb_array_length(coalesce(it -> 'aliases', '[]'::jsonb)) > 0
                              then (select array_agg(distinct x) from unnest(aliases || (select array_agg(btrim(a)) from jsonb_array_elements_text(it -> 'aliases') a where btrim(a) <> '')) x)
                              else aliases end,
               is_signature = coalesce((it ->> 'is_signature')::boolean, is_signature),
               source_import_id = coalesce(p_import, source_import_id)
         where id = v_item;
        n_upd := n_upd + 1;
      end if;
      v_seen := v_seen || v_item;

      -- the choices are replaced as a whole when the import carries any
      if jsonb_array_length(coalesce(it -> 'options', '[]'::jsonb)) > 0 then
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
      end if;
    end loop;
  end loop;

  if p_mode = 'replace' then
    update everwake.menu_items set is_active = false
     where tenant_id = p_tenant and is_active and not (id = any(v_seen));
    get diagnostics n_arch = row_count;
  end if;

  if p_import is not null then
    update everwake.menu_imports
       set status = 'published', published_at = now(), published_by = everwake.current_user_id(), extracted = p_menu
     where id = p_import and tenant_id = p_tenant;
  end if;

  return jsonb_build_object('categories_created', n_cat_new, 'items_created', n_new, 'items_updated', n_upd,
                            'items_archived', n_arch);
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
begin
  select tenant_id into v_tenant from everwake.menu_items where id = p_item;
  if v_tenant is null then raise exception 'dish not found'; end if;
  perform everwake.require_role(v_tenant, array['owner', 'manager']);
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
  everwake.publish_menu(uuid, jsonb, text, uuid), everwake.save_item_choices(uuid, jsonb),
  everwake.analytics(uuid, timestamptz, timestamptz),
  everwake.save_channel(uuid, jsonb), everwake.channel_webhook_token(uuid),
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

-- live dashboard: new orders ring, new messages appear, the switch updates
do $$
declare t text;
begin
  foreach t in array array['orders', 'conversations', 'messages', 'tenants'] loop
    begin
      execute format('alter publication supabase_realtime add table everwake.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

