# Everwake — Brand & Asset Roadmap

Everything Everwake puts in front of a client, built in dependency order so
nothing has to be redone. One identity, one token file, every surface in step.

**Decisions locked (1 Oct 2026):** static HTML/CSS site · English first, Arabic-ready
· refine the existing type pairing · HTML deck with PDF export.

---

## Phase 1 — Brand foundation ✅ DONE

The layer every other deliverable consumes.

| Item | Status | Where |
|---|---|---|
| Logo rebuilt as true vector (7 variants) | ✅ | `brand/logo/` |
| Design tokens — colour, type, space, motion | ✅ | `brand/tokens/everwake.css` |
| Token sync to all deliverables | ✅ | `./sync-tokens.sh` |

The logo was reconstructed from the bézier geometry inside the company-profile
PDF, not traced — it is mathematically identical to the original at any size.

## Phase 2 — Website ✅ DONE

Six pages, no build step, no dependencies. Deploys to Netlify, Vercel, Cloudflare
Pages or GitHub Pages by pointing at `EVERWAKE WEBSITE/web`.

| Page | Purpose |
|---|---|
| `index.html` | Positioning, five services, proof, engagement, ownership |
| `services.html` | What each of the five services actually covers |
| `agent.html` | The Conversational Commerce Agent as a product |
| `approach.html` | Four-week engagement, principles, commercials |
| `work.html` | IQ Homes Qatar case study, applicable verticals |
| `contact.html` | Discovery-call form and direct contacts |

Verified: no horizontal overflow at 390px, no console errors, AA contrast on
every text/background pair, keyboard-navigable, print stylesheet included.

## Phase 2b — Editability, social and the AI agent ✅ DONE

| Item | Status |
|---|---|
| All contacts moved into one settings file | ✅ `EVERWAKE WEBSITE/web/site-config.js` |
| Social links with auto-hiding icons | ✅ |
| Contact form with email / WhatsApp / Formspree modes | ✅ |
| AI agent chat widget, ready for an n8n webhook | ✅ |
| Beginner guide to editing the site | ✅ `EVERWAKE WEBSITE/docs/EDITING.md` |
| Beginner guide to GitHub and going live | ✅ `EVERWAKE WEBSITE/docs/PUBLISH.md` |
| Netlify configuration so deploy settings cannot be mistyped | ✅ `netlify.toml` |

Contacts, social links and the agent endpoint are deliberately left empty. The
site hides whatever is unfilled, so it is safe to publish today and complete
later.

## Phase 2c — Site restructure, languages, lead capture ✅ DONE

| Item | Status |
|---|---|
| Apple-style frosted top bar with pill navigation | ✅ |
| Services dropdown — 8 services, each with its own section | ✅ |
| Removed How It Works / Case Studies (old links redirect) | ✅ |
| Pricing as three bundles, no prices, free demo + meeting | ✅ |
| New pages: FAQ, Blog (3 articles), About | ✅ |
| Green WhatsApp button to the agent's line, every page | ✅ |
| Contact form at the bottom of every page | ✅ |
| English · Arabic (right-to-left) · Spanish · French | ✅ 501 strings each |
| Apple's typography (San Francisco / Inter) | ✅ |
| Shared chrome in one place, link checker | ✅ `EVERWAKE WEBSITE/tools/sync_chrome.py` |

## Phase 3 — Brand book — NEXT

The written rules, so the identity survives other people using it.

- Logo: clear space, minimum sizes, the backgrounds it may sit on, misuse examples
- Colour: the palette with contrast pairings and what each colour is *for*
- Typography: the scale, the wide-tracked caps label, Arabic stack
- Voice and tone: the Everwake sentence — declarative, unhyped, proof-led
- The document grammar: gold band, numbered sections, hairline rules, stat rows

## Phase 4 — Proposal template

A reusable version of the 5 Roosters proposal: fill a content file, get a
branded HTML proposal that prints to PDF with correct page breaks.

- Cover with reference number and validity date
- Problem / today-vs-after comparison
- What the customer experiences
- Why it holds up under real traffic
- Packages and investment
- Commercial terms and signature block

## Phase 5 — Company presentation

HTML deck, keyboard-driven, exporting to PDF. Roughly 16 slides: who we are,
the problem, the five services, the agent, proof, engagement, ownership models,
the stack, the ask.

## Phase 6 — Social media identity

- Grid system and post templates (square, portrait, story)
- Content pillars and a posting cadence
- LinkedIn / Instagram profile assets and cover art
- Caption voice rules and a hashtag set

## Phase 7 — Sales collateral

- Company profile regenerated from the token system
- One-page service sheets
- Email signature and document letterhead

---

## Everwake Orders — WhatsApp ordering platform

The Seagull agent rebuilt as one engine for every restaurant, with a
dashboard each restaurant runs. Everything is in `EVERWAKE-ORDERS/`.

### Built ✅

| Item | Where |
|---|---|
| Multi-restaurant database: menus with choice levels and branch prices, zones, customers by number or private id, orders, conversations; row-level security; a read-only schema per restaurant | `database/` |
| Engine: Brain → Agent → tools → Check Reply → Rewrite, zones from a pin or an area name, offers, "same as last time", photos and menu pages on request | `engine/` |
| Agent ON / OFF with a warm apology and a "we're back" message for everyone who wrote | `engine/`, `database/` |
| Take over a chat, reply from the dashboard, hand back; the agent sees what was said | `engine/`, `dashboard/` |
| Dashboard: live order board, inbox, menu with stock switches, AI menu import (PDF, photos, link, text, spreadsheet), offers, branches, zones on a map, customers, analytics, settings, team | `dashboard/` |
| Moving Seagull-style clients over with their menu, customers and order history | `database/tools/import_legacy.sql` |
| Restaurant drivers: added with a WhatsApp number, sign-in link instead of a password, a driver page with the map, directions, the customer's number and a chat; the customer hears who is coming and when they are ~5 minutes away; cash per driver | `database/migrations/008_drivers.sql`, `dashboard/` |
| Logo and brand colour; designed menu pictures drawn from the live menu | `dashboard/` |
| Growth: saved commission on the Overview; a WhatsApp link, QR code and printable card per branch and place, with chats / orders / sales per place; missed sales (unfinished carts, outside the zones on a map, written while closed, refused orders); the owner's daily report on WhatsApp | `database/migrations/009_growth.sql`, `dashboard/` |
| Tests: 8 SQL test files, 9 whole-conversation engine tests | `database/tests/`, `engine/test/` |

### Next

- **First live run:** import the workflows into n8n, connect a test number, place real test orders
- **Move Seagull, Bazooka and 5 Roosters** over with the importer
- **Official WhatsApp Cloud API** for paying restaurants: Meta's embedded signup, a second webhook, an approved template for "we're back" after 24 hours
- **Plans and billing** per restaurant
- **Driver app for Android:** background location while Google Maps is open
- **Delivery companies** (Mrsool, Roadrunner…) for restaurants without drivers, through one connection point
- **Growth kit:** QR codes and `wa.me` links per restaurant from the dashboard

---

## Working agreements

- `brand/tokens/everwake.css` is the **only** place colour and type are defined.
  Change it there, run `./sync-tokens.sh`, and every surface follows.
- Nothing claims a client Everwake has not delivered for. IQ Homes Qatar is the
  case study; the 5 Roosters document is a proposal and is presented as one.
- Contrast is checked, not assumed. Gold text never sits on white — that is what
  `--ew-gold-ink` exists for.
