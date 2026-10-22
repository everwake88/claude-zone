// Rows of the everwake schema, as the dashboard reads them.
export type Role = 'owner' | 'manager' | 'staff';

export interface TenantSummary {
  id: string; slug: string; name_ar: string; name_en: string;
  status: 'onboarding' | 'live' | 'suspended' | 'cancelled';
  agent_enabled: boolean; currency: string; currency_symbol: string; timezone: string;
  default_language: 'ar' | 'en'; role: Role;
}

export interface Tenant extends Omit<TenantSummary, 'role' | 'currency_symbol'> {
  currency_symbol_ar: string; country: string; order_no_prefix: string; plan: string;
  profile: Profile; settings: Settings; live_at: string | null; current_pause_id: number | null;
}

export interface Profile {
  agent_name?: { ar?: string; en?: string };
  about_ar?: string; about_en?: string; cuisine?: string; tone?: string;
  brand_facts?: string[];
  contacts?: { hotline?: string; complaints?: string; whatsapp?: string; email?: string };
  website?: string; instagram?: string; facebook?: string; tiktok?: string; google_maps_url?: string;
  brand?: Brand;
}

// the restaurant's look: its logo and colour, on the dashboard and the menu pictures
export interface Brand { logo_url?: string; logo_path?: string; color?: string }

export interface Settings {
  payment_methods?: string[];
  required_fields?: { delivery?: string[]; pickup?: string[]; unknown?: string[] };
  max_delivery_km?: number;
  require_zone_for_delivery?: boolean;
  accept_orders_when_closed?: boolean;
  human_auto_release_minutes?: number;
  phone_reply_takes_over?: boolean;
  auto_takeover_on_handoff?: boolean;
  send_order_ticket?: boolean;
  ops_whatsapp?: string;
  test_numbers?: string[];
  aggregator_commission_percent?: number;
  // the owner's summary on WhatsApp once a day (009)
  daily_report?: { enabled?: boolean; numbers?: string[]; time?: string };
  // extra "where did you find us" sources for the QR links, beyond the built-in ones
  growth_sources?: string[];
  // table bookings (010): the restaurant's rules; each branch says whether it books on WhatsApp, by phone or not at all
  reservation_max_guests?: number;
  reservation_occasions?: string[];
  reservation_lead_minutes?: number;
  reservation_days_ahead?: number;
  allowed_links?: string[];
  templates?: Record<string, string>;
}

export interface Window { open: string; close: string }
export type Hours = Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'default', Window[] | Window>>;

export interface Branch {
  id: string; tenant_id: string; code: string; name_ar: string; name_en: string | null; aliases: string[];
  area_ar: string | null; address_ar: string | null; address_en: string | null; lat: number | null; lng: number | null;
  maps_url: string | null; phone: string | null; ops_whatsapp: string | null; hours: Hours; hours_text_ar: string | null;
  accepting_orders: boolean; busy_until: string | null; busy_reason: string | null;
  delivery_enabled: boolean; pickup_enabled: boolean; delivery_fee: number | null; min_order: number | null;
  max_delivery_km: number | null; vat_percent: number | null; price_note_ar: string | null; prep_minutes: number | null;
  delivery_eta_text: string | null; serves_hint_ar: string | null; seasonal: boolean; is_active: boolean; sort: number;
  reservations: 'off' | 'whatsapp' | 'phone'; reservation_note_ar: string | null; reservation_max_guests: number | null;
}

export type ReservationStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled' | 'seated' | 'no_show';
export interface Reservation {
  id: number; tenant_id: string; ref_no: string; wa_id: string; conversation_id: number | null; customer_id: number | null;
  branch_id: string | null; status: ReservationStatus; reserve_date: string; reserve_time: string; reserved_for: string;
  guests: number; occasion: string | null; full_name: string | null; phone: string | null; requests: string | null;
  source: string; requested_at: string | null; decided_at: string | null; decline_reason: string | null; ops_notified: boolean;
  created_at: string;
}

export interface Zone {
  id: string; tenant_id: string; branch_id: string; name_ar: string; name_en: string | null;
  kind: 'polygon' | 'radius'; polygon: [number, number][] | null; center_lat: number | null; center_lng: number | null;
  radius_km: number | null; areas: string[]; delivery_fee: number | null; min_order: number | null;
  eta_min: number | null; eta_max: number | null; priority: number; is_active: boolean;
}

export interface Category {
  id: string; tenant_id: string; name_ar: string; name_en: string | null; description_ar: string | null;
  available_from: string | null; available_to: string | null; is_active: boolean; sort: number;
}

export interface Item {
  id: string; tenant_id: string; code: string; category_id: string | null; name_ar: string; name_en: string | null;
  aliases: string[]; description_ar: string | null; description_en: string | null;
  unit: 'portion' | 'piece' | 'kg' | 'person'; price: number | null; qty_step: number | null; min_qty: number | null;
  tags: string[]; is_signature: boolean; is_featured: boolean; orderable: boolean; is_available: boolean;
  sold_out_until: string | null; is_active: boolean; sort: number;
}

export interface OptionGroup {
  id: string; tenant_id: string; item_id: string; level: number; label_ar: string; label_en: string | null;
  required: boolean; min_select: number; max_select: number | null; options?: Option[];
}
export interface Option {
  id: string; tenant_id: string; group_id: string; name_ar: string; name_en: string | null; aliases: string[];
  price_delta: number; extra_charge: boolean; is_available: boolean; sort: number;
}
export interface ItemBranch {
  tenant_id: string; item_id: string; branch_id: string; is_listed: boolean; price: number | null;
  is_available: boolean; sold_out_until: string | null;
}
export interface ItemMedia { id: string; tenant_id: string; item_id: string; url: string; storage_path: string | null; mime: string; is_primary: boolean; sort: number }
export interface MenuMedia {
  id: string; tenant_id: string; branch_id: string | null; kind: 'image' | 'pdf'; url: string; storage_path: string | null;
  mime: string; file_name: string | null; caption: string | null; position: number; is_active: boolean;
}

export interface Offer {
  id: string; tenant_id: string; title_ar: string; title_en: string | null; description_ar: string | null; description_en: string | null;
  kind: 'percent_off' | 'amount_off' | 'fixed_price' | 'free_delivery' | 'free_item';
  scope: 'order' | 'items' | 'categories'; value: number; max_discount: number | null; min_subtotal: number | null;
  item_ids: string[]; category_ids: string[]; branch_ids: string[]; free_item_id: string | null; free_item_qty: number;
  promo_code: string | null; first_order_only: boolean; stackable: boolean; priority: number;
  starts_at: string | null; ends_at: string | null; days_of_week: number[]; time_from: string | null; time_to: string | null;
  is_active: boolean;
}

export interface Knowledge { id: string; tenant_id: string; topic: string; content_ar: string | null; content_en: string | null; is_active: boolean; sort: number }

export interface Customer {
  id: number; tenant_id: string; wa_id: string; reply_to: string | null; phone: string | null; phone_hidden: boolean;
  display_name: string | null; full_name: string | null; alt_phone: string | null; language: string | null;
  food_prefs: string | null; staff_notes: string | null; tags: string[]; is_blocked: boolean;
  orders_count: number; total_spent: number; last_order_at: string | null; first_seen_at: string; last_seen_at: string;
}
export interface Address {
  id: number; customer_id: number; area: string | null; street: string | null; building: string | null; floor: string | null;
  apartment: string | null; landmark: string | null; address_text: string | null; maps_url: string | null; use_count: number; last_used_at: string;
}

export interface Conversation {
  id: number; tenant_id: string; customer_id: number | null; wa_id: string; state: ConversationState;
  mode: 'agent' | 'human'; assigned_user_id: string | null; human_since: string | null; human_reason: string | null;
  needs_attention: boolean; attention_reason: string | null; unread_count: number;
  last_message_at: string | null; last_inbound_at: string | null; last_message_preview: string | null;
  customers?: Pick<Customer, 'display_name' | 'full_name' | 'phone' | 'phone_hidden' | 'orders_count' | 'is_blocked'> | null;
}
export interface ConversationState {
  branch?: { id?: string; code?: string; name_ar?: string; source?: string };
  zone?: { name?: string; branch_name?: string; delivery_fee?: number; source?: string } | null;
  customer?: Record<string, string>;
  location?: { maps_url?: string; in_delivery_area?: boolean };
  ledger?: { pending_items?: { name: string }[] };
  memory_notes?: string[];
  phase?: string;
}

export interface Message {
  id: number; tenant_id: string; conversation_id: number | null; wa_id: string; direction: 'inbound' | 'outbound';
  sender: 'customer' | 'agent' | 'staff' | 'system' | 'driver'; staff_user_id: string | null; kind: string; body: string | null;
  media_url: string | null; media_mime: string | null; status: string; error: string | null; created_at: string;
  meta: Record<string, unknown>;
}

export type OrderStatus = 'draft' | 'placed' | 'accepted' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered'
  | 'picked_up' | 'rejected' | 'cancelled';

export interface CartLine {
  line_id: string; code: string; item_name: string; display_name?: string; unit: string; quantity: number;
  unit_price: number; line_total: number; notes: string | null; gift?: boolean;
  choices: { level: number; label_ar?: string; selected: { name: string; adds?: number }[] }[];
}

export interface Order {
  id: number; tenant_id: string; order_no: string | null; customer_id: number | null; conversation_id: number | null;
  wa_id: string; branch_id: string | null; zone_id: string | null; status: OrderStatus;
  cart: { items: CartLine[] }; currency: string; subtotal: number; discount_total: number;
  applied_offers: { title: string; amount: number; gift?: { name: string } | null }[];
  vat: number | null; delivery_fee: number | null; total: number; delivery_method: string | null; payment_method: string | null;
  customer: Record<string, string> | null; address_text: string | null; location: { maps_url?: string } | null;
  notes: string | null; eta_text: string | null; reject_reason: string | null;
  placed_at: string | null; accepted_at: string | null; ready_at: string | null; out_for_delivery_at: string | null;
  completed_at: string | null; cancelled_at: string | null; created_at: string; updated_at: string;
  driver_id: string | null; driver_assigned_at: string | null;
  delivery_km_left: number | null; delivery_eta_min: number | null; delivery_track_at: string | null;
}
// one of the restaurant's own drivers (طيار)
export interface Driver {
  id: string; tenant_id: string; name: string; phone: string; branch_ids: string[]; is_active: boolean;
  login_code_sent_at: string | null; last_lat: number | null; last_lng: number | null; last_loc_at: string | null;
  last_seen_at: string | null; created_at: string;
}
export interface OrderEvent { id: number; order_id: number; status: string; note: string | null; by_role: string; notified: boolean; created_at: string }

export interface Member { tenant_id: string; user_id: string; role: Role; branch_ids: string[] | null; display_name: string | null; email: string | null; created_at: string }
export interface Invite { id: string; tenant_id: string; email: string; role: Role; created_at: string; accepted_at: string | null }

export interface Channel {
  id: string; tenant_id: string; provider: 'evolution' | 'cloud_api'; label: string | null; phone_number: string | null;
  instance_name: string | null; base_url: string | null; default_branch_id: string | null;
  status: 'pending' | 'connected' | 'disconnected'; is_active: boolean; last_inbound_at: string | null; connected_at: string | null;
}

export interface MenuImport {
  id: string; tenant_id: string; source_kind: 'pdf' | 'image' | 'url' | 'text' | 'csv'; source_url: string | null;
  files: { path: string; mime: string; name: string }[]; raw_text: string | null;
  status: 'uploaded' | 'extracting' | 'review' | 'published' | 'failed'; extracted: ExtractedMenu | null; error: string | null;
  created_at: string; published_at: string | null;
}
export interface ExtractedChoice { name_ar: string; name_en: string | null; price_delta: number }
export interface ExtractedGroup { label_ar: string; label_en: string | null; required: boolean; min: number; max: number | null; choices: ExtractedChoice[] }
export interface ExtractedItem {
  name_ar: string; name_en: string | null; description_ar: string | null; price: number | null;
  unit: 'portion' | 'piece' | 'kg' | 'person'; is_signature: boolean; aliases: string[]; tags: string[]; options: ExtractedGroup[];
}
export interface ExtractedCategory { name_ar: string; name_en: string | null; items: ExtractedItem[] }
export interface ExtractedMenu { categories: ExtractedCategory[]; notes?: string | null }

export interface ChecklistItem { key: string; label: string; required: boolean; done: boolean; detail: string; href: string }
export interface Checklist { status: string; live_at: string | null; ready: boolean; items: ChecklistItem[] }
