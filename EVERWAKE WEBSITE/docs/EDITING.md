# How to change things on your website

No coding knowledge needed. Most changes happen in **one file**:
`EVERWAKE WEBSITE/web/site-config.js`. Open it in VS Code (free) or any text editor.

## The golden rules

1. **Change only the text between the quote marks** `"like this"`.
2. **Keep the quote marks and the comma** at the end of each line.
3. **Leave something empty** (`""`) and it disappears from the site. Nothing breaks.
4. Every saved version is kept in GitHub, so you can always go back.

After any change: **save → commit → push** in GitHub Desktop. The live site
updates in about a minute.

> **Every push goes live.** Your Cloudflare site rebuilds from this branch
> automatically, so check your change locally first (double-click
> `EVERWAKE WEBSITE` → `web` → `index.html`) before you push.

---

## Contact details — section 2

```js
contact: {
  email: "everwake88@gmail.com",
  whatsapp: "+201505099818",     // the number the green button opens
  phones: [
    "+201505099818"
  ],
  location: ""                   // optional, e.g. "Cairo, Egypt"
},
```

- Numbers in **international format, no spaces**: Egypt `01505099818` → `+201505099818`.
  The site formats them nicely for visitors itself.
- Add another phone: copy a line inside `phones`, change the number. Every line
  except the last ends with a comma.
- To change which number the green WhatsApp button opens, change `whatsapp`.

These appear in the footer of every page and in the contact section at the
bottom of every page.

## Social media — section 3

Paste the full address of each profile:

```js
linkedin:  "https://www.linkedin.com/company/everwake",
instagram: "https://www.instagram.com/everwake",
```

Icons appear for whichever you fill in. Until you fill in at least one, the
social row is hidden entirely — no empty space, no dead icons.

## The green WhatsApp button — section 4

```js
whatsappButton: {
  show: true,
  label: "Chat on WhatsApp",
  message: "Hello Everwake, I would like to know more about your services."
}
```

`message` is what is already typed for the visitor when WhatsApp opens. It is
translated automatically when the visitor is reading in another language.
Set `show: false` to hide the button.

## The contact form — section 5

The form at the bottom of every page works **today**: with nothing else set
up, pressing Send opens WhatsApp with the visitor's enquiry already written,
addressed to your WhatsApp number.

**Strongly recommended — have enquiries arrive in your inbox (2 minutes, free):**

1. Go to **[web3forms.com](https://web3forms.com)**.
2. Type the email address enquiries should go to, and submit.
3. They email you an **Access Key** (a long code).
4. Paste it into `web3formsKey`:
   ```js
   web3formsKey: "a1b2c3d4-....",
   ```
5. Save, commit, push.

Now the form sends silently, shows the visitor a "Thank you" message, and
emails you the name, email, company, WhatsApp number, service and message.
If sending ever fails, the visitor is offered your WhatsApp instead, and what
they typed is kept.

## Languages

The site speaks **English, Arabic, Spanish and French**. Visitors switch with
the globe button in the top bar; their choice is remembered on every page.
Visitors whose browser is set to Arabic, Spanish or French get that language
automatically on their first visit.

Arabic switches the whole layout to right-to-left.

### Changing a translation

Translations live in `EVERWAKE WEBSITE/web/i18n/` — one file per language: `ar.js`, `es.js`,
`fr.js`. Each line is a pair:

```js
"Book a free demo": "احجز عرضًا تجريبيًا مجانيًا",
```

Change only the text on the **right**. The English on the left is how the
site finds the line, so leave it exactly as it is.

### When you change English text on a page

If you edit an English sentence in a page, its old translations no longer
match, so that sentence shows in English in every language until you update
the three language files: find the old English on the left, replace it with
your new English, and update the translation on the right.

Nothing breaks in the meantime — the sentence just stays in English.

**To find every untranslated sentence on a page**, open it with `?i18n-debug=1`
at the end of the address, plus the language, e.g.

```
https://everwake.tech/pricing?lang=ar&i18n-debug=1
```

then press `F12` → **Console**. It lists every sentence still waiting for a
translation. Zero means the page is fully translated.

### Blog articles

Article pages are published in English only, and show a short notice saying so
in the other languages. The blog list, headings and everything around the
articles are translated.

## The AI chat on the website — section 7

Hidden until you paste your agent's webhook address:

```js
webhookUrl: "https://n8n.everwake.tech/webhook/site-agent",
```

Then a chat panel appears in the opposite corner to the WhatsApp button. Each
message is sent to your webhook as:

```json
{ "message": "...", "sessionId": "...", "history": [...],
  "language": "ar", "source": "website", "page": "/pricing" }
```

`language` tells your agent which language the visitor is reading in, so it can
answer in the same one. Reply with JSON such as `{ "reply": "..." }`.

> **CORS:** if the chat appears but every message fails, your webhook must allow
> requests from `https://everwake.tech`. In n8n, set the response header
> `Access-Control-Allow-Origin` to that address.

## Changing words on a page

Pages are in `EVERWAKE WEBSITE/web`:

| File | Page |
|---|---|
| `index.html` | Home |
| `services.html` | Services (the eight service sections) |
| `agent.html` | Chat agent product detail |
| `pricing.html` | Pricing bundles |
| `faq.html` | FAQ |
| `blog.html` | Blog list |
| `blog/*.html` | Blog articles |
| `about.html` | About |
| `contact.html` | Contact |

Find the text and change only the words between tags like `<h2>` and `</h2>`.
Write `&amp;` instead of `&`. Then update the translations (see above).

**Don't edit anything between `<!-- ew:header -->` and `<!-- /ew:header -->`**
(or `ew:head`, `ew:contact`, `ew:footer`). Those parts are shared by every page
and are overwritten — see below.

## Changing the top bar, footer or contact form

The top bar, the Services dropdown, the footer and the contact form exist **once**,
in `EVERWAKE WEBSITE/src/partials/`. After editing one, stamp it into every page:

```sh
python3 "EVERWAKE WEBSITE/tools/sync_chrome.py"
```

It updates all pages, then checks every link and `#section` anchor on the site
and tells you if anything is broken. If running commands isn't comfortable,
ask Claude to make the change — this is exactly the kind of edit to hand over.

## Colours and fonts

In `brand/tokens/everwake.css`, then run `./sync-tokens.sh`.

The site uses Apple's fonts: on a Mac, iPhone or iPad visitors see
**San Francisco**, the exact font apple.com uses. San Francisco can't legally be
embedded in a website, so everyone else gets **Inter**, the closest freely
licensed match. Arabic uses San Francisco Arabic on Apple devices and
IBM Plex Sans Arabic elsewhere.

Gold `#B8913F` is unreadable as text on white — use `--ew-gold-ink` for gold
text on light backgrounds.
