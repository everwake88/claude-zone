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
   - `from_me` — someone typed on the restaurant's phone. Logged as a team reply (after 5 s, so the engine's own sends are not mistaken for a person), and by default it takes the chat over.
3. **Debounce** (`everwake.claim_window`) — 6 seconds. Only the run holding the newest message answers, and it bundles all of them. A takeover or the OFF switch during the wait ends the run quietly.
4. **Location** — a pin is reverse-geocoded (Google, then OpenStreetMap). `everwake.save_pin` then matches it against the delivery zones (polygons or circles, plain SQL, no PostGIS). It picks the zone, its fee, its minimum and its branch, and sets the branch when none is chosen yet.
5. **Turn context** (`everwake.turn_context`) — the state, the cart, the customer's last three orders and saved addresses, the last 20 messages (customer, agent, team, automatic), the menu snapshot.
6. **Build Brief** — FACTS only, built from *this restaurant's* rows: time, branch status (open / closed / busy / not taking orders), the delivery area, the cart with offers, items waiting on a choice, details still missing, whether the summary still matches, returning-customer memory, offers running now, and the restaurant's own answers to common questions.
7. **Brain** (high reasoning) plans. **Agent** (low reasoning) runs the tools and writes. **Check Reply** enforces hard rails: every number must be a real price, total or detail on file; no false "order placed"; no internal codes; only the restaurant's links; no photo promised that isn't sent. A broken draft gets one **Rewrite**.
8. **Persist** — memory, handoff flag, telemetry, unlock. If a person took over while the model was thinking, nothing is sent.
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
| Where | `branches` (hours with split shifts, busy pause, fees, VAT), `delivery_zones`, `whatsapp_channels` |
| Menu | `menu_categories`, `menu_items` (codes M001…), `menu_option_groups` (levels), `menu_options`, `menu_item_branches` (per-branch listing, price, stock), `item_media` (dish photos), `menu_media` (full menu pages or PDF), `menu_imports` |
| Knowledge | `offers`, `knowledge_entries` |
| People | `customers`, `customer_identities`, `customer_addresses` |
| Talk | `conversations` (the engine's state, takeover, attention), `messages`, `outbox`, `inbound_buffer`, `conversation_locks` |
| Orders | `orders` (one draft per customer, then placed), `order_items`, `order_events` |
| Bookings | `reservations` (one draft per customer, then requested → confirmed / declined → arrived / did not come) |
| Paying | `payment_accounts` (each restaurant's Paymob keys; the two secrets encrypted in Supabase Vault, only their ids here), `payments` (each link: pending → paid / expired / replaced / refunded); `orders.payment_status` |
| Switch | `agent_pauses`, `pause_contacts` |
| Engine | `menu_snapshot`, `agent_events`, `audit_log` |
