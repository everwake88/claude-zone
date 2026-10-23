# The n8n server — Phase 1 (Hostinger KVM 1)

> **Running n8n through Coolify?** Follow [COOLIFY.md](COOLIFY.md) instead — it keeps
> Coolify and everything on it, and hardens it in place. This guide is for a server
> without Coolify.

```
WhatsApp ── Evolution (where it runs today) ──▶ n8n.everwake.tech ── this server (KVM 1)
                                                   │  caddy  → https, certificates
                                                   │  n8n    → the agent's engine
                                                   │  n8n-db → n8n's own workflows & credentials
                                                   ▼
                       Supabase (the restaurants' data)  ·  OpenAI  ·  Paymob
Dashboard: Vercel  ──── pings n8n's outbox, asks nothing else of this server
```

**Why this split.** This server only runs n8n. The restaurants' data stays in
Supabase (backed up, maintained by them), and the dashboard stays on Vercel, so if
this server has a bad moment the order board and inbox keep working. Evolution is
kept off this server: it is heavy, and it goes away when we move to the Cloud API.

**What it holds.** On KVM 1, about 2–3 busy restaurants (100 orders a day each) or
~8 small ones, with replies queuing rather than failing at a peak. Idle it uses
about 450 MB of its 4 GB. `scripts/check.sh` says when it is time to grow
(see [When to upgrade](#when-to-upgrade--phase-2)).

Everything here was started and tested before you got it: https through Caddy,
the five Everwake workflows importing into n8n, backup and restore, and the
Phase 2 queue mode with a worker.

---

## What you need first

- The Hostinger VPS (KVM 1) and its root password or SSH key
- Access to the DNS of `everwake.tech` (wherever the domain is managed)
- The **version of your current n8n**: open it → *Help → About n8n*
- For n8n's three credentials (as in [SETUP.md §3](../docs/SETUP.md)): the Supabase
  database connection (Session pooler), the OpenAI key, and the outbox secret
  (the same value as `N8N_OUTBOX_SECRET` on Vercel)
- An SSH key on your computer (`ssh-keygen -t ed25519` if you have none)

---

## 1. Start from a clean server

hPanel → VPS → **OS & Panel → Operating system → Ubuntu 24.04** (plain, no panel).
Add your SSH key when it asks.

**Why:** the server crashed before and may hold leftovers you can't see. A fresh
Ubuntu 24.04 LTS (supported until 2029) is a known state, and the key means you
never type the root password over the internet.
⚠️ Reinstalling wipes the server — copy off anything you still need first.

## 2. Point a name at it

At your DNS: an **A record** `n8n` → the server's IP (TTL 300 is fine).

**Why:** Caddy needs the name to get the https certificate, and everything else
(Evolution, the dashboard) points at `n8n.everwake.tech`, not an IP — if you ever
change servers you change one record, not every restaurant.

## 3. Prepare the server

From your computer (with the repo cloned, or downloaded from GitHub → *Code → Download ZIP*):
```sh
scp -r EVERWAKE-ORDERS/deploy root@<server-ip>:/root/deploy
ssh -t root@<server-ip> "bash /root/deploy/scripts/setup-server.sh"
```
It asks once for a password for the `everwake` user (used for `sudo`).

**Why each part** (the script says it too):

| Step | Why |
|---|---|
| Updates + automatic security updates | most break-ins use holes that already have a fix; nightly patches fix them without you |
| 4 GB swap | a short memory spike slows the server down instead of killing processes |
| Firewall: only 22, 80, 443 | n8n and its database are never reachable from outside, only through Caddy |
| fail2ban | bots that keep failing to log in get banned |
| Docker with capped logs | each service in its own box with a memory cap; logs can't fill the disk (a classic crash) |
| `everwake` user | you work as a normal user, not root |

## 4. Lock SSH to keys only

In a **new** terminal: `ssh everwake@<server-ip>` — if it works:
```sh
sudo bash /root/deploy/scripts/setup-server.sh --lock-ssh
```

**Why:** with passwords off and root login off, the endless password-guessing
bots have nothing to guess. It is a separate step so you can't lock yourself out:
it refuses unless the key login is already set up.

## 5. Put the files in place

```sh
sudo cp -r /root/deploy/. /opt/everwake/ && sudo chown -R everwake: /opt/everwake
cd /opt/everwake && ./scripts/make-env.sh && nano .env
```
In `.env` set `N8N_HOST=n8n.everwake.tech`, `ACME_EMAIL=` your e-mail, and
`N8N_VERSION=` **the version your current n8n runs**.

**Why:**
- `make-env.sh` creates long random secrets (n8n's encryption key, the database and
  Redis passwords) and makes `.env` readable only by you.
- The **same n8n version** as today means the workflows behave exactly as they do
  now. Upgrading is a separate, deliberate step (see [Updating n8n](#updating-n8n)).
- **Copy the finished `.env` into your password manager now.** The encryption key
  is what makes n8n's saved credentials readable; lose it with the server and they
  must all be re-entered.

## 6. Start it

```sh
docker compose up -d
./scripts/check.sh
```
`check.sh` should end with "All good" within a minute or two (the first start
downloads ~2 GB and creates n8n's tables).

**Why:** `up -d` starts Caddy, n8n and its database, each with a memory cap and
"restart if it stops". Caddy gets the https certificate by itself on the first
visit.

## 7. Secure n8n's editor

Open `https://n8n.everwake.tech`, create the owner account, then
*Settings → Personal → Two-factor authentication* → turn it on.

**Why:** the editor is on the internet (the webhooks must be). Whoever gets into
it can read every workflow and use the credentials, so it gets a strong password
and a second factor.

## 8. Credentials and workflows

Follow [SETUP.md §3](../docs/SETUP.md) on this n8n: create the three credentials
(*Everwake DB*, *OpenAI*, *Everwake Outbox Secret*), import the five workflows
from `engine/dist/`, set the three tool nodes and *Create Payment Link*, and
**don't activate yet**.

**Why fresh credentials, not copied from the old n8n:** credentials are encrypted
with each n8n's own key; recreating three of them is quicker and cleaner than
moving them between servers.

## 9. Switch over (no downtime)

1. Activate *Main* and *Outbox* on the new n8n.
2. Vercel → the dashboard → Settings → Environment Variables:
   `N8N_BASE_URL=https://n8n.everwake.tech` → **Redeploy**.
3. For each restaurant: dashboard → Settings → WhatsApp → **Set the webhook for me**.
4. Send a test order from a test number.
5. On the **old** n8n, *deactivate* (don't delete) the Everwake workflows.

**Why in this order:** the new n8n is fully ready before any message goes to it;
each restaurant moves the moment its webhook changes; the old workflows stay for a
week as a fallback (reactivate + set the webhook back). Deactivating them stops
two outbox loops running at once.

## 10. Nightly backups

```sh
crontab -e
# add:
30 3 * * * /opt/everwake/scripts/backup.sh >> /opt/everwake/backups/cron.log 2>&1
```
Try a restore once, so you know it works: `./scripts/restore.sh backups/<file>`.

**Why:** n8n's database holds the workflows and credentials. Supabase backs up the
restaurants' data, not this. 3:30 Cairo time is the quietest hour.
**Off the server too:** a backup on the same disk doesn't survive losing the
server. Either set `BACKUP_REMOTE` (an [rclone](https://rclone.org) remote, e.g.
Google Drive) in `.env`, or download `backups/` now and then — and take a Hostinger
snapshot (hPanel → VPS → Snapshots) before any big change.

## 11. Be told when it's down

[UptimeRobot](https://uptimerobot.com) (free) → new HTTP monitor:
`https://n8n.everwake.tech/healthz/readiness`, every 5 minutes, alerts to your
phone/e-mail.

**Why:** you hear about a problem before a restaurant does. `/healthz/readiness`
also checks that n8n reaches its database, not just that the server is on.

---

## Everyday

| Task | Command |
|---|---|
| How is it doing? | `./scripts/check.sh` |
| Logs | `docker compose logs -f n8n` |
| Restart n8n | `docker compose restart n8n` |
| Back up now | `./scripts/backup.sh` |
| Put a backup back | `./scripts/restore.sh backups/n8n-….sql.gz` |

### Updating n8n
```sh
./scripts/backup.sh
nano .env            # N8N_VERSION=<new version>
docker compose pull && docker compose up -d
./scripts/check.sh   # then send a test order
```
**Why pinned versions, never "latest":** an n8n update can change how nodes
behave; you update when you choose, after reading its release notes, with a backup
from minutes before. To go back: set the old version and `up -d` (restore the
backup if the new version changed the database).

---

## When to upgrade → Phase 2

`check.sh` warns when RAM goes over 80% or swap is in use. Upgrade when, at the
dinner peak, any of these happens: RAM > 75%, CPU above ~70% for minutes at a
time, or replies taking more than ~30 seconds.

1. hPanel → upgrade the plan to **KVM 2**, later **KVM 4** (same server, same data).
2. In `.env`: raise `N8N_CONCURRENCY` (KVM 2: 20) and `N8N_MEM_LIMIT` / `N8N_HEAP_MB`
   (KVM 2: `4g` / `3072`).
3. On KVM 4, switch on **queue mode** — one setting, two more containers:
   ```sh
   # .env: EXECUTIONS_MODE=queue
   docker compose --profile queue up -d
   ```
   n8n then takes the messages and hands them to a worker through Redis; more
   workers (or a second server running only workers) are added the same way.

---

## If something goes wrong

| Symptom | Look at |
|---|---|
| `https://n8n…` doesn't open | DNS A record points at this server? `docker compose logs caddy` (certificate) |
| n8n keeps restarting | `docker compose logs --tail 100 n8n` — often a wrong value in `.env` |
| The agent stopped answering | is *Main* active? the restaurant's webhook (Settings → WhatsApp → Check connection)? `check.sh` |
| Status messages are slow | is *Outbox* active? is `N8N_BASE_URL` on Vercel this server? |
| Disk full | `docker system prune -f`, then `du -sh backups` |
