# Everwake

Brand system, website and client-facing assets for Everwake — an AI
transformation and intelligent automation studio.

> **Intelligent automation, built to be owned.**

## Layout

```
brand/
  logo/            7 logo variants, true vector
  tokens/          everwake.css — the single source of truth
web/
  site-config.js   contacts, social links, form and AI agent — edit this
  *.html           the six pages
  assets/          styles, scripts, images
templates/         proposal template            (Phase 4)
deck/              company presentation         (Phase 5)
social/            social media kit             (Phase 6)
docs/ROADMAP.md    what is done and what is next
sync-tokens.sh     push token changes to every deliverable
```

## Run the site locally

```sh
cd web && python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy

The site is plain HTML, CSS and one small JavaScript file. Point any static
host at the `web/` directory — no build command, no install step.

| Host | Setting |
|---|---|
| Netlify / Vercel | Publish directory `web`, build command empty |
| Cloudflare Pages | Build output directory `web` |
| GitHub Pages | Serve from `/web` on the default branch |

## Changing your details — start here

Contact details, social links, the enquiry form and the AI agent are all set in
**one file**: `web/site-config.js`. Nothing else needs touching, and anything
left empty is hidden from the site rather than shown as a placeholder.

Step-by-step, assuming no coding knowledge:

- **[docs/EDITING.md](docs/EDITING.md)** — how to change anything on the site
- **[docs/GO-LIVE.md](docs/GO-LIVE.md)** — putting everwake.tech online via Cloudflare
- **[docs/PUBLISH.md](docs/PUBLISH.md)** — GitHub basics and other hosting options

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
