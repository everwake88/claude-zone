# Everwake

Brand system, website and client-facing assets for Everwake — an AI
transformation and intelligent automation studio.

> **Intelligent automation, built to be owned.**

## Layout

```
EVERWAKE WEBSITE/        everything for the website
  web/                   the live site — what visitors see
    site-config.js       contacts, WhatsApp, form, social, AI chat — edit this
    i18n/                Arabic, Spanish and French translations
  src/partials/          the shared top bar, footer, contact form and <head>
  tools/sync_chrome.py   stamps the shared parts into every page, checks links
  docs/                  how to edit, publish and go live
EVERWAKE-ORDERS/         WhatsApp ordering for restaurant chains — see its README
  database/              the schema and every function the engine calls, with tests
  engine/                the n8n workflows, generated from src/ and prompts/
  dashboard/             the restaurant dashboard (Next.js + Supabase)
  docs/                  how it works, setup, signing up a restaurant, operations
brand/                   logo and colours — shared by website, proposals, deck
docs/ROADMAP.md          what is done and what is next
templates/ deck/ social/ upcoming phases
wrangler.jsonc           Cloudflare deploy settings (must stay at the top level)
netlify.toml, .github/   other hosts' settings (must stay at the top level)
sync-tokens.sh           push brand colour changes to every deliverable
```

## Run the site locally

```sh
cd "EVERWAKE WEBSITE/web" && python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy

The site is plain HTML, CSS and one small JavaScript file. Point any static
host at the `EVERWAKE WEBSITE/web` directory — no build command, no install step.

| Host | Setting |
|---|---|
| Netlify / Vercel | Publish directory `EVERWAKE WEBSITE/web`, build command empty |
| Cloudflare | Already configured by `wrangler.jsonc` |
| GitHub Pages | Serve from `/web` on the default branch |

## Everwake Orders

The WhatsApp ordering platform: one AI ordering agent serving every
restaurant, and a dashboard each restaurant runs it from. Start at
**[EVERWAKE-ORDERS/README.md](EVERWAKE-ORDERS/README.md)**, then
[docs/SETUP.md](EVERWAKE-ORDERS/docs/SETUP.md) to set it up.

## Changing your details — start here

Contact details, social links, the enquiry form and the AI agent are all set in
**one file**: `EVERWAKE WEBSITE/web/site-config.js`. Nothing else needs touching, and anything
left empty is hidden from the site rather than shown as a placeholder.

Step-by-step, assuming no coding knowledge:

- **[EVERWAKE WEBSITE/docs/EDITING.md](EVERWAKE%20WEBSITE/docs/EDITING.md)** — contacts, WhatsApp, the form, languages, page text

- **[EVERWAKE WEBSITE/docs/GO-LIVE.md](EVERWAKE%20WEBSITE/docs/GO-LIVE.md)** — putting everwake.tech online via Cloudflare
- **[EVERWAKE WEBSITE/docs/PUBLISH.md](EVERWAKE%20WEBSITE/docs/PUBLISH.md)** — GitHub basics and other hosting options

## Changing the brand

Colour, typography, spacing and motion live in `brand/tokens/everwake.css`.
Edit that file, then:

```sh
./sync-tokens.sh
```

This copies the tokens into the website, the deck and the proposal template so
every Everwake surface stays identical. Never hard-code a hex value in a page.

## Logo

`brand/logo/` holds the mark, the horizontal lockup and a monochrome set that
inherits `currentColor`. All files are tight-cropped vector — apply clear space
in layout rather than expecting padding inside the file.

| File | Use |
|---|---|
| `everwake-lockup.svg` | Default, on navy or any dark surface |
| `everwake-lockup-navy.svg` | On white, paper or any light surface |
| `everwake-lockup-mono.svg` | Single-colour contexts; inherits `currentColor` |
| `everwake-mark.svg` | The mark alone, on dark |
| `everwake-mark-navy.svg` | The mark alone, on light |
| `everwake-mark-mono.svg` | The mark alone, single colour |
| `everwake-icon.svg` | Favicon and app icon — mark on a navy tile |

## Before you publish anything

- Gold (`#B8913F`) on white is 2.7:1 and fails. Use `--ew-gold-ink` for gold
  text on light surfaces.
- Navy on gold is 5.9:1 and passes. That is the primary button.
- Check 390px width. The site is verified clean there.
