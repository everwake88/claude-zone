# 2B Desk

The human side of 2B's AI agent. When the AI on **WhatsApp, Messenger or
Instagram** decides a person should take over — a complaint, an order
follow-up, a customer ready to buy — the chat lands in **2B Desk**. Agents
reply from there, chats are shared fairly, and no customer waits more than
15 minutes without somebody being alerted.

![The agent's inbox](docs/screenshots/agent-inbox.png)

## What it does

**For agents**
- Sign in (= **check-in**), press **Ready**, and chats arrive by themselves with
  a sound and a desktop alert. **Not ready** keeps your chats but sends nothing new.
- Timers for how long you have been Ready / Not ready, and your day in the menu.
- A queue that puts the most urgent chat on top, with the source (**WA / FB /
  IG**), the category (**Sales, Complaint, Follow-up, Inquiry**), how long each
  chat has been with you, and how many minutes are left before it is late.
- The full conversation — customer, the AI and the team — with the AI's
  hand-off note on top. Arabic and English both read naturally.
- **Team** drop-down: everyone's status and how full their queue is.
  **Transfer** asks a teammate to take a chat; they **Accept** or answer **No
  availability**.

**The rules** (all adjustable in Settings)
- Only signed-in, connected, Ready agents receive chats; least busy first;
  **never more than 25** per agent; the rest wait and go out oldest-first.
- Reminders at **5** and **8** minutes. No reply at **10** → the chat moves to
  the least busy teammate who hasn't had it, then on every **1** minute.
  At **15** it is **LATE** ("late by x min") and keeps moving until someone replies.

**For supervisors**
- **Live**: the whole floor — status, load, waiting customers, late chats.
- **Track** any chat: who received it, who it moved to, how many chats each
  person had, whether they were **busy** (replying elsewhere, typing) or **idle**.
- **Reports** for any day: chats handled; split by category and by WhatsApp /
  Messenger / Instagram; first-reply time; on-time rate; and per agent:
  check-in/out, Ready and Not ready time, chats, replies, late replies, chats
  taken away (busy vs idle) and typing activity. CSV export.
- **Team**: create the 25 accounts (username, password, staff ID), reset
  passwords, switch people off, change one person's limit.

| | |
|---|---|
| ![Transfer request](docs/screenshots/incoming-request.png) | ![Late chat](docs/screenshots/late-chat.png) |
| A teammate asks for help: Accept or No availability | 15 minutes passed: the chat is late and says by how much |
| ![Live board](docs/screenshots/live.png) | ![Chat journey](docs/screenshots/journey.png) |
| Live: the floor at a glance | Track: who had it, busy or idle |
| ![Reports](docs/screenshots/reports.png) | ![Settings](docs/screenshots/settings.png) |
| Reports for any day | The rules, in one place |

It also works on a phone (supervisors get a tab bar) and has a dark mode.

## Your questions, answered

- **Vercel free plan?** No: the Hobby plan is non-commercial only, and Vercel's
  functions can't run the always-on realtime engine anyway. Run the desk on
  the VPS that already runs n8n — $0 extra. Details and alternatives:
  [docs/DECISIONS.md](docs/DECISIONS.md).
- **n8n as the backend?** Keep n8n for the channels and the AI (it stays the
  only thing holding WhatsApp/Meta credentials), but not as the dashboard's
  backend: polling, timers and locking for 30 live dashboards would slow down
  the AI that answers your customers. The small 2B Desk server does that part.
  [docs/DECISIONS.md](docs/DECISIONS.md).

## How it fits

```
WhatsApp / Messenger / Instagram ─► n8n (AI agent) ─► 2B Desk server ─► dashboards (WebSocket)
                                       ▲                    │
                                       └── agent replies ───┘
                         Postgres: "agent" schema (AI)  +  "desk" schema (team)
```

## In this folder

```
server/           Node.js 20+ service: API, realtime, routing + SLA engine, reports
  src/desk.js       the rules: routing, 15-minute chain, transfers, presence
  src/reports.js    the day report and the busy / idle verdict
  migrations/       the "desk" schema
  test/             45 tests against a real Postgres
  scripts/          create / import users, demo data
web/              the dashboard — static files, no build step (Preact + htm, vendored)
n8n/              import-ready sender workflow + nodes to paste into your two agents
docs/             DECISIONS · DEPLOY · N8N · HOW-IT-WORKS
Dockerfile        one container: server + dashboard
docker-compose.yml  try it locally with its own Postgres
```

## Try it

```sh
cd 2b-desk/server
npm install
createdb desk_demo                  # any empty Postgres database
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/desk_demo
npm run demo:seed -- --yes-wipe     # the 2B team + two simulated days (~3 min)
DEMO_MODE=true npm start            # http://localhost:8080
```

Sign in with password `demo1234` as `nour.ali` (agent), `heba.farouk`
(supervisor) or `admin`. In demo mode 20 virtual colleagues keep working
around you. With Docker: see [docs/DEPLOY.md](docs/DEPLOY.md#trying-it-on-your-own-computer).

## Go live

1. [docs/DEPLOY.md](docs/DEPLOY.md) — run it on your Coolify VPS, add the team.
2. [docs/N8N.md](docs/N8N.md) — connect your two n8n agents and import the sender.
3. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — give this to supervisors and agents.

## Development

```sh
cd server
npm test        # needs Postgres; set TEST_DATABASE_URL (default: postgres://postgres:postgres@127.0.0.1:5432/desk_test)
```

The tests fast-forward a fake clock through the 15-minute chain, and run the
whole loop over real HTTP and WebSockets with a mock n8n.
