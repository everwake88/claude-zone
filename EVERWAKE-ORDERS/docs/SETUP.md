# Setting up Everwake Orders

From nothing to the first test order. Done once for the platform, not per
restaurant. About an hour.

You need:
- a Supabase project
- your n8n (the one Seagull runs on is fine)
- an Evolution API server
- an OpenAI key
- somewhere to host the dashboard: Vercel, or Docker on the VPS

---

## 1. The database (Supabase)

1. **Create a Supabase project**, in the region closest to your customers (Frankfurt for Egypt and the Gulf).
2. **Run the migrations, in order.** Use the SQL editor (paste each file and run it) or `psql` with the connection string:
   ```
   database/migrations/001_schema.sql
   database/migrations/002_helpers.sql
   database/migrations/003_snapshot.sql
   database/migrations/004_engine.sql
   database/migrations/005_operations.sql
   database/migrations/006_dashboard.sql
   database/migrations/007_security.sql
   database/migrations/008_drivers.sql
   database/migrations/009_growth.sql
   database/migrations/010_reservations.sql
   database/migrations/011_payments.sql
   database/migrations/012_branch_differences.sql
   database/migrations/090_supabase.sql      ← storage buckets + live updates (Supabase only)
   ```
   Or paste `everwake_supabase_setup.sql` (all of them in one file) and run it once.
   With `psql`:
   ```sh
   for f in database/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
   ```
3. **Expose the schema.** Settings → API → *Exposed schemas* → add `everwake` (keep `public`). Save.
4. **Sign-in addresses.** Authentication → URL configuration:
   - **Site URL:** your dashboard address, e.g. `https://orders.everwake.tech`
   - **Redirect URLs:** add `https://orders.everwake.tech/auth/callback`
5. *(Optional)* **Load the demo restaurant** for sales demos: run `database/seed/demo_restaurant.sql`. It creates "Nile Grill" with two branches, zones, a menu with choices and offers.

## 2. The dashboard

### Environment

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key (server only, never `NEXT_PUBLIC_`) |
| `OPENAI_API_KEY` | For the AI menu import |
| `MENU_AI_MODEL` | Optional; defaults to `gpt-5.6-luna`, the model the agent uses. It must read PDFs and photos |
| `N8N_BASE_URL` | Your n8n's public address, e.g. `https://n8n.example.com` |
| `N8N_OUTBOX_SECRET` | A long random string; the same value goes into n8n (step 3). n8n also sends it when it asks the dashboard for a payment link |
| `NEXT_PUBLIC_SITE_URL` | Optional: the dashboard's public address for the links sent to drivers (sign-in, "your orders") and customers (payment links, the QR codes). Without it, the address the page was opened on is used. Set it before printing QR cards: the address is in the code |
| `KITCHEN_TRANSCRIBE_MODEL` | Optional; the kitchen screen's "hold and speak" button. Defaults to `gpt-transcribe` (uses `OPENAI_API_KEY`) |
| `KITCHEN_AI_MODEL` | Optional; reads what the kitchen said ("123 ready", "the kofta is finished"). Defaults to `MENU_AI_MODEL` |

### Hosting: Vercel

1. New project from the GitHub repo.
2. Root directory: `EVERWAKE-ORDERS/dashboard`. Framework: Next.js.
3. Add the variables above and deploy.
4. The AI menu import can take up to a few minutes on a big menu. Enable Fluid compute (or use a plan that allows 300-second functions).

### Hosting: Docker on your VPS

```sh
cd "EVERWAKE-ORDERS/dashboard"
docker build -t everwake-dashboard \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... .
docker run -d --restart unless-stopped -p 3000:3000 --env-file .env --name everwake-dashboard everwake-dashboard
```
Put it behind your HTTPS proxy (Caddy, Traefik or Nginx), the same way n8n is.

### Make yourself the platform admin

Sign up on the dashboard with your own e-mail, then in Supabase's SQL editor:
```sql
insert into everwake.platform_admins (user_id, email)
select id, email from auth.users where email = 'you@everwake.tech';
```
You now see every restaurant in the switcher.

## 3. The engine (n8n)

Running n8n on your own server (Hostinger VPS): with Coolify, [`deploy/COOLIFY.md`](../deploy/COOLIFY.md); without it, [`deploy/README.md`](../deploy/README.md)
sets up the server, n8n behind https, backups and health checks; then come back
here for the credentials and workflows.

1. **Credentials** (n8n → Credentials):
   - **Postgres → name it "Everwake DB".** Supabase → Settings → Database → *Connection string*.
     - Supabase's direct host is IPv6-only, so from most VPSs use the **Session pooler**: host `aws-0-<region>.pooler.supabase.com`, port `5432`, user `postgres.<project-ref>`, your database password, SSL on.
   - **OpenAI** — the account the Seagull agent already uses is fine.
   - **Header Auth → name it "Everwake Outbox Secret".** Header name `x-everwake-secret`; value = the same string as the dashboard's `N8N_OUTBOX_SECRET`.
2. **Import the six workflows** from `engine/dist/`, in this order:
   1. `everwake-tool-manage-cart.json`
   2. `everwake-tool-save-customer-details.json`
   3. `everwake-tool-manage-reservation.json`
   4. `everwake-outbox.json`
   5. `everwake-main.json`
   6. `everwake-test-runner.json` (optional: chat with an agent without WhatsApp, below)
3. **In "Everwake — Main (Brain + Agent)":**
   - Open the **manage_cart**, **save_customer_details** and **manage_reservation** tool nodes, which show `SET_AFTER_IMPORT`, and pick the three tool workflows you just imported.
   - Pick the **Everwake DB** credential on every Postgres node, and your OpenAI credential on Brain Model and Agent Model. n8n lists the nodes missing a credential.
4. **In "Everwake — Outbox + Housekeeping":** pick **Everwake DB** on the Postgres nodes and **Everwake Outbox Secret** on *Ping From Dashboard*.
   **In "Everwake — Tool: manage_cart":** pick **Everwake Outbox Secret** on *Create Payment Link* too (it asks the dashboard for Paymob links).
5. **Activate** Main and Outbox. The three tools are called by Main and need no activation.
   Each tool workflow has one Postgres node: pick **Everwake DB** on it too.
6. **The Test Runner** (optional): pick **Everwake DB** on its two Postgres nodes and *Everwake — Main (Brain + Agent)* on **Run The Agent (Main)**, then **Open chat**. Write as a customer; the real Main answers from a pretend number (200000000001), records the replies and sends nothing on WhatsApp — no kitchen ticket either — and it works while a restaurant is still onboarding. `/reset` starts a brand-new customer, `/later 5 <message>` lets 5 hours pass first, `/pin <lat>,<lng>` sends a location pin, `#2 <message>` is a second pretend customer, `@slug <message>` tests another restaurant (the default is set at the top of *Read Test Command*). Its orders show on the board until `/reset` removes them. Needs the database patch `2026-10-24_test_chat.sql` on an existing install.
7. *(Busy platform)* Run n8n in **queue mode** with a couple of workers once you pass a handful of restaurants. The debounce and conversation locks already make concurrent runs safe.

The workflows are generated. To change the engine:
1. Edit `engine/src/…` or `engine/prompts/…`.
2. Run `cd engine && npm test` (it needs a local Postgres), then `node build.mjs`.
3. Re-import the changed workflow.

`EW_MODEL`, `EW_PG_CRED_ID` and `EW_OPENAI_CRED_ID` set the model and credential ids at build time.
`engine/n8n-ids.json` holds the ids n8n gave Main and the three tools (`{ "main": "…", "cart": "…", "details": "…", "reservation": "…" }`, from each workflow's address). With it, a re-imported Main keeps its tools linked: without it the tool nodes say `SET_AFTER_IMPORT` again and the agent can't touch the cart.

## 4. Each WhatsApp number (Evolution)

Done per restaurant, from the dashboard: **Settings → WhatsApp → Connect a number**.

1. Create an instance on your Evolution server (its manager UI or API). Use one instance per restaurant number; the instance name must be unique across all restaurants.
2. In the dashboard, enter the Evolution server address, the instance name and its API key.
3. Click **Connect with a QR code** and scan it from the restaurant's phone (WhatsApp → Linked devices).
4. Click **Set the webhook for me**. If your Evolution version rejects it, paste the webhook address shown on the page into Evolution yourself:
   - events `MESSAGES_UPSERT` and `SEND_MESSAGE`
   - "webhook by events" off, base64 off
5. Click **Check connection**, then **Send a test**.

Evolution must be able to reach `https://<n8n>/webhook/everwake-evo` from the internet.

## 5. The first test order

1. Sign up a restaurant in the dashboard (or open the demo one).
2. Settings → Ordering → **Test numbers** → add your own WhatsApp number.
3. Message the restaurant's number from your phone and order something. You should see:
   - the conversation in the **Inbox**
   - the order ringing on the **Orders** board
   - the ticket on the branch WhatsApp, if one is set
4. Accept the order on the board. You receive the "accepted" message on WhatsApp within seconds.

## Updating an existing database

Fixes to the database ship in two places: the migration files (for new
installs) and a dated file in `database/patches/` (for databases that are
already running). After pulling an update, run each new patch once, oldest
first, in Supabase → SQL Editor. `everwake_supabase_setup.sql` already
contains every patch, so a fresh install needs none of them.

## Drivers

The restaurant's own drivers are added under **Drivers** by any team member
(owner, manager or staff) with a name and a WhatsApp number. A one-time
sign-in link goes to that number from the restaurant's WhatsApp; opening it
signs the phone in for six months — there is no password and no Supabase
account. A driver who lost the link opens `<dashboard>/driver/login` and types
their number to get a new one (at most one a minute).

On the order board, a delivery order gets a driver from the list on its card.
The driver's page (`/driver`) shows the order, the branch and the customer on
a map, a **Directions** button that opens Google Maps, the customer's number,
a chat through the restaurant's number, and the cash to collect. When the
driver presses **start delivery**, the customer gets the driver's name, number
and an arrival estimate; when the phone's position puts the driver about 5
minutes away, the customer is told once more. The agent sees the driver and
the distance if the customer asks where the order is.

Things to know:
- The position comes from the browser while `/driver` is open (the screen is
  kept on while delivering). A phone browser stops sending it when the page is
  in the background — e.g. while Google Maps is open — so drivers should come
  back to the page. Reliable background tracking needs a small Android app;
  that is the next step if restaurants need it.
- Estimates use the straight-line distance × 1.35 at 22 km/h. A restaurant can
  set `driver_speed_kmh` and `driver_near_minutes` (default 5) in its settings.
- The maps use OpenStreetMap's public tiles, which are fine for testing; a busy
  platform should switch to a paid tile service (MapTiler, Stadia, Carto).
- On the official WhatsApp Cloud API, messages to a driver who has not written
  to the restaurant in 24 hours need an approved template.

## Table bookings (dine-in)

Each branch chooses how it takes bookings (Branches → a branch → *Table bookings*):
- **No table bookings** — the default. Someone asking for a table is passed to the team.
- **On WhatsApp** — the agent takes the booking itself.
- **By phone only** — the agent gives the branch's phone number and the note you
  write (e.g. "الحجز في الفرع ده بالتليفون بس"); it never takes the booking.

On WhatsApp the agent gathers the branch, day, time and number of people in
one natural question, then the name with a light optional line about an
occasion or anything to prepare — never a form, never one field per message.
Their WhatsApp number is already the booking's number. Every value is checked
(at least an hour ahead, up to 30 days ahead, while the branch is open, no more
guests than the branch seats); then the customer sees a summary, and only a
clear yes to that summary sends it. Sending it:
- puts a ticket with the customer's details on the branch's WhatsApp for
  new-order tickets (or the restaurant's), with the reference (e.g. NG-R1001);
- shows it on the dashboard's **Table bookings** page, which rings like a new order.

The team calls the customer and presses **Confirm**: that is when the customer
hears on WhatsApp that the table is theirs. The agent never says a booking is
confirmed before that (a rail in Check Reply drops a line that does).
**Decline** (with an optional reason) offers them another time; after the day,
mark **Arrived** or **Did not come**. A customer can cancel on WhatsApp, and the
branch is told. **Booking rules** on that page sets the largest group, how far
ahead, and the occasions the agent may mention. The daily report counts the
requests and how many still wait for the team.

## Paying online (Paymob)

Each restaurant connects **its own** Paymob account in **Settings → Payments**,
so the money goes straight to its bank; Everwake never holds it. Paymob needs a
commercial register, a tax card and a bank account; it charges no monthly fee,
only a fee on each payment.

1. In Paymob's dashboard: **Developers → API keys** (public and secret key),
   **Settings → Account info** (HMAC secret), **Developers → Payment
   integrations** (the card integration ID, and the wallet one). Start with the
   test keys and test integration IDs.
2. Paste them in Settings → Payments, switch on **Customers can pay online**,
   and press **Make a 10 EGP test link**. Pay it with a Paymob test card: the
   page then shows "Paymob last reached us …", which proves the notices arrive.
3. Switch to the live keys when Paymob activates the account.

How it works:
- The agent offers "online by card or wallet" (payment method `online`). When
  it places such an order, the cart tool asks the dashboard
  (`POST /api/pay/link`) for a link; the dashboard creates a Paymob *intention*
  and answers with a short link on its own address (`/p/<ref>`), which opens
  Paymob's checkout. The agent sends it in the same reply.
- Paymob reports every payment to `/api/pay/paymob/<restaurant id>` (sent with
  each link — nothing to paste into Paymob). The dashboard checks Paymob's
  HMAC signature, and the database marks the order **Paid**, tells the customer
  and the branch on WhatsApp, and the agent knows from then on. A forged or
  altered notice is refused.
- A link works for 60 minutes (settable). Unpaid after 15 minutes: one reminder.
  Expired: the branch gets a WhatsApp ("call the customer — a new link or
  cash") and the chat is flagged in the inbox.
- On the order board, a card shows *Waiting for payment* / *Paid online* /
  *Not paid*. The order's drawer can send a new link (with a different amount
  if the total changed), switch the order to cash, or mark it paid.
- A total that may still change (a delivery fee the branch confirms, fees the
  branch adds) gets no automatic link: the team confirms the amount and sends it
  from the order board.
- `npm run paymob:check` (dashboard) checks the signature code against
  Paymob's documented example.

Keeping the keys safe:
- The secret key and the HMAC secret are stored in **Supabase Vault**,
  encrypted: the `payment_accounts` table holds only their Vault ids, so a
  database backup or export shows no key. Vault is on by default in Supabase
  (Database → Extensions → `supabase_vault`).
- After saving, a secret never comes back to any browser — the page shows
  "Saved …1234". No dashboard user, owner included, can read them; only the
  dashboard's server (the service-role key, on Vercel) gets them back, through
  `vault_get`, to call Paymob or check a notice.
- So protect what can reach them: two-factor sign-in on Supabase, Vercel and
  GitHub; `SUPABASE_SERVICE_ROLE_KEY` marked *Sensitive* in Vercel; few people
  on those teams. If a key may have leaked, make a new one in Paymob's dashboard
  and paste it in Settings → Payments — the old one stops working.

## Ordering in the branch (QR codes) and the kitchen screen

**Settings → QR ordering in the branch**: a QR code for each branch's counter
(take away) and one per table (dine-in: `1-12, VIP` adds them all at once).
Each prints as an A6 card with the logo; "Print all cards" opens one card per
page. Set `NEXT_PUBLIC_SITE_URL` first — the address is in the code.

The customer's side (no app, no sign-in):
1. They scan and see that branch's menu: its prices, what is sold out, the
   offers, "often ordered with it" suggestions, Arabic / English.
2. The cart is priced by the server (`/api/q/<code>/checkout`, the same
   arithmetic and offers as the agent's cart): items, discounts, VAT, total.
3. **Card** (needs Paymob, Settings → Online payments): Paymob's checkout, and
   back to the waiting page. The order reaches the kitchen when Paymob confirms.
   **Cash**: a ticket number to show at the counter. Nothing reaches the
   kitchen until the cashier takes the money and taps **Paid**. Unpaid tickets
   expire after 30 minutes.
4. The waiting page shows the order number, a countdown (the branch's prep time
   plus 2 minutes per order already in the kitchen) and the kitchen's notes.
   When it is ready the phone rings, vibrates and flashes. A web page cannot
   wake a locked phone, so it also offers "message me on WhatsApp": one tap
   sends a pre-filled message with the order's code; the customer is linked
   (to their history and loyalty) and "ready" arrives on WhatsApp too.

**Kitchen** (in the sidebar, best on a tablet): one branch, four columns.
"At the counter" (cash tickets waiting for the cashier's Paid), New,
Preparing, Ready — WhatsApp and QR orders together, a ring for each new one,
a red ring on late ones. **Hold and speak** in Arabic: "طلب 123 جاهز",
"قول لصاحب طلب 123 إن الكفتة هتتأخر ٥ دقايق", "الكفتة خلصت لحد بكرة". It
shows what it understood and does it after 3 seconds unless someone taps
cancel. **Ready screen** opens a full-screen board for a TV: the numbers being
prepared and the numbers ready, with a chime.

**Loyalty**: an offer with "every how many orders" (Offers) applies on the
customer's 10th, 20th… order, on WhatsApp and QR alike. The agent and the
waiting page say how close they are.

## Connecting the restaurant's own system (POS, ERP, CRM)

A restaurant that already runs a cashier system keeps it: Everwake sends every
order there and that system can update Everwake back, so nobody types an order
twice. **Settings → Your POS and systems**:

- **Webhooks out.** Add the system's address. Every order (`order.created`,
  `order.updated` for a status or payment change) and every stock switch
  (`item.availability`) is POSTed there as JSON, signed:
  `X-Everwake-Signature: sha256=<HMAC-SHA256 of the raw body with the signing secret>`,
  plus `X-Everwake-Event` and `X-Everwake-Delivery` (the same id on retries).
  The outbox workflow sends them within a minute; a failure retries after 1, 2,
  4… minutes, 7 tries. "Send a test" shows the result on the page.
- **API in.** "Make a key" (shown once) and the system calls with
  `Authorization: Bearer ew_…`:
  - `POST /api/v1/stock` `{"item_code","available","branch_code?","until?"}` (or `{"items":[…]}`)
  - `POST /api/v1/orders/<order_no>/status` `{"status","note?"}` — the customer is told as from the board
  - `GET /api/v1/orders?since=<until>` — for a system that cannot receive webhooks
  - `GET /api/v1/menu?branch=<code>` — the item codes, to map once to the POS's own items
- Odoo: an automation rule can call the API when a product or POS order changes;
  receiving the orders needs a small module or n8n / Make in between. Foodics,
  Loyverse and other cloud POS: n8n, Make or Zapier joins their API to these
  webhooks. The page has the same notes for the restaurant's developer.

## Growth and reports

- **Saved commission:** the Overview and **Get customers** show what the month's
  WhatsApp orders would have paid a delivery app, at the percentage set in
  Settings → Ordering (25% by default).
- **Get customers:** a `wa.me` link and QR code per branch and per place
  (the card in delivery-app bags, the shop, Instagram…), and a printable A6
  card with the logo. The link pre-fills "… عرفتكم من <place>", which the
  agent reads as a normal first message and the page counts: chats, customers
  who ordered, sales and commission saved per place.
- **Missed sales** (Analytics → Missed sales): carts never finished (with a link
  to the chat to follow up), customers outside every delivery zone on a map,
  people who wrote while every branch was closed, rejected / cancelled orders
  and why, chats with no order.
- **Daily report** (Settings → Daily report): a summary of the last 24 hours on
  up to five WhatsApp numbers at the hour chosen. The outbox workflow's
  every-minute housekeeping sends it — nothing to set up in n8n. On the official
  Cloud API it is a message outside a conversation, so it needs an approved
  template there.

## The dashboard's languages

The dashboard has an English / العربية switch in the top bar and on the
sign-in page; the choice is remembered per browser, and Arabic turns the
whole layout right to left. Every text is in `dashboard/src/lib/i18n-ar.ts`
(English text → Arabic). `npm run i18n:check` fails if a text in the code has
no Arabic, so nothing ships half-translated.

## Tests (developers)

```sh
# a local Postgres 16 is enough
cd database && PGHOST=localhost PGUSER=postgres PGPASSWORD=... ./tests/run.sh
cd engine && npm install && PGHOST=localhost PGUSER=postgres PGPASSWORD=... npm test
cd dashboard && npm install && npm run typecheck && npm run i18n:check && npm run build
```
