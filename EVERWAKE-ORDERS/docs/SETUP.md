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
| `N8N_OUTBOX_SECRET` | A long random string; the same value goes into n8n (step 3) |
| `NEXT_PUBLIC_SITE_URL` | Optional: the dashboard's public address for the links sent to drivers (sign-in, "your orders"). Without it, the address the page was opened on is used |

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

1. **Credentials** (n8n → Credentials):
   - **Postgres → name it "Everwake DB".** Supabase → Settings → Database → *Connection string*.
     - Supabase's direct host is IPv6-only, so from most VPSs use the **Session pooler**: host `aws-0-<region>.pooler.supabase.com`, port `5432`, user `postgres.<project-ref>`, your database password, SSL on.
   - **OpenAI** — the account the Seagull agent already uses is fine.
   - **Header Auth → name it "Everwake Outbox Secret".** Header name `x-everwake-secret`; value = the same string as the dashboard's `N8N_OUTBOX_SECRET`.
2. **Import the five workflows** from `engine/dist/`, in this order:
   1. `everwake-tool-manage-cart.json`
   2. `everwake-tool-save-customer-details.json`
   3. `everwake-tool-manage-reservation.json`
   4. `everwake-outbox.json`
   5. `everwake-main.json`
3. **In "Everwake — Main (Brain + Agent)":**
   - Open the **manage_cart**, **save_customer_details** and **manage_reservation** tool nodes, which show `SET_AFTER_IMPORT`, and pick the three tool workflows you just imported.
   - Pick the **Everwake DB** credential on every Postgres node, and your OpenAI credential on Brain Model, Agent Model and Rewrite Model. n8n lists the nodes missing a credential.
4. **In "Everwake — Outbox + Housekeeping":** pick **Everwake DB** on the Postgres nodes and **Everwake Outbox Secret** on *Ping From Dashboard*.
5. **Activate** Main and Outbox. The three tools are called by Main and need no activation.
   Each tool workflow has one Postgres node: pick **Everwake DB** on it too.
6. *(Busy platform)* Run n8n in **queue mode** with a couple of workers once you pass a handful of restaurants. The debounce and conversation locks already make concurrent runs safe.

The workflows are generated. To change the engine:
1. Edit `engine/src/…` or `engine/prompts/…`.
2. Run `cd engine && npm test` (it needs a local Postgres), then `node build.mjs`.
3. Re-import the changed workflow.

`EW_MODEL`, `EW_PG_CRED_ID` and `EW_OPENAI_CRED_ID` set the model and credential ids at build time.

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
confirmed before that (a rail in Check Reply rewrites a reply that does).
**Decline** (with an optional reason) offers them another time; after the day,
mark **Arrived** or **Did not come**. A customer can cancel on WhatsApp, and the
branch is told. **Booking rules** on that page sets the largest group, how far
ahead, and the occasions the agent may mention. The daily report counts the
requests and how many still wait for the team.

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
