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
