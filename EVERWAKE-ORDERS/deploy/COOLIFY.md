# The n8n server on Coolify — Phase 1

n8n (with its Postgres) and Evolution already run on the KVM 1 as Coolify
resources. Phase 1 keeps it that way and makes it hard to crash: nothing is
moved, no WhatsApp number has to scan a QR again. (The plain-Docker setup in
[README.md](README.md) is for a server without Coolify.)

Already done: **4 GB swap**.

Why the server fell over before, most likely: Coolify itself (~1 GB with its
database, Redis and proxy), Evolution, and n8n saving every run's history all
share 4 GB, with nothing capping any of them. One busy moment and the whole box
stops. Every step below removes one of those risks.

---

## 1. Back up first (n8n's database)

Coolify → the n8n resource → its **Postgres** → **Backups** → *Backup now*, then
add a **daily schedule** (e.g. `30 1 * * *` = 3:30 Cairo time).
Better: Coolify → **S3 Storages** → add one (Cloudflare R2, Backblaze B2 or AWS
have free/cheap tiers) and tick it on the backup, so copies live off the server.
Also download the workflows once: n8n → each workflow → ⋯ → *Download*.

**Why:** n8n's database holds every workflow and credential (Seagull's too). The
restaurants' data is safe in Supabase; this is not. A backup on the same disk
doesn't survive losing the server — hence S3.

## 2. Stop n8n keeping every run

Coolify → n8n resource → **Environment Variables** → add, then **Redeploy**:

```
EXECUTIONS_DATA_SAVE_ON_SUCCESS=none
EXECUTIONS_DATA_SAVE_ON_ERROR=all
EXECUTIONS_DATA_SAVE_ON_PROGRESS=false
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=72
EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000
EXECUTIONS_TIMEOUT=600
N8N_CONCURRENCY_PRODUCTION_LIMIT=10
GENERIC_TIMEZONE=Africa/Cairo
```

**Why each:**
- *SAVE_ON_SUCCESS=none, PRUNE, MAX_AGE=72*: every customer message is a run; saving
  them all fills the disk and slows n8n's database — the most common way an n8n
  server dies. Failed runs are still kept 3 days, for debugging.
- *EXECUTIONS_TIMEOUT=600*: a run stuck for 10 minutes is stopped (a normal turn
  takes 10–40 seconds) instead of holding memory forever.
- *N8N_CONCURRENCY_PRODUCTION_LIMIT=10*: at most 10 conversations at the same moment;
  more wait their turn. A Friday peak makes replies a few seconds slower instead of
  taking the server down. (Tool calls inside a conversation don't count.)

## 3. Cap each resource's memory

For **n8n**, **Evolution** and their databases: Coolify → the resource →
**Edit Compose File**, and under each service add a `mem_limit`, then **Save** and
**Redeploy**. Suggested on 4 GB:

| Service | `mem_limit` |
|---|---|
| n8n | `1800m` |
| n8n's Postgres | `512m` |
| Evolution API | `900m` |
| Evolution's Postgres / Redis | `384m` / `192m` |

For n8n also add the environment variable `NODE_OPTIONS=--max-old-space-size=1400`.

**Why:** without a cap, one service that grows (Evolution with many numbers, n8n on a
big peak) takes memory from everything else, Coolify included, and the whole server
freezes. With caps, only that one container restarts — by itself — and the rest keep
running. n8n's heap limit sits under its cap so n8n cleans up before Docker has to
kill it.

## 4. Let Coolify keep the disk clean and tell you

- Coolify → **Servers** → your server → **Configuration/Advanced** → **Docker
  cleanup**: on, threshold **80%**.
- Coolify → **Notifications** → connect e-mail or Telegram; turn on server disk usage,
  backup failures and deployment failures.

**Why:** old images and build leftovers pile up with every redeploy; Coolify removes
them before the disk fills. And you hear about a full disk or a failed backup before
a restaurant notices.

## 5. Be told when n8n is down

[UptimeRobot](https://uptimerobot.com) (free) → HTTP monitor on
`https://<your n8n address>/healthz/readiness`, every 5 minutes.

**Why:** Coolify's notifications cover the server; this checks from the outside that
n8n actually answers and reaches its database — what the restaurants depend on.

## 6. Lock the doors

- n8n → *Settings → Personal* → **two-factor authentication** on.
- Coolify → your profile → **two-factor authentication** on.
- Hostinger, Supabase, Vercel, GitHub: two-factor on.
- SSH: log in with a key, not a password (Hostinger panel → SSH keys).

**Why:** Coolify and n8n are both on the internet and both can read every credential;
a password alone is the weakest link.

## 7. Pin n8n's version

Coolify → n8n resource → Edit Compose File: change the image from `…/n8n:latest` (or
`:stable`) to the exact version running now (n8n → *Help → About n8n*), e.g.
`docker.n8n.io/n8nio/n8n:2.45.3`.

**Why:** with `latest`, a redeploy can quietly install a new n8n that changes how a node
behaves. Pinned, you update when you choose, after a backup and a test order.

---

## How to check it's healthy

Over SSH:
```sh
free -h && df -h / && docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"
```
Healthy: RAM under ~75% at the dinner peak, swap barely used, disk under 80%, every
container well under its cap.

## When to grow (Phase 2)

When at the peak RAM stays above ~75%, swap is in steady use, or replies take more
than ~30 seconds:
1. **Upgrade the plan** in hPanel to KVM 2 (same server, same data, Coolify included),
   then raise the caps above and `N8N_CONCURRENCY_PRODUCTION_LIMIT` to 20.
2. On **KVM 4**: switch n8n to queue mode — Coolify has an *n8n with PostgreSQL and
   Worker* service; workers take the conversations through Redis, and more workers are
   added as you grow.
3. When moving to the **WhatsApp Cloud API**, Evolution goes away and frees its memory.
