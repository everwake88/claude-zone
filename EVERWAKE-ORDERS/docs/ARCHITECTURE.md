# How Everwake Orders works

## The three pieces

| Piece | Runs on | Job |
|---|---|---|
| **Engine** | n8n (your server) | Receives every WhatsApp message for every restaurant, thinks, uses the tools, replies |
| **Database** | Postgres on Supabase | The single truth: menus, branches, zones, customers, conversations, orders. Holds the engine's logic as SQL functions |
| **Dashboard** | Next.js (Vercel or Docker) | What the restaurant sees and controls. Talks to Supabase directly under row-level security |

## One engine, every restaurant

A restaurant is a row in `everwake.tenants`. Every table carries `tenant_id`,
and every engine function takes the restaurant first. Nothing is copied per
brand, so a migration or a fix reaches every client at once.

Signing a restaurant up also creates a schema of read-only views,
`r_<slug>`. In a database client it looks like the old one-schema-per-brand
setup (`r_bazooka.orders`, `r_bazooka.menu_items`, `r_bazooka.conversation_state`…),
but the engine still has one set of tables. After a migration that adds
columns, `select everwake.refresh_tenant_views();` re-creates the views.

### How a message finds its restaurant

Each restaurant's WhatsApp number is an Evolution **instance**, stored in
`everwake.whatsapp_channels`. Every instance posts to the same webhook:

```
POST https://<n8n>/webhook/everwake-evo?token=<channel webhook token>
```

`everwake.intake()` matches the instance name and checks the token. A forged
request without the token is ignored, so nobody can make the agent message
strangers or run up model costs.

## A message, end to end

The Seagull pipeline, unchanged in shape:

1. **Normalize Inbound** — the Evolution payload becomes one flat shape: phone and private ID (lid), text, location pin, voice-note and photo markers.
2. **Intake** (`everwake.intake`) — finds the restaurant and the customer by *any* identity, logs the message once, and routes it:
   - `agent` — buffered for the debounce window
   - `human` — a person took the chat over. The message waits in the inbox. After a set number of idle minutes (Settings → Ordering) the agent takes it back on its own.
   - `paused` — the agent is OFF. One warm apology per person, and they are remembered for "we're back".
   - `not_live` — the restaurant is still onboarding and this is not a test number. Staff answer from the phone as usual.
   - `team_answer` — not a customer message: the team answered a question the agent asked (below), and the dashboard wakes the agent through the same webhook, with the channel's token, so it tells the customer at once. It only runs when there is an answer the agent hasn't passed on, and never in a chat a person has taken over.
   - `from_me` — someone typed on the restaurant's phone. Logged as a team reply (after 5 s, so the engine's own sends are not mistaken for a person), and by default it takes the chat over.
3. **Photos and voice notes** — fetched from WhatsApp (Evolution `getBase64FromMediaMessage`, or the file in the webhook itself) and understood before the turn: a voice note is transcribed (`gpt-transcribe`), a photo described (`gpt-5-mini`; a menu or app screenshot has its dish names and prices copied, a payment screenshot its amount and reference). The agent reads `[voice note: «…»]` / `[photo: …]` in place of the marker, the inbox shows it under the message, and a quick text after it waits for it (015, a minute at most). Models: `EW_TRANSCRIBE_MODEL`, `EW_VISION_MODEL`.
3b. **Debounce** (`everwake.claim_window`) — 2 seconds. Only the run holding the newest message answers, and it bundles all of them. A takeover or the OFF switch during the wait ends the run quietly. If the customer writes again while a reply is being thought out, that reply is dropped (`persist_turn` hands its messages back) and the next turn answers everything together — unless the turn did something final (placed an order, sent a booking, made a payment link), whose reply always goes out.
4. **Location** — a pin is reverse-geocoded (Google, then OpenStreetMap). `everwake.save_pin` then matches it against the delivery zones (polygons or circles, plain SQL, no PostGIS). It picks the zone, its fee, its minimum and its branch, and sets the branch when none is chosen yet.
5. **Turn context** (`everwake.turn_context`) — the state, the cart, the customer's last three orders and saved addresses, the last 20 messages (customer, agent, team, automatic), the menu snapshot.
6. **Build Brief** — FACTS only, built from *this restaurant's* rows: time, branch status (open / closed / busy / not taking orders), the delivery area, the cart with offers, items waiting on a choice, details still missing, whether the summary still matches, returning-customer memory, offers running now, and the restaurant's own answers to common questions.
7. Two models. The **Brain** (high reasoning, no tools) reads the turn and plans the move: what is going on, what the reply must achieve, the tool actions, what the customer already heard and what to avoid. The **Agent** (low reasoning) runs the tools and writes the reply in her own words. **Check Reply** checks hard truth only: every number must be a real price, total or detail on file; no false "order placed"; no internal codes; only the restaurant's links; no photo promised that isn't sent. A line that breaks one is dropped (**Repair Reply**); no model rewrites her words.
8. **Persist** — memory, handoff flag, questions for the team, telemetry, unlock. If a person took over while the model was thinking, nothing is sent.
   - **Asking the team** (`team_questions`, 014). When only the restaurant knows something — whether something off the menu can be made, half cash and half online, a charge the branch sets — the agent puts one clear question (two at most) in `ask_team`. It tells the customer it is checking with the branch and carries on with the rest. The inbox shows the question with **Yes**, **No** and a box to type (a note can go with Yes / No). The answer goes into the agent's FACTS as NEW; the dashboard wakes it (`team_answer` above), and the reply that passes it on marks it told. A question still waiting is never asked again or guessed. `handoff` stays for a person taking over the chat: a complaint, someone asking for a person, something gone wrong.
9. **Send** — menu pages and dish photos first, then the text. Every message is logged, so the inbox shows exactly what the customer saw.
10. **Order placed** — a ticket goes to the branch's WhatsApp, and the order board rings.

The system prompts are the same for every restaurant: only the knowledge in
the message changes. This also keeps the model's prompt caching effective.

## The tools

**manage_cart** owns all money. Prices come only from the menu snapshot, and every call first re-checks the cart against the live menu. A dish switched off in the dashboard is taken out and reported; a changed price is re-priced. An order is never placed on a menu that changed under the customer.

| Action | What it does |
|---|---|
| `add` · `update` · `remove` · `replace` · `clear` | Change the cart. Choice levels are asked one at a time; pending items, stable line ids and amend-not-duplicate work as in Seagull |
| `set_branch` | Choose or change the branch; re-prices everything |
| `reorder_last` | Puts the last order back in the cart, priced from today's menu |
| `apply_code` | Applies a promo code |
| `place_order` | Refuses unless the cart, the details, the branch (open and taking orders), the delivery area, and a confirmed summary that still matches all check out |

When the customer pays online, a placed order also gets its Paymob payment link in the same call: the tool asks the database whether the order needs one (`payment_after_place`) and, if so, the dashboard (`/api/pay/link`), which makes it with the restaurant's own Paymob keys. The agent puts the link in its reply; Check Reply adds it if forgotten and refuses "paid" until Paymob's signed notice has marked the order paid.

Offers are computed in code (`src/shared/offers.js`): percent or amount off, a special price, free delivery or a free item. They can depend on dishes or categories, a minimum order, days and hours, branches, the customer's first order, or a promo code. Offers that stack all apply; of the rest, the customer gets the one worth the most.

**manage_reservation** takes table bookings at branches set to book on WhatsApp. `update` saves any of branch, day, time, guests, name, phone, occasion and special requests, checking each value (in the future, not too far ahead, the branch open then, not more guests than it seats); `summary` writes the text the customer confirms; `submit` refuses unless that summary was shown and nothing changed since, then gives the booking its reference and puts the ticket on the branch's WhatsApp; `cancel` drops a booking in progress or cancels one already sent. The team confirms on the dashboard, which tells the customer.

**save_customer_details** whitelists fields and normalises them. It also:
- keeps a ledger so nothing is asked twice
- reuses a saved address
- matches a typed area to a delivery zone
- remembers a phone number typed by a customer WhatsApp hides, so they are found by it next time

## "Save in the dashboard → the agent knows"

Every table the agent reads has a trigger that bumps `tenants.menu_rev` (once
per transaction). At the start of each turn `ensure_snapshot()` compares the
stored snapshot's revision. If anything changed — a price, a stock switch, a
zone, an offer, an answer, the agent's name — it rebuilds the restaurant's
snapshot before the model sees anything. "Out of stock until 6 pm" also sets
an expiry, so the dish comes back by itself.

## Branches that differ

There is one restaurant menu, and each branch's snapshot is that branch's own
version of it: a dish is on every branch at the restaurant's price unless
`menu_item_branches` says otherwise (off this branch's menu, its own price, out
of stock here); a choice likewise through `menu_option_branches`; a category
can be limited to some branches (`menu_categories.branch_ids`); a branch with
no seating (`branches.dine_in = false`) leaves out dine-in only dishes and
takes no table bookings. `branches.payment_methods` (empty = the restaurant's)
is what the agent offers there, `save_customer_details` accepts, and
`place_order` checks. The dashboard changes a branch's menu many dishes at a
time (`branch_menu_update`), copies one branch's set-up to another
(`copy_branch_menu`), and imports a printed menu for one branch
(`publish_menu(…, p_branch)`); saving a dish's choices keeps each branch's
choice prices.

## Identity: number or private ID

WhatsApp may show a customer as a private ID (`…@lid`) instead of a number.
`everwake.customer_identities` stores every phone and lid seen for a
customer. Intake finds the customer by either, and links the two when
Evolution shows both. Replies go to the number when known, else to the full
`…@lid` address. A number the customer types for an order is saved as theirs
too. Their last order and addresses follow them whichever way they come back.

## The outbox

Everything sent by people or by the system goes through `everwake.outbox`:
staff replies from the inbox, order status messages, "we're back" after a
pause. The agent's own replies are not included.
- n8n sends the outbox every minute, and at once when the dashboard pings it.
- A failed send retries three times, then shows as failed in the inbox with the reason.
- "We're back" messages are spaced 3 seconds apart, so WhatsApp never sees a burst.

## Ordering from a QR code

The customer's pages (`/q/<code>`, `/q/t/<token>`) need no sign-in; the dashboard
server calls the database with the service role:
- `qr_menu` — the branch's menu from its snapshot, the offers, the ways to pay
  (`settings.qr_ordering`), what is ordered together (`item_pairs`, last 90 days).
- `qr_pricing_context` → `priceCart` (`dashboard/src/lib/qr-pricing.ts`, a port of
  the engine's cart arithmetic and `shared/offers.js`: keep them in step) →
  `qr_checkout_create`. The browser only says which dishes, how many and which
  choices; every price comes from the snapshot.
- A `qr_checkouts` row waits for its money. Card: Paymob's callback
  (`payment_callback`, a payment with a `checkout_id`). Cash: `qr_cashier_paid`
  from the kitchen screen. Either way `qr_checkout_paid` makes the order
  (`source = 'qr'`, `delivery_method` pickup or dine_in, `ready_by` from the
  branch's prep time and load). Unpaid ones expire in housekeeping.
- The waiting page polls `qr_status` (the 64-character token is the key). Its
  WhatsApp button sends "Q-<10 characters>"; intake links that chat to the
  checkout (`qr_link_whatsapp`), so "ready" is sent there too. QR orders with
  no WhatsApp get no messages (`queue_customer_message` skips `qr-…` ids).

## The restaurant's own system

- Triggers on `orders` (deferred, so the order's lines exist) and on
  `menu_items` / `menu_item_branches` queue `integration_events` for each active
  `integration_endpoints` row. Both run as the owner: a deferred trigger fires at
  commit, as whoever is signed in.
- The outbox workflow claims them (`integration_claim`), signs the body with
  n8n's Crypto node (HMAC-SHA256, the endpoint's secret), POSTs it and records
  the result (`integration_result`: sent, or retried after 1, 2, 4… minutes,
  failed after 7).
- `/api/v1/*` takes `Authorization: Bearer ew_…`; `api_key_tenant` checks the
  hash (`api_keys` never stores the key) and names the restaurant. The calls go
  through the same functions as the board (`set_order_status`,
  `set_item_availability`), so the customer hears it the same way.

## Security

| Caller | What it can do |
|---|---|
| n8n engine | Connects as the database owner. Full access, no user |
| Dashboard user | Supabase role `authenticated` with a JWT. Row-level security shows only their restaurants; branch staff see only their branches' orders |
| `anon` | Nothing at all |

Roles in a restaurant:
- **Owner**: everything.
- **Manager**: everything but the team.
- **Staff**: orders, the inbox, stock and busy switches, the agent switch.

Sensitive actions go through `SECURITY DEFINER` functions that check the role first (`set_agent_enabled`, `take_over`, `send_staff_message`, `set_order_status`, `publish_menu`, …).

- The WhatsApp API key and webhook token are not readable from the dashboard. Column grants hide them, and only the server route reads them, after checking the caller is an owner or manager.
- Every dashboard edit is written to `everwake.audit_log` (who, what, before and after).

## Data model (short)

| Area | Tables |
|---|---|
| Restaurant | `tenants` (profile = what the agent knows, settings = how it operates), `tenant_members`, `tenant_invites`, `platform_admins` |
| Where | `branches` (hours with split shifts, busy pause, fees, VAT, seating `dine_in`, its own `payment_methods`), `delivery_zones`, `whatsapp_channels` |
| Menu | `menu_categories` (`branch_ids`: only some branches), `menu_items` (codes M001…), `menu_option_groups` (levels), `menu_options`, `menu_item_branches` (per-branch listing, price, stock), `menu_option_branches` (per-branch choice price, choice not offered), `item_media` (dish photos), `menu_media` (full menu pages or PDF), `menu_imports` (for every branch or one) |
| Knowledge | `offers`, `knowledge_entries` |
| People | `customers`, `customer_identities`, `customer_addresses` |
| Talk | `conversations` (the engine's state, takeover, attention), `messages`, `outbox`, `inbound_buffer`, `conversation_locks` |
| Orders | `orders` (one draft per customer, then placed), `order_items`, `order_events` |
| Bookings | `reservations` (one draft per customer, then requested → confirmed / declined → arrived / did not come) |
| In the branch | `qr_codes` (counter or table), `qr_checkouts` (a priced cart waiting for its money; `ticket` per branch per day); `orders.source = 'qr'`, `table_label`, `ready_by` |
| Their systems | `integration_endpoints` (address, events, signing secret), `integration_events` (each delivery and its tries), `api_keys` (hash and last 4 only) |
| Paying | `payment_accounts` (each restaurant's Paymob keys; the two secrets encrypted in Supabase Vault, only their ids here), `payments` (each link: pending → paid / expired / replaced / refunded); `orders.payment_status` |
| Switch | `agent_pauses`, `pause_contacts` |
| Engine | `menu_snapshot`, `agent_events`, `audit_log` |
