# Everwake Salary

An HR assistant on WhatsApp. Employees ask about their salary — the net, every
allowance and deduction, their KPI and the incentive it earned, how this month
compares with last — and the agent answers in Egyptian Arabic. Before it says
anything about any salary, it collects the identity details HR chose (one or two
at a time), checks their formats, and finds the employee's exact row in the
payroll sheet HR uploaded. HR runs it from a dashboard.

```
 employee ─ WhatsApp ─ Evolution API ──► n8n: "Everwake Salary — WhatsApp Agent" ──► reply
                         (Cloud API later)    voice note → transcribed · photo → read
                                              GPT-6 Luna + three tools
                                                       │
                                                       ▼
                               PostgreSQL (your server)  salary.*  ◄── HR dashboard (Next.js on Vercel)
                                                                      upload sheets · identity checkboxes
                                                                      disputes · chats · settings
```

## What is in here

| Folder | What it is |
|---|---|
| `database/` | The schema and every function the agent and the dashboard call, a demo company, and the SQL tests. `migrate.sh` builds or updates your database. |
| `engine/` | The n8n workflow. Code lives in `src/` (one file per Code node) and the agent's instructions in `prompts/agent.md`; `npm run build` writes the importable workflow to `dist/`. |
| `dashboard/` | The HR dashboard (Next.js 15), deployed on Vercel. |
| `docs/SETUP.md` | From zero to the first WhatsApp answer. |

## How the agent keeps salaries private

The rules that matter are in the database, not only in the prompt, so no wording
an employee tries can get around them:

- **Nothing before identity.** `salary.get_payslip` and `salary.escalate_to_hr`
  answer only a chat that passed `salary.verify_identity`, and only with that one
  person's row. The model has no tool that takes another person's details.
- **Formats are checked by code**, the same functions for the HR sheet and for
  what the employee types: the national ID is 14 digits with a real birth date and
  governorate; phones are Egyptian mobiles (+20 / 0020 understood); names are
  compared without vowel marks and the أ/ا, ة/ه, ى/ي, "عبد الله"/"عبدالله"
  differences; Arabic digits are read as digits.
- **An exact match** on every field HR ticked, against the newest published month.
- **The WhatsApp number must be the number on the payroll row** (HR can switch
  this off). Someone who knows a colleague's details still can't read their salary.
- **A wrong attempt never says which field was wrong**, and the attempts log keeps
  the values masked (`••••••••••1234`).
- **Hidden columns** (the national ID, the phone, an "HR notes" column) stay in the
  database; the agent never reads them out.
- **Verification wears off** after the hours HR set (24 by default; 0 = never).

## What HR gets

- **Payroll sheets.** Upload one Excel (or CSV) per month. The header row is found
  by itself (a title above it is fine), totals lines are skipped, and the name,
  national ID, work ID and phone columns are recognised from their Arabic or English
  names. Each row's problems are shown before publishing: an invalid national ID,
  a missing phone, the same person twice. Uploading a month again replaces it on
  publish. Every month stays, so employees can ask "and last month?".
- **Identity check.** Tick what the agent must collect before any salary detail
  (full name as on the ID card, national ID, work ID, mobile number), the formats,
  and the phone-match rule — with a live WhatsApp preview of how the agent asks.
- **Disputes.** When an employee still disagrees after the agent showed them the
  row, the agent opens a ticket. HR sees what they wrote beside their row for that
  month, replies on WhatsApp from the dashboard, and marks it resolved.
- **Chats.** Every conversation and every identity check, as the employee saw it.
- **Settings.** Company and agent name, how to reach HR, the agent's on/off switch,
  the Evolution connection and the webhook to paste into it, and the HR team.

Arabic and English, phone and desktop.

## Tests

```sh
# database: builds a fresh database from the migrations and runs every assertion
cd database && PGHOST=localhost PGUSER=postgres PGPASSWORD=… ./tests/run.sh

# engine: whole WhatsApp chats through the real Code nodes and SQL (no OpenAI key needed)
cd engine && npm install && npm run build && PGHOST=localhost PGUSER=postgres PGPASSWORD=… npm test

# dashboard: types and a production build
cd dashboard && npm install && npm run typecheck && npm run build
```
