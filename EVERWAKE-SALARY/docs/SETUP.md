# Setting up Everwake Salary

Four pieces: the database on your server, the dashboard on Vercel, the workflow
in n8n, and the WhatsApp line in Evolution. About an hour the first time.

## 1. The database (your PostgreSQL server)

PostgreSQL 13 or newer; nothing else to install (no extensions).

1. Create a database and a user for it, e.g. `everwake` and `everwake_salary`.
2. Build the tables and functions (safe to run again after every update):

   ```sh
   DATABASE_URL=postgres://everwake_salary:PASSWORD@db.example.com:5432/everwake ./database/migrate.sh
   ```
3. Let Vercel and n8n reach it: open port 5432 to them (Vercel's addresses change,
   so use TLS and a strong password, or put the database behind a pooler such as
   PgBouncer). TLS is recommended; see `DATABASE_SSL` below.
4. Create the first HR admin from your own machine (it asks for the password):

   ```sh
   cd dashboard && npm install
   DATABASE_URL=postgres://… npm run create-user -- hr@company.com "Mona Ibrahim" admin
   ```
   More people can be added later from Settings → HR team.

Never load `database/seed/demo.sql` in production: it is demo data for testing.

## 2. The dashboard (Vercel)

1. In Vercel: **Add New → Project**, import this repository, and set
   **Root Directory** to `EVERWAKE-SALARY/dashboard`. The framework is detected
   (Next.js); leave the build command as it is.
2. Environment variables (Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | `postgres://everwake_salary:PASSWORD@db.example.com:5432/everwake` |
   | `DATABASE_SSL` | `require` (TLS with a valid certificate) · `no-verify` (TLS with a self-signed certificate) · `disable` (no TLS — only on a private network) |
   | `SESSION_SECRET` | 64 random characters: `openssl rand -hex 32` |
   | `N8N_BASE_URL` | your n8n address, e.g. `https://n8n.company.com` (used to show the webhook URL) |
3. Deploy, open the address, and sign in with the admin from step 1.4.
4. **Settings → Company**: the company name, the agent's name (it introduces itself
   with it), and how employees reach HR.
5. **Identity check**: tick what the agent asks for. The default is the full name,
   the national ID and the work ID, with the WhatsApp number matched to the payroll row.
   When WhatsApp hides an employee's number, the agent asks for their mobile number
   and matches that instead (untick "If WhatsApp hides their number…" to send them to
   HR). Switch the match off to skip the number check altogether.
6. **Payroll sheets → Upload a month**: upload this month's Excel, check the columns
   on the review page (which column is the name, the national ID, the work ID, the
   phone; which columns employees may see), fix any rows it flags, and **Publish**.

## 3. The workflow (n8n)

1. Build it (or use the committed `engine/dist/everwake-salary-main.json`):

   ```sh
   cd engine && npm install && npm run build
   ```
   Options: `SAL_MODEL` (default `gpt-6-luna`), `SAL_EFFORT` (default `low`),
   `SAL_VISION_MODEL`, `SAL_TRANSCRIBE_MODEL` (default `gpt-transcribe`),
   `SAL_WAIT_SECONDS` (how long to wait for a second message before answering; default 4).
2. In n8n: **Workflows → Import from file** → `dist/everwake-salary-main.json`.
3. Create a **Postgres** credential for the same database (host, database, user,
   password, SSL as above) and pick it on every Postgres node.
4. Pick your **OpenAI** credential on *Agent Call (OpenAI)*, *Transcribe Voice Note
   (OpenAI)* and *Look At Photo (OpenAI)*.
5. **Activate** the workflow.

## 4. The WhatsApp line (Evolution API)

1. In Evolution, create (or reuse) an instance and connect the company's HR number.
2. Dashboard → **Settings → WhatsApp**: the Evolution address, the instance name and
   the API key. Save.
3. Copy **Webhook to paste into Evolution** from the same page. In Evolution → the
   instance → Webhook: paste it, enable the event **MESSAGES_UPSERT**, and switch
   **Webhook base64** on (voice notes and photos then arrive with the message).
4. Send "مرتبي" to the HR number from a phone that is on the payroll sheet. The
   agent asks for the details one or two at a time, checks them, and answers.

## Moving to the WhatsApp Cloud API later

Only three places know the provider: the *Normalize Inbound* node and the three
*Evolution —* HTTP nodes in the workflow, and `dashboard/src/lib/whatsapp.ts`
(HR replies). The database already stores the provider (`salary.channel.provider`,
`phone_number_id`); add a Cloud API branch in those places and switch the
connection in Settings.

## Day to day

- **Each month**: upload and publish the new sheet. The overview's payroll year shows
  which months are on file; the current month is outlined until it is uploaded.
- **Disputes**: answer them from Disputes. The agent tells the employee their ticket
  number; your WhatsApp reply reaches them from the company number.
- **Switching the agent off** (Settings → Company): messages are still kept, and
  nobody gets an answer until it is on again.
- **Changing how the agent talks** (Agent instructions): edit the instructions text
  and save, or add a word rule ("don't say راتب, say مرتب"; "never say تم بنجاح").
  Both apply from the next message, with nothing to change in n8n. Every save is
  kept under Versions, and "Use this version" brings an older one back. The privacy
  rules do not depend on this text: they are enforced in the database.
