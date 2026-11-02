# Signing a clinic up

About 30 minutes with the doctor or the clinic manager. Nothing reaches real patients until the owner presses **Go live**: before that, only the test numbers reach the assistant.

## 1. The account

1. The doctor (or manager) opens the dashboard and chooses **Create account**.
2. **Sign up your clinic.** They enter:
   - the clinic's name in Arabic and English;
   - **the speciality**. Dentistry is first.
3. They choose **I am the doctor** (their name, "دكتور" or "دكتورة") or **I run the clinic**.

The speciality fills in:
- its usual services (prices left empty);
- the visit form;
- the warning signs the assistant listens for. For a dentist, that means facial swelling with trouble swallowing, a knocked-out tooth, and bleeding that won't stop after an extraction.

A polyclinic adds its other doctors in Settings → Doctors, and each new doctor can bring their speciality's services.

## 2. The go-live checklist (on Today)

| Step | Where | Notes |
|---|---|---|
| Clinic profile and the assistant's name | Settings → Clinic, The assistant | The "about" text, insurance accepted, and the emergency text (ambulance 123 by default) |
| Clinic address | Settings → Locations & chairs | Address, "how to find it" and the map pin go with every booking. Add the dental chairs: a service that needs a chair is only booked when one is free |
| Doctors and their schedules | Settings → Schedules & days off | Each session is **slots** (fixed times), **queue** (a number, الدور, with an estimated time) or **both** |
| Services and prices | Services & prices | Paste their price list ("تنضيف جير 600", "زرعة 12000 - 18000 للسنة") or upload a PDF or photo, check it, and publish. Mark what is "after the check-up" |
| Answers to common questions | Knowledge & rules | Optional. Parking, insurance, payment and installments, the cancellation policy. Add the doctor's rules too: new patients until 9 pm, young children only with one doctor |
| WhatsApp number connected | Settings → WhatsApp | The clinic's Evolution instance; the webhook address is shown there |
| A test booking from a test number | Settings → The assistant → Test numbers | Book from a test number, then check it on Today |

When the required steps are done, the owner presses **Go live**.

## 3. The doctor's own WhatsApp

1. In **Settings → Doctors**, enter the doctor's own WhatsApp number. Team members can add theirs in Settings → Team.
2. From that number they can write:
   - "هتأخر 20 دقيقة"
   - "الغي عيادة النهارده"
   - "اقفل بكره من 5 لـ 7"
   - "ارفع سعر التنضيف لـ 700"
   - "مين عندي النهارده؟"

Every command is confirmed before it is sent to patients.

## 4. The team

**Settings → Team → Invite someone.** The person signs up with that e-mail and joins automatically.

- Receptionists see bookings, the waiting room and chats, but no medical records.
- Doctors and nurses see records.

## 5. Showing it

For a demo, use the demo clinic. Run `database/seed/demo_clinic.sql`, then `database/tools/showcase_clinic.sql` just before the demo. The day is built around the time you run it.
