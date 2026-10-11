# Putting 2B Desk online

The plan: run the desk as one more app on the VPS that already runs n8n,
the Evolution API and Postgres (your service addresses look like Coolify's).
About 30 minutes.

```
Coolify project
├── n8n                (already there)
├── Evolution API      (already there)
├── Postgres           (already there — the 2B agent's database)
└── 2B Desk            ← new: this folder, built from its Dockerfile
```

---

## Step 1 — Create the app (10 min)

In Coolify: **+ New → Application → (your GitHub source) →
`everwake88/claude-zone`**.

| Field | Value |
|---|---|
| Branch | the branch holding this folder (merge it to `main` first if you like) |
| Build pack | **Dockerfile** |
| Base directory | `/2b-desk` |
| Dockerfile location | `/Dockerfile` |
| Ports exposes | `8080` |
| Domain | e.g. `https://desk.everwake.tech` or `https://desk.<2b-domain>` — or keep the generated sslip.io address to start |

Under **Advanced**, if the app cannot reach your Postgres by its internal name,
enable **Connect to predefined network** (it puts the app on the same Docker
network as the Postgres service).

## Step 2 — Environment variables (5 min)

In the app → **Environment Variables**:

| Name | Value |
|---|---|
| `DATABASE_URL` | the **internal** connection URL shown on your Postgres service page in Coolify (the same database the AI uses) |
| `DESK_INGEST_SECRET` | a long random string — on any Mac/Linux: `openssl rand -hex 24` |
| `N8N_SEND_SECRET` | another long random string |
| `N8N_SEND_URL` | leave empty for now (Step 5 of [N8N.md](N8N.md) gives it to you) |
| `ADMIN_USERNAME` | `admin` (or your own) |
| `ADMIN_PASSWORD` | a strong password, 8+ characters |
| `ADMIN_NAME` | your name |

Every setting is explained in `server/.env.example`.

While `N8N_SEND_URL` is empty the desk is in **demo mode**: replies are marked
as sent but do not reach customers. The server prints a warning at start-up.

## Step 3 — Deploy and sign in (5 min)

Click **Deploy**. When the health check is green:

1. Open the domain. Sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
2. Avatar menu → **Change password**.
3. In Coolify you can now blank `ADMIN_PASSWORD` (it is only used when the
   database has no users at all).

The first start creates the `desk` schema in your database. It never touches
the AI's `agent` schema.

## Step 4 — Add the team (10 min)

**One by one:** **Team → Add person**. Leave the password empty and the desk
generates one, shown once, ready to copy.

**All 25 at once:** fill a CSV like `server/scripts/agents-example.csv`
(`employee_id, full_name, username, role, max_chats`), then in Coolify open the
app's **Terminal** and run:

```sh
cd server
node scripts/import-users.js /path/to/agents.csv
```

It creates everyone it does not know yet and writes `credentials-<date>.csv`
with each first password. Hand them out, then delete that file. Running it
again with new rows only adds the new people.

Roles: **agent** answers chats; **supervisor** also sees Live, Reports and Team
and can manage agents; **admin** can also change Settings and manage
supervisors.

## Step 5 — Connect n8n

Follow [N8N.md](N8N.md). When the sender workflow is active, paste its URL into
`N8N_SEND_URL` and redeploy. Demo mode ends.

## Step 6 — First shift checklist

- [ ] Every agent signs in once and changes their password.
- [ ] Each agent clicks **Turn on** for desktop alerts (top banner), and keeps
      sounds on (avatar menu).
- [ ] Settings checked by an admin: 25 chats, 15 / 10 / 1 minutes, reminders 5 & 8.
- [ ] A supervisor keeps **Live** open on a second screen.
- [ ] End of the day: **Reports → Export agents (CSV)** if you want a file.

---

## Updating

Push to the branch; in Coolify press **Redeploy** (or turn on automatic
deploys). Database changes run by themselves at start-up. Agents' pages pick
up the new version on their next refresh; their session is kept.

## Backups

The desk lives in your existing Postgres, so it is covered by whatever backs
that up. If nothing does yet, turn on **Scheduled Backups** on the Postgres
service in Coolify — the AI's customer data is in the same database.

## Hosting the page somewhere else (optional)

The server serves the dashboard itself, which is the simplest setup. If you
prefer to host the `web/` folder on Cloudflare Pages or Vercel Pro
(see [DECISIONS.md](DECISIONS.md) — Vercel's free plan is not allowed for client
work):

1. Deploy `2b-desk/web` as a static site (no build command; output directory
   is the folder itself).
2. In `web/config.js` set `apiUrl` to the desk server address, e.g.
   `https://desk-api.example.com`.
3. On the server set `CORS_ORIGINS` to the static site address and redeploy.

## Trying it on your own computer

With Docker Desktop installed, from the `2b-desk` folder:

```sh
docker compose up -d
docker compose exec desk node server/scripts/demo-seed.js --yes-wipe
DEMO_MODE=true docker compose up -d
```

Open <http://localhost:8080> and sign in with password `demo1234` as
`nour.ali` (agent), `heba.farouk` (supervisor) or `admin`. The seed creates
the 25-person team and two simulated days; `DEMO_MODE=true` keeps 20 virtual
colleagues working live around you. Never run the seed against the real
database — it wipes the `desk` schema first.

Without Docker: install Node 20+ and Postgres, then in `server/`:
`npm install`, `DATABASE_URL=postgres://… npm run demo:seed -- --yes-wipe`,
`DATABASE_URL=postgres://… DEMO_MODE=true npm start`.
