# How to change things on your website

No coding knowledge needed. Almost everything you will want to change lives in
**one file**: `web/site-config.js`.

---

## The golden rules

1. **Only change the text between the quote marks** `"like this"`.
2. **Keep the quote marks and the comma** at the end of each line.
3. **Leave something empty** (`""`) and it disappears from the website
   automatically. Nothing breaks.
4. If something goes wrong, undo your change and save again. You cannot
   permanently damage anything — every old version is kept in GitHub.

---

## Changing your contact details

Open `web/site-config.js` and find section 2. It looks like this:

```js
contact: {
  email: "",
  whatsapp: "",
  location: "",
```

Fill in what you have:

```js
contact: {
  email: "hello@everwake.tech",
  whatsapp: "+201554354929",
  location: "Cairo, Egypt",
```

**The WhatsApp number must be written in full international format** with no
spaces — `+201554354929`, not `0155 435 4929`. The website formats it nicely
for visitors by itself.

Save the file. Your email and number now appear in the footer of every page and
on the contact page. You did not touch six separate pages — just this one.

### The people clients can call

```js
people: [
  { name: "Abdelrhman Basem", role: "Co-founder", phone: "+201554354929" },
  { name: "Ahmed El-Qady",    role: "Co-founder", phone: "+201144017735" }
]
```

- Leave `phone` empty and that person shows with their role instead of a number.
- To remove someone, delete their whole `{ ... },` line.
- To add someone, copy an existing line and change the details. Make sure every
  line except the last ends with a comma.

---

## Adding your social media

Find section 3 and paste the **full web address** of each profile:

```js
social: {
  linkedin:  "https://www.linkedin.com/company/everwake",
  instagram: "https://www.instagram.com/everwake",
  facebook:  "",
  x:         "",
  youtube:   "",
  tiktok:    ""
}
```

Icons appear automatically for whichever ones you fill in. Empty ones are
hidden — so there is no half-finished row of dead icons.

**You do not need to fill in `whatsapp` here.** If you entered a WhatsApp number
in section 2, the WhatsApp icon is created for you.

The address must start with `https://`. Anything else is ignored for safety.

---

## Where enquiries go

Find section 4. You have three choices:

| `mode` | What happens when someone submits the form |
|---|---|
| `"email"` | Opens their email app with the message filled in, addressed to you. **Works immediately, nothing to set up.** |
| `"whatsapp"` | Opens WhatsApp with the message ready to send to you. |
| `"formspree"` | The message is emailed to you silently, like a real form. Needs a free account. |

`"email"` is the default and needs nothing from you except an email address.

**To use Formspree** (nicer experience for the visitor):
1. Go to [formspree.io](https://formspree.io) and create a free account.
2. Create a new form. They give you an address like `https://formspree.io/f/abcdwxyz`.
3. Paste it into `formspreeUrl` and change `mode` to `"formspree"`.

---

## Putting your AI agent on the website

Find section 5. This is the chat bubble in the bottom corner.

**Right now it is hidden**, because there is nothing for it to talk to yet. It
appears by itself as soon as you fill in one of the two options below.

### Option A — connect your real agent (what you actually want)

You already build these with n8n. Point the website at one:

1. In n8n, create a workflow starting with a **Webhook** node, method `POST`.
2. Connect it to your AI agent logic.
3. End the workflow with a **Respond to Webhook** node returning JSON:
   ```json
   { "reply": "your agent's answer here" }
   ```
4. Copy the webhook's Production URL.
5. Paste it into `webhookUrl` in `site-config.js`.

```js
agent: {
  mode: "auto",
  webhookUrl: "https://n8n.everwake.tech/webhook/site-agent",
```

That is all. The bubble appears on every page.

**What the website sends your workflow** on each message:

```json
{
  "message":   "what the visitor typed",
  "sessionId": "a code identifying this visitor's conversation",
  "history":   [ { "role": "user", "content": "..." } ],
  "source":    "website",
  "page":      "/services.html"
}
```

Use `sessionId` to keep each visitor's conversation separate, and `history` so
the agent remembers what was already said.

**What your workflow should send back** — any of these field names work, so you
do not have to reshape an existing workflow: `reply`, `output`, `message`,
`text`, `answer`, or `response`.

> **One thing to check:** your n8n webhook must allow requests from your website
> address (CORS). If the bubble appears but every message fails, that is almost
> always the cause. In n8n, add a response header
> `Access-Control-Allow-Origin` set to your website address.

### Option B — WhatsApp instead (works today, zero setup)

If you just fill in your WhatsApp number in section 2 and leave `webhookUrl`
empty, the bubble becomes a "Chat with us" button that opens WhatsApp. That is
a perfectly good starting point while the real agent is being built.

### Changing what the agent says first

```js
greeting: "Ask me anything about what Everwake builds.",
suggestions: [
  "What exactly do you build?",
  "How long does a project take?",
  "Can I own the system outright?"
]
```

The suggestions are the clickable buttons shown before the visitor types.

### Turning it off

Set `mode: "off"`.

---

## Changing the words on a page

The headings and paragraphs live inside the page files in the `web` folder:

| File | The page |
|---|---|
| `index.html` | Home |
| `services.html` | Services |
| `agent.html` | The Agent |
| `approach.html` | Approach |
| `work.html` | Work |
| `contact.html` | Contact |

Open a file and look for the text you want to change. It sits between tags that
look like `<h2>` and `</h2>`, or `<p>` and `</p>`:

```html
<h2>Five services, one knowledge base.</h2>
<p>In practice a client starts with one...</p>
```

**Change only the words.** Leave the `<h2>` and `</h2>` parts alone.

> **Careful with symbols.** If your text needs an `&`, write `&amp;` instead.
> `<` and `>` should be written `&lt;` and `&gt;`. Everything else is fine.

---

## Changing the colours or fonts

These live in `brand/tokens/everwake.css`. After changing anything there, run
this once so every part of the brand updates together:

```sh
./sync-tokens.sh
```

**One warning:** the gold `#B8913F` is not readable as text on a white
background. If you want gold text on a light page, use `--ew-gold-ink` instead.
This is already handled everywhere on the current site.

---

## Checking your work

1. Open the `web` folder and double-click `index.html`. It opens in your browser.
2. Look at the footer — are your details there?
3. Press `F12`, click **Console**. If anything is still unfilled, a line tells
   you exactly which setting it is waiting for. Visitors never see this.

Then follow `docs/PUBLISH.md` to put the changes online.
