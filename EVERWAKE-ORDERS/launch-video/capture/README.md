# Filming the dashboard

The launch film shows the **real dashboard**, running on this machine on the
showcase restaurant ("بيت المشويات", `database/tools/showcase_restaurant.sql`):
30 days of orders, chats, customers, drivers and bookings, all made up. These
scripts start it, add what the film needs, and screenshot every scene.

Nothing here touches a real restaurant or Supabase project: it is a plain
Postgres and a small stand-in for Supabase (`local-supabase.mjs`) — one demo
user, no passwords. **For filming only.**

| File | What it does |
|---|---|
| `setup.sh` | Builds the filming database from scratch: the migrations, the showcase restaurant, the stand-ins (`supabase-stub.sql`) and the live-update triggers (`realtime.sql`) |
| `local-supabase.mjs` | Sign-in, the database API (run as the signed-in user, so row level security applies), file storage and live updates — the parts of Supabase the dashboard uses |
| `demo-data.mjs` | What the showcase lacks: more offers, Paymob connected, a driver signed in, and the featured customer, who orders by voice note and photo |
| `capture.mjs` | Films each scene into `shots/<scene>/` with where the cursor goes; writes `shots/manifest.js` for the film |
| `assets/` | The made-up restaurant's logo, the new dishes the import scene loads, where the pen circle goes on the menu photo |

## Run it

Needs Postgres 16, Node 22, Playwright with Chromium, and ffmpeg.

```sh
# 1. a Postgres for filming (any; this uses port 5433 and a socket in /tmp)
initdb -D /var/tmp/ewpg -U postgres --auth=trust
pg_ctl -D /var/tmp/ewpg -o '-p 5433 -k /tmp' start

# 2. the database, then the Supabase stand-in
cd launch-video/capture && npm install
PGHOST=/tmp PGPORT=5433 ./setup.sh
STORAGE_DIR=/var/tmp/ewdemo/storage PRINT_KEYS=1 node local-supabase.mjs &
#    (prints the anon and service keys for the next step)

# 3. the dashboard, on port 80 (the camera opens it as orders.everwake.tech)
cd ../../dashboard && npm ci
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> \
SUPABASE_SERVICE_ROLE_KEY=<service> npx next build && npx next start -p 80 &

# 4. film every scene (about 6 minutes), or only some: node capture.mjs menu places
cd ../launch-video/capture && node capture.mjs
```

Run `setup.sh` again before a full take: scenes change things (an order is
accepted, a dish goes out of stock, a branch pauses), and every take should
start from the same place. Restart `local-supabase.mjs` after it.

## Two things the filming browser does differently

- The dashboard is served on plain http, which is not a "secure context", so
  the browser hides `crypto.randomUUID` (uploads use it). `lib.mjs` puts back a
  stand-in. The driver's app needs location, so it is opened on `localhost`.
- The top bar's `backdrop-blur` makes it the box that its dialogs are fixed to,
  so the agent switch's confirmation is squeezed into the 56px bar and clipped.
  That is a bug in the dashboard itself; `lib.mjs` turns the blur off so the
  dialog shows as it is meant to.
