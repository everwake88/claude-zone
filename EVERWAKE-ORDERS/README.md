# Everwake Orders

WhatsApp ordering for restaurant chains. The customer messages the
restaurant's WhatsApp as they do today. An AI host takes the order: the
menu, choices, weights, the delivery zone, offers, the address, payment.
The restaurant runs everything from a dashboard.

It is the Seagull engine — Brain, Agent, tools, Check Reply, Rewrite —
rebuilt so **one engine serves every restaurant**. A new restaurant is
rows in the database, not a copy of the workflows.

```
 customer ─ WhatsApp ─ Evolution API ──► n8n: Everwake — Main ──► reply
                                             │  Brain → Agent → tools → Check Reply
                                             ▼
                              Postgres (Supabase)  everwake.*  ◄── dashboard (Next.js)
                                             ▲                       orders · inbox · menu
                         n8n: Everwake — Outbox (staff replies, order updates, "we're back")
```

## What is in here

| Folder | What it is |
|---|---|
| `database/` | The schema, every function the engine and the dashboard call, row-level security, a demo restaurant, the importer that moves an old Seagull-style client over (`tools/`), and the SQL tests |
| `engine/` | The n8n workflows. Code lives in `src/` (one file per Code node) and `prompts/`; `build.mjs` writes the five importable workflows to `dist/` |
| `dashboard/` | The restaurant dashboard (Next.js + Supabase): live orders, inbox with takeover, table bookings, menu, AI menu import, offers, branches, delivery zones, drivers, customers, analytics, settings |
| `docs/` | How it works, how to set it up, how to sign up a restaurant, how to run it |

## What a restaurant gets

- **The agent** answers in Egyptian Arabic or English. It knows every dish, every choice, every branch's prices and hours. It finds the delivery zone from a location pin (or the area name), applies the offers, and never invents a price. It remembers each customer's last order and addresses, whether they come back by number or by the private ID WhatsApp sometimes shows instead. It sends a dish's photo when someone wants to see it, and the menu when asked. At restaurants with dine-in it books a table in conversation and sends the request to the branch to confirm.
- **The dashboard**
  - Live order board that rings for new orders. Every step (accepted, out for delivery…) is sent to the customer on WhatsApp.
  - Inbox of every conversation. Take over a chat, reply, hand it back; the agent reads what you wrote and carries on.
  - Table bookings: the requests the agent took, to confirm or decline after a call — the customer hears it on WhatsApp.
  - Menu editor with an out-of-stock switch (for an hour, for today, or until switched back), per-branch prices and photos.
  - AI menu import from a PDF, photos, a link, pasted text or a spreadsheet.
  - Offers and promo codes, branches with hours and a "too busy" pause, delivery zones drawn on a map, customers, analytics with "commission saved", and every automatic message in the restaurant's own words.
- **The agent switch.** Turn it OFF when the kitchen is full: everyone who writes gets one warm apology and is remembered. Turn it ON and they all get "we're back, order now".

Every save in the dashboard reaches the agent on its very next message.

## Start here

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit, and why
2. [docs/SETUP.md](docs/SETUP.md) — Supabase, n8n, Evolution, the dashboard: from zero to the first test order
3. [docs/ONBOARDING.md](docs/ONBOARDING.md) — signing up a restaurant and going live in a day
4. [docs/OPERATIONS.md](docs/OPERATIONS.md) — day to day, monitoring, costs, scaling, moving Seagull / Bazooka / 5 Roosters over

## Tests

```sh
# database: builds a fresh database from the migrations and runs every assertion
cd database && PGHOST=localhost PGUSER=postgres PGPASSWORD=… ./tests/run.sh

# engine: whole WhatsApp conversations through the real Code nodes and SQL
cd engine && npm install && PGPASSWORD=… npm test

# dashboard: types and a production build
cd dashboard && npm install && npm run typecheck && npm run build
```
