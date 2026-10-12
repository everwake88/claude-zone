# EVERWAKE WEBSITE

Everything for **[everwake.tech](https://everwake.tech)** lives in this folder.

| Folder | What it is | Do you edit it? |
|---|---|---|
| **`web/`** | The live website — exactly what visitors see | Yes |
| `web/site-config.js` | Contacts, WhatsApp button, contact form, social links, AI chat | **Yes — most changes happen here** |
| `web/i18n/` | Arabic, Spanish and French translations | Yes, to change a translation |
| `src/partials/` | The top bar, footer and contact form, shared by every page | Rarely — see below |
| `tools/` | The script that copies the shared parts into every page | No |
| `docs/` | The guides | Read them |

## The guides

- **[docs/EDITING.md](docs/EDITING.md)** — change contacts, the WhatsApp button, the form, languages or page text
- **[docs/GO-LIVE.md](docs/GO-LIVE.md)** — how everwake.tech is connected through Cloudflare
- **[docs/PUBLISH.md](docs/PUBLISH.md)** — GitHub Desktop basics, and other ways to host the site

## See the site on your computer

Open this folder → `web` → double-click **`index.html`**. Every language works
this way too: add `?lang=ar` (or `es`, `fr`) to the end of the address.

## How it goes live

Commit and push in GitHub Desktop. Cloudflare rebuilds the live site from this
folder within about a minute. **Every push goes live**, so check your change on
your computer first.

Cloudflare finds this folder through `wrangler.jsonc` at the top of the
repository. That file — and `netlify.toml` and `.github/` beside it — must stay
at the top level, outside this folder: hosting services only look for their
settings there.

## The pages

`index.html` home · `services.html` the eight services · `agent.html` chat
agent detail · `pricing.html` bundles · `faq.html` · `blog.html` and `blog/`
articles · `about.html` · `contact.html` · `404.html` page-not-found

## Changing the top bar, footer or contact form

These exist once, in `src/partials/`. After editing one, run this from the top
of the repository to copy it into every page and check every link:

```sh
python3 "EVERWAKE WEBSITE/tools/sync_chrome.py"
```

Or ask Claude to make the change.

## Brand colours and fonts

The logo and colours are not in this folder — they live in `brand/` at the top
of the repository, because the proposal template, presentation and social kit
use them too. After changing them, run `./sync-tokens.sh` to bring the website
in line.
