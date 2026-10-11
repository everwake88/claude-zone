# Vercel? n8n? — the answers, and how 2B Desk is built

## 1. Is Vercel's free plan OK?

**Not for this project — on two counts.**

**The rules.** Vercel's free *Hobby* plan is for personal, non-commercial use
only. Vercel's fair-use guidelines define commercial use as any deployment used
for the financial gain of anyone involved — including a paid consultant writing
the code. A support dashboard built for 2B, a commercial client, is commercial
use. That needs **Vercel Pro (about $20 per team member per month)**.

**The technology.** Even on Pro, Vercel runs short-lived serverless functions.
This dashboard needs a process that is always on:

- a WebSocket to every open dashboard, so chats, reminders and transfer
  requests appear the instant they happen;
- an engine that wakes every 5 seconds to send reminders, move unanswered
  chats at 10 minutes, hop them every minute and flag them late at 15;
- heartbeats that notice within 90 seconds that an agent's laptop closed.

Vercel functions stop after a maximum duration of a few minutes, so they cannot
keep a connection open for a whole shift or run a background loop. (Vercel has
a WebSocket beta, but those connections are still bound by the same duration
limit, and Vercel itself points to third-party realtime services.) The backend
would have to live somewhere else anyway.

**What to do instead.** Run the 2B Desk server on the VPS that already runs your
n8n, Evolution API and Postgres (it looks like Coolify). The same server also
serves the dashboard page, so it is **one service, one address, $0 extra**.

If you still want the page itself on a CDN, the `web/` folder is plain static
files and can go anywhere:

| Host for the page | Cost for 2B | Notes |
|---|---|---|
| **Served by the desk server (recommended)** | $0 | One address, nothing to configure |
| Cloudflare Pages | $0 (commercial use allowed) | You already use Cloudflare for everwake.tech |
| Vercel Pro | ~$20 / member / month | Hobby is not allowed for client work |

For either CDN option set `apiUrl` in `web/config.js` to the desk server's
address, and add the page's address to the server's `CORS_ORIGINS`.

## 2. Is n8n OK as the backend?

**Keep n8n — for what it is great at. Don't make it the dashboard's backend.**

n8n is the right home for the parts it already does well: receiving WhatsApp
(Evolution API), Messenger and Instagram webhooks, running the AI agent, and
calling the channel APIs. 2B Desk keeps all of that in n8n — including every
channel credential.

It is the wrong place for the dashboard's own logic:

| What the dashboard needs | With n8n as the backend | With 2B Desk |
|---|---|---|
| New chats and reminders the moment they happen | n8n webhooks can't push, so 30 dashboards poll every few seconds: tens of thousands of executions a day | One WebSocket per dashboard, pushed instantly |
| Never more than 25 chats per agent, even when chats arrive at the same second | Hand-rolled locking across parallel executions | Every routing decision runs in one locked database transaction |
| A clock that moves chats at 10 min and every minute after | A schedule trigger firing every few seconds, each run a full execution | A 5-second loop inside the server |
| Logins, passwords, sessions, check-in/out | DIY password hashing and tokens in Code nodes | Built in, tested |
| Not slowing down the AI that answers customers | Dashboard polling shares the same n8n workers as the customer-facing AI | Separate service; n8n load is unchanged |

The last row matters most: today your n8n answers 2B's customers. If 30
dashboards hammer the same instance, customers wait longer for the AI.

**Better than n8n alone:** a small dedicated service — the **2B Desk server**
(Node.js, two dependencies) — next to n8n, sharing the Postgres you already
have. n8n talks to it through three webhooks. That is what this folder is.

> About the screenshots: none came through with your message, so I could not
> see the dashboard you referred to. Instead I read your live n8n workflows
> (*2B — WhatsApp AI Sales Agent* and *2B — Meta Comments & DM Agent*) and built
> the integration around their real nodes, tables and hand-off logic.

## 3. The shape of it

```
                         ┌──────────────────────── your VPS (Coolify) ───────────────────────┐
WhatsApp ── Evolution ──►│  n8n                                                                │
Messenger ── Meta ──────►│   ├─ 2B WhatsApp AI agent ─┐   POST /api/ingest/message (every msg) │
Instagram ── Meta ──────►│   └─ 2B Meta AI agent ─────┼─► POST /api/ingest/handoff (tool)       │
                         │                            │                                         │
                         │   2B Desk Outbound Sender ◄┼── POST /webhook/desk-send (agent reply) │
                         │                            ▼                                         │
                         │   2B Desk server (Node) ── REST + WebSocket + routing/SLA engine    │
                         │        │                                                            │
                         │   Postgres ── schema "agent" (the AI)  +  schema "desk" (the team)  │
                         └────────┼────────────────────────────────────────────────────────────┘
                                  │ https + wss
                   30 dashboards in the browser (agents and supervisors)
```

- **One database.** The desk keeps its tables in a `desk` schema inside the
  Postgres the AI already uses, and never writes to the AI's `agent` schema.
- **Channel credentials stay in n8n.** The desk never sees the WhatsApp or
  Meta tokens.
- **Fails safe for customers.** If the desk is down, n8n's mirror call fails
  softly and the AI keeps answering. If n8n is down, the agent sees *Not
  delivered* with a Retry button, and the SLA clock keeps running honestly.

## 4. Will it hold 25–30 people, and later more?

Comfortably. The heaviest moment — 30 agents with 25 chats each, 750 open
chats — means 30 WebSocket connections and one engine pass every 5 seconds over
at most 750 rows. A container with 1 vCPU and 512 MB of RAM is plenty; the
database grows by a few megabytes a day. Adding agents is just adding users.

The one limit to know: run **one** copy of the desk server. (Two copies would
each push only to their own dashboards.) For a team of this size one copy has
a lot of headroom.

## 5. Decisions made for you — change any of them

| Topic | Default | Where to change |
|---|---|---|
| Max chats per agent | 25 (per-person override possible) | Settings, Team |
| Reply within | 15 minutes | Settings |
| First agent's time | 10 minutes, reminders at 5 and 8 | Settings |
| Hop to the next agent | every 1 minute | Settings |
| Who receives a hop | least busy Ready agent who hasn't had this chat yet | — |
| Not ready | keeps current chats, receives nothing new | — |
| Disconnected (90 s without a heartbeat) | waiting customers move on at once; answered chats stay | Settings |
| Checked out (logout, or offline 30 min) | every chat goes back to the team | Settings |
| A transfer request | the teammate has 60 s to accept; the chat stays with you meanwhile | Settings |
| Which chats reach people | complaints and order follow-ups at once; sales when the customer commits; inquiries only if they ask for a person | the AI prompt ([N8N.md](N8N.md)) |
| Who sees "Track" (busy / idle) | supervisors and admins | — |
| Every person | starts Not ready at check-in | — |

**One to reconsider:** a 1-minute hop is tight. A colleague needs a moment to
read a chat that just landed on them; in tests with simulated agents, a
1-minute window made some chats bounce between people before anyone replied.
2 minutes is a kinder default — it is one number in Settings.

**Outside working hours** nobody is Ready, so a hand-off waits until the morning
and will count as late. The AI is told when nobody is on shift
(`agents_ready = 0`) so it can say when the team is back; tell it 2B's hours in
the prompt.
