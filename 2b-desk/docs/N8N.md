# Connecting n8n to 2B Desk

Your two live workflows keep doing what they do today. You add three small
pieces to each, and import one new workflow.

```
Customer ──► n8n agent workflow ──► AI replies            (no human on this customer)
                   │
                   ├─ every message ─► POST /api/ingest/message ─► desk answers human_active
                   │                    true  → the AI stays silent (a person has it)
                   │                    false → the AI answers as today
                   │
                   └─ AI decides "a person should take this"
                        ─► tool handoff_to_human ─► POST /api/ingest/handoff
                                                    chat appears in an agent's queue

Agent replies in the dashboard ─► desk ─► "2B — Desk Outbound Sender" (n8n)
                                            ├─ WhatsApp  → Evolution API
                                            └─ FB / IG   → Graph API
```

Everything below is done in the n8n editor. Allow about 45 minutes.

> **Before you start:** deploy the desk first ([DEPLOY.md](DEPLOY.md)) so you have
> its address (called `https://YOUR-DESK-ADDRESS` below) and its
> `DESK_INGEST_SECRET`.

---

## Step 1 — Two credentials (5 min)

n8n → **Credentials → Add credential → Header Auth**, twice:

| Credential name | Header name | Value |
|---|---|---|
| `2B Desk ingest (X-Desk-Secret)` | `X-Desk-Secret` | the desk's `DESK_INGEST_SECRET` |
| `2B Desk → n8n (X-Desk-Secret)` | `X-Desk-Secret` | the desk's `N8N_SEND_SECRET` (another long random string) |

While you are here, check you have a **Header Auth** credential for the
Evolution API (`apikey` header). Your WhatsApp workflow currently types the
Evolution key directly into four HTTP nodes; a credential keeps it out of
exports and screenshots. The new sender workflow uses a credential.

## Step 2 — Import the sender (10 min)

1. **Workflows → Import from file** → `n8n/desk-outbound-sender.json`.
2. Open **Code: CONFIG** and fill in the five values. They are the same ones
   your agents already use:
   - `EVO_BASE_URL` and `EVO_INSTANCE` — from **HTTP: Send Text** in
     *2B — WhatsApp AI Sales Agent* (the URL is `EVO_BASE_URL/message/sendText/EVO_INSTANCE`).
   - `GRAPH_VERSION`, `FB_PAGE_ID`, `IG_USER_ID`, `IG_SEND_VIA_PAGE_ID` — from
     **Code: CONFIG** in *2B — Meta Comments & DM Agent*.
3. Pick credentials on the four marked nodes:
   - **Webhook: Desk Reply** → `2B Desk → n8n (X-Desk-Secret)`
   - **HTTP: Send WhatsApp** → your Evolution API key credential
   - **HTTP: Send Messenger / Instagram** → the page-token credential your Meta
     agent's **HTTP: Send DM** uses
   - **Postgres: Remember for the AI** → your 2B Postgres credential
4. **Activate** the workflow. Open the webhook node, copy the **Production URL**
   (ends in `/webhook/desk-send`) and put it in the desk's `N8N_SEND_URL`.
   Restart the desk.

`Postgres: Remember for the AI` writes the human's reply into the agent's
history (`agent.fn_log_outbound`), so when a chat is resolved and the AI takes
the customer back, it knows what your colleague said. If that function ever
changes signature the node simply logs an error; delivery is not affected.

## Step 3 — WhatsApp agent (15 min)

Open **2B — WhatsApp AI Sales Agent**. Make a copy first (⋯ → Duplicate) so you
can roll back in one click.

### 3a. Mirror every message to the desk

1. Open `n8n/whatsapp-agent-additions.json` in a text editor, select all, copy.
2. Click on an empty part of the canvas and paste (Ctrl/Cmd + V). Three nodes
   appear: **HTTP: Desk Mirror**, **Code: Desk Gate**, **handoff_to_human**.
3. In **HTTP: Desk Mirror** and **handoff_to_human**, replace
   `https://YOUR-DESK-ADDRESS` with your desk address, and choose the
   credential `2B Desk ingest (X-Desk-Secret)`.
4. Rewire:

| Before | After |
|---|---|
| Postgres: Upsert Customer → IF: Human Handoff? | Postgres: Upsert Customer → **HTTP: Desk Mirror** → **Code: Desk Gate** → IF: Human Handoff? |
| Postgres: Upsert Customer → HTTP: Typing Indicator | **IF: Human Handoff? (false)** → HTTP: Typing Indicator |

The second change stops the AI's "typing…" indicator from showing while one of
your colleagues has the customer.

**Code: Desk Gate** copies the customer row and sets `handoff = true` while a
person has this customer, so **IF: Human Handoff?** works unchanged. If the desk
is unreachable, the mirror fails softly and the AI keeps answering — customers
are never left in silence because of the desk.

### 3b. Give the AI the hand-over tool

1. Connect **handoff_to_human** to the **AI Agent** node's *Tool* input (drag
   from the tool's top connector to the agent).
2. Disconnect **request_sales_handoff** from the agent (keep the node for now in
   case you want to switch back). Its job — telling a sales rep on WhatsApp —
   is now done by the desk, for sales *and* complaints and follow-ups.
3. The chain after the agent (**Postgres: Pending Handoff → IF: Notify Rep? →
   HTTP: Notify Sales Rep**) then does nothing; leave it or delete it.

### 3c. Update the AI's instructions

In the **AI Agent** node → *System Message*:

- In `# SAFETY / HONESTY FLOOR`, the line *"Existing orders, refunds,
  complaints, broken devices -> hand off warmly and stop selling."* now has a
  real hand-off behind it. Leave it.
- Replace the whole `# CLOSING — WHEN THEY SAY THEY WILL BUY` section (from that
  heading down to *"…leave it there."*) with the block in
  [Step 5](#step-5--the-prompt-block).

## Step 4 — Meta agent (Facebook + Instagram) (10 min)

Open **2B — Meta Comments & DM Agent (FB + IG)**, duplicate it first, then:

1. Paste `n8n/meta-agent-additions.json` the same way and set the address and
   credential on **HTTP: Desk Mirror** and **handoff_to_human**.
2. Rewire: **Postgres: Upsert Customer → HTTP: Desk Mirror → Code: Desk Gate →
   IF: Human Handoff?** (instead of Upsert → IF directly).
3. Connect **handoff_to_human** to the **AI Agent** as a tool; disconnect
   **request_sales_handoff**.
4. In the system message, replace the `# CLOSING` section with the block below.

**Good news for Messenger and Instagram:** the old flow had to ask these
customers for a WhatsApp number, because the sales rep worked on WhatsApp. Your
agents now answer them in the same Messenger or Instagram thread, so that step
— and the customers it lost — is gone.

Comments: when someone comments on a post, the AI still sends the public and
private replies as today. If that customer already has an open chat with your
team, the comment text is added to the chat (shown as *💬 Comment on a post*)
and the AI stays quiet.

## Step 5 — The prompt block

Paste this in place of the `# CLOSING` section in both agents. Adjust the
opening hours line to 2B's real hours.

```text
# HANDING OVER TO A COLLEAGUE
You have the tool handoff_to_human(category, summary). A real colleague from the
2B team then continues this same chat. Call it, then STOP:

- complaint: something arrived broken, late or wrong; double charge; refund;
  rude delivery; or the customer is clearly upset. Hand over IMMEDIATELY —
  do not troubleshoot, do not sell.
- followup: they ask about an EXISTING order, delivery, replacement or refund.
  If they have not given the order number, ask for it once, then hand over.
- sales: they clearly commit to buying ("هاخده", "عايز اشتريه", "احجزهولي",
  "ابعتلي اللينك وهشتري", "ينفع اجي الفرع اشتريه"). Call get_product_link first
  and put the link on its own line in your reply, then hand over.
  NOT for "بكام", "بفكر", "ايه رأيك" — keep helping them yourself.
- inquiry: they ask for a person / employee / customer service, or you could
  not answer the same question after two tries.

summary = 1 to 3 short Arabic lines for your colleague: what they want, the order
number or product, budget, and their mood.

On Messenger / Instagram: never ask for a phone number to hand over.
If CHANNEL says "first private reply after their comment", answer the comment
first; hand over only once you are in a real DM conversation.

What to tell the customer, from the tool's answer:
- assigned = true          → one warm line: a colleague (زميلي) is with them now.
- assigned = false and agents_ready > 0
                           → a colleague will reply within a few minutes.
- agents_ready = 0         → the team answers from 10:00 to 22:00 [EDIT]; they
                             will get a reply as soon as the team is back.
Then stop. No new question, no upsell. While a colleague has the chat you will
not be called at all.

NEVER mention tools, systems, queues, dashboards or "handoff". From the
customer's side a colleague is simply taking over.
```

## Step 6 — Test before switching on for everyone (10 min)

With the desk running and you signed in as an agent (status **Ready**):

1. From your own phone, WhatsApp 2B and complain: *"الأوردر وصل مكسور"*.
   - The AI answers once (warm line) and the chat appears in your queue with a
     sound, category **Complaint**, the AI's note on top.
2. Write again from your phone. The message appears in the desk; the AI says
   nothing.
3. Reply from the desk. Your phone receives it on WhatsApp; the desk shows ✓.
4. Press **Resolve**. Write again from your phone: the AI answers again, and
   knows what your colleague said.
5. Repeat 1–3 from an Instagram account and from Messenger.
6. In n8n → **Executions**, the sender workflow shows one green run per reply.

If a reply shows **Not delivered** in the desk, hover it to see why (the n8n
error text is passed through), fix it, and press **Retry**.

---

## Reference — what the desk accepts

All requests need the header `X-Desk-Secret: <DESK_INGEST_SECRET>`.

`POST /api/ingest/message` — every inbound customer message.

```json
{ "channel": "whatsapp | messenger | instagram",
  "external_id": "201001234567@s.whatsapp.net  (or the PSID / IGSID)",
  "customer_ref": "agent.customers id, as text",
  "customer_name": "optional", "phone": "optional",
  "text": "the message", "external_message_id": "for de-duplication",
  "kind": "dm | comment" }
```
Answer: `{ "ok": true, "human_active": true, "conversation_id": 812 }` or
`{ "ok": true, "human_active": false }`.

`POST /api/ingest/handoff` — the AI hands a customer over.

```json
{ "channel": "...", "external_id": "...", "customer_ref": "...",
  "customer_name": "...", "phone": "...",
  "category": "sales | complaint | followup | inquiry",
  "summary": "note for the agent",
  "history": [ { "role": "customer | assistant", "text": "...", "at": "2026-10-11T09:12:00Z" } ] }
```
Answer: `{ "ok": true, "human_active": true, "conversation_id": 812,
"created": true, "assigned": true, "agents_ready": 14, "queue_position": 0 }`.

`GET /api/ingest/ping` — check the address and secret are right.

The desk calls `N8N_SEND_URL` with header `X-Desk-Secret: <N8N_SEND_SECRET>`:

```json
{ "message_id": 5512, "conversation_id": 812, "channel": "whatsapp",
  "external_id": "201001234567@s.whatsapp.net", "phone": "201001234567",
  "customer_ref": "9001", "customer_name": "Mostafa", "text": "...",
  "agent": { "id": 14, "name": "Nour Ali", "employee_id": "2B-006" } }
```
and expects `{ "ok": true, "external_message_id": "..." }` or
`{ "ok": false, "error": "why" }`.

## Known limits (next steps)

- **Voice notes and images** from a customer who is with a colleague: the
  WhatsApp workflow drops non-text messages before they reach the desk
  (`IF: Should Process?`). Forwarding them is the natural next addition.
- **Meta's 24-hour window**: Messenger / Instagram replies must go out within
  24 hours of the customer's last message. With Meta's *Human Agent* permission
  approved for your app, set `USE_HUMAN_AGENT_TAG: true` in the sender's CONFIG
  to get 7 days.
- **Message length**: the desk enforces each channel's limit (Instagram 1,000,
  Messenger 2,000 characters) and tells the agent to split longer replies.
