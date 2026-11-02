# How Everwake Clinic works

Three parts, as in Everwake Orders:
- **Postgres** holds every rule as a SQL function.
- **n8n** runs the WhatsApp assistant.
- **A Next.js dashboard** for the clinic.

The same functions serve the assistant, the doctor's own WhatsApp and the dashboard, so a rule (a price, "no new patients after 9", a delay) behaves the same wherever it is used.

```
patient ── WhatsApp ── Evolution ──► n8n "Clinic — Main"
doctor's own number ──┘                 Normalize → Intake → media (voice, photo, PDF) → Build Brief
                                        → Brain → Agent ⇄ manage_booking / staff_action → Check Reply → Persist → send
                                                   │
                         Postgres, schema `clinic` ◄──── dashboard (Next.js, signed-in members, row level security)
                                                   ▲
                         n8n "Clinic — Outbox + Housekeeping" every minute: reminders, delay follow-ups,
                         expired holds, automatic no-shows, waitlist offers, and the outbox
```

## The assistant's turn

1. **Intake** finds the clinic from the Evolution instance and its webhook token. It finds the person from any of their identities, then picks a route:
   - **agent** — a patient;
   - **staff** — a member's or doctor's own number;
   - **human** — someone took over the chat;
   - **paused** — the assistant is switched off;
   - **not live** — the clinic hasn't gone live;
   - **from the phone** — the clinic replied from WhatsApp itself.
2. **Media.**
   - Voice notes are transcribed.
   - Photos and PDFs are read with a tag (`[lab]`, `[prescription]`, `[xray]`…) and saved to the patient's files, with lab values pulled out.
3. **Build Brief** works out in code everything the model should not guess:
   - **Dates** (`src/shared/dates.js`): "يوم الأربع اللي بعد الجاي", "بعد بكره", "5 ونص", "بعده" (the slot after the last one offered). Each is resolved to real dates and written into the brief as facts.
   - **Red flags** (`src/shared/triage.js`): chest pain with sweating, trouble breathing, a child's fever over 39.5, and so on, plus the speciality's own words (facial swelling for a dentist). The check handles negation ("مش بيوجعني").
   - **The catalogue snapshot:**
     - services and prices for this doctor and place, in their price shapes;
     - offers, answers and the doctor's rules.
     - It is rebuilt whenever anything in it changes, so a price saved in the dashboard is quoted in the next reply.
4. **Brain and Agent.** The Brain reads the turn. The Agent replies in Egyptian Arabic and calls **manage_booking**. The tool's actions are `find_slots`, `summary`, `book`, `status`, `confirm`, `reschedule`, `cancel`, `accept_delay`, `take_offer`, `join_waitlist`, `accept_plan` and `next_plan_session`. Rules are enforced inside the tool, so the model cannot book against them:
   - service days;
   - ages;
   - a check-up required first;
   - new patients until a set time;
   - children with one named doctor;
   - chairs.
5. **Check Reply** rejects any amount that isn't in the catalogue or a tool result. In an emergency it requires the clinic's emergency text. **Repair Reply** fixes a reply once; failing that, the patient gets a safe fallback.
6. **Persist** saves the turn, the alerts (an emergency also messages the doctor's own WhatsApp) and the state. After a booking, the location pin goes out with the confirmation.

## The doctor's own WhatsApp

A message from a member's registered number takes the **staff** route. Commands:
- "هتأخر 20 دقيقة"
- "الغي عيادة النهارده"
- "اقفل بكره من 5 لـ 7"
- "ارفع سعر التنضيف لـ 700"
- "مين عندي النهارده؟"

Every change is shown first (who will be told, before → after) and applied only after "أيوه". Catalogue changes can be undone.

## Reminders and the late doctor

- **Reminders.**
  - **When:** by default the evening before at 19:00 and 3 hours before. Both times are settings.
  - **What the patient can do:** reply 1 / 2 / 3 or in their own words, or use the link (`/a/<token>`).
  - **If they don't confirm:** "at risk" is raised on the dashboard.
- **Running late** (`announce_delay`). It shows a preview first, then moves every booking that hasn't arrived by the same minutes:
  - a queue number keeps its place with a new estimate;
  - the messages go out 3 seconds apart, each offering to accept, pick another time or cancel.
  - Anyone who hasn't answered gets one follow-up, timed by how close their original time is:
    - 40% of the time left, but at least 10 and at most 90 minutes;
    - and never later than 30 minutes before their time.
  - After that, the patient is marked "no reply".
- **Cancelled session.** Each patient is offered their two nearest times.

## The dashboard

- **Reads and writes.** The dashboard reads tables under row level security and calls `security definer` functions that check the caller's role first (008, 011).
- **Roles:**

  | Role | Can do |
  |---|---|
  | owner | everything, including the team and WhatsApp |
  | manager | everything but the team |
  | doctor | records, prices and their own schedule |
  | nurse | records and the day |
  | receptionist | bookings, the waiting room and chats; no medical records |

  The `clinical` flag on a member decides who reads records. Every opening of a record is logged (`record_access_log`).
- **Live updates.** One realtime channel per open dashboard (`lib/live.tsx`) carries appointments, alerts, chats, team questions, delay replies and the waitlist. Pages refresh themselves when their tables change. The shell turns new events into toasts, and an emergency raises the red banner with a chime until someone marks it seen.
- **The patient's page** (`/a/<token>`) is served by the dashboard's server with the service role. It calls only `manage_view`, `manage_slots` and `manage_action`, which check the token and the clinic's cancellation policy.

## The catalogue

- **Services**
  - **Price shapes:** fixed, from–to, from, after the check-up, free.
  - **Units:** visit, tooth, canal, jaw, session, area, course.
  - **Per-doctor and per-place prices** (`service_prices`).
  - **Other fields:** sessions and spacing, preparation and aftercare text, who does the service and on which days, age limits, a chair needed.
- **Offers, answers (FAQs and policies), and the doctors' rules.**
- **How changes are made.** Every change from the editor, the import, staff WhatsApp or (stage 2) the assistant goes through `catalog_change`:
  - it builds a preview, then applies;
  - the before and after are kept in `catalog_changes`;
  - `catalog_undo` reverts it.

## Dentistry

- **FDI chart.** Adult 11–48, child 51–85, with condition, surfaces, planned work and notes per tooth.
- **Treatment plans.**
  - Each item is a tooth, a service, a price and its sessions. The plan has a total and a discount.
  - `plan_quote` sends the total on WhatsApp. Once the patient says "موافق", the assistant books the first session.
  - When a visit is marked done, the item's progress moves on and the next session is offered.
  - Each chair is booked together with the doctor, so two patients never share a chair.
