# Everwake Clinic

An AI front desk for doctors of any speciality, with full support for dentists. It has two parts.

- **A 24/7 WhatsApp assistant** that books patients. It:
  - understands Egyptian booking language ("يوم الأربع اللي بعد الجاي"، "بعد بكره"، "بعده"), voice notes, photos and PDFs;
  - answers price questions from the clinic's own list, word for word;
  - sends two reminders that let the patient confirm, move or cancel;
  - handles "the doctor is 20 minutes late" end to end;
  - flags anything that sounds like an emergency.
- **A dashboard** for the doctor and the desk. It holds:
  - the day, the calendar and patients' records;
  - dental charts and treatment plans;
  - the WhatsApp inbox;
  - services and prices, and every setting.

Arabic and English throughout. Multi-tenant: one sign-in can belong to several clinics, and every clinic sees only its own data.

> **Stage 1 (this release): the booking core.** Stage 2 adds the visit recorder and the doctor's AI assistant (chat and voice). Stage 3 adds online payment with Paymob, analytics and the extras. See [docs/ROADMAP.md](../docs/ROADMAP.md).

## Layout

```
database/          Postgres (Supabase), schema `clinic`: every rule is a SQL function
  migrations/      001–011, 020 (29 speciality presets), 090 (Supabase storage + live updates)
  seed/            demo_clinic.sql: "عيادات النيل", a dentist and a paediatrician, two branches
  tools/           build_setup.sh (one-paste setup file), showcase_clinic.sql (a living demo day)
  tests/           run.sh + 6 test files
engine/            the n8n workflows, generated from src/ and prompts/ (npm run build → dist/)
dashboard/         Next.js 15 + Supabase: the clinic's dashboard and the patient's page
docs/              SETUP (from nothing to the first booking) · ARCHITECTURE · ONBOARDING
everwake_clinic_supabase_setup.sql   every migration in one file, for Supabase's SQL editor
```

## What the clinic gets (stage 1)

| | |
|---|---|
| **Today** | The session ribbon: each doctor's day as a line, every patient a block, a live "now" needle. A doctor's delay shows as a hatched band that pushes the blocks along. Below it: the next patient (allergies in red, what they said, their last visit and files), the waiting room with wait times, delay replies coming in, what the assistant booked, and the go-live checklist. |
| **Calendar** | Week (a lane per doctor) or day (a column per doctor). Drag a booking to move it, and the patient is told on WhatsApp if you choose. There is also a list view for phones. |
| **Patients** | Search by name, mobile or file number. The profile holds allergies, conditions, medicines, history and vitals. Visit notes are written on the speciality's form, as a draft until signed. Files sent on WhatsApp arrive already read and summarised. |
| **Teeth & plans** | An FDI dental chart (adult and child): tap a tooth to set its condition, surfaces and planned work. Treatment plans list tooth, treatment and price, with a total, a discount, "send the quote on WhatsApp", and progress session by session. |
| **Inbox** | Every WhatsApp chat, with the ones that need someone on top. Take over and hand back. Answer the assistant's questions for the doctor (Yes, No or a typed answer), and the patient hears at once. |
| **Running late · Block time · New booking** | Available from every page. "Running late" previews who is affected and their new times before sending. |
| **Services & prices** | Inline price editing in five price shapes (fixed, from–to, from, after the check-up, free), priced per visit, tooth, canal, jaw, session, area or course. Also offers, an import from a pasted list, a PDF or a photo (checked before publishing), and "what the assistant reads". Every change can be undone. |
| **Knowledge & rules** | FAQs and policies. Rules enforced in code: no new patients after a time, young children only with one doctor, no assistant bookings on some days. Plus notes the assistant reads. |
| **Settings** | Clinic, the assistant (name, voice, emergency text), doctors, locations and chairs, schedules (slots, queue or both) and days off, booking rules, reminders and every message's wording, WhatsApp, team and roles, brand. |
| **The patient's page** | `/a/<token>`, the link in every reminder. The patient sees the appointment and confirms, moves or cancels it, with no sign-in. |
| **From the doctor's own WhatsApp** | "هتأخر 20 دقيقة"، "الغي عيادة النهارده"، "ارفع سعر التنضيف لـ 700". Each one is previewed, then confirmed. |

## Quick start

- Set up: **[docs/SETUP.md](docs/SETUP.md)**.
- How it works: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
- Signing a clinic up: **[docs/ONBOARDING.md](docs/ONBOARDING.md)**.

To check everything locally (Postgres 16 running, user `postgres`):

```bash
cd database && PGPASSWORD=postgres ./tests/run.sh
```

```bash
cd engine && npm install && npm run build && PGPASSWORD=postgres npm test
```

```bash
cd dashboard && npm install && npm run typecheck && npm run i18n:check && npm run build
```

## Honest limits

- **Evolution API is unofficial WhatsApp.**
  - Messages the clinic starts are spaced a few seconds apart.
  - Reminders use numbered replies and a link rather than buttons.
  - Every message carries its template name, so the later move to the official Cloud API is mechanical.
- **Medical records are sensitive data** under Egypt's Law 151/2020.
  - Run the clinic on its own Supabase project.
  - Only doctors and nurses (members marked "sees records") can read them.
  - Every opening of a record is logged.
- **The assistant never diagnoses or prescribes.** Medical questions go to the doctor, and an emergency gets the clinic's emergency text first.
