# Setting up Everwake Clinic

From nothing to the first test booking on WhatsApp. This is done once for the platform, not once per clinic. It takes about an hour.

You need:
- a Supabase project (its own project, not shared with Orders: medical records are sensitive data);
- your n8n;
- an Evolution API server;
- an OpenAI key;
- somewhere to host the dashboard: Vercel, or Docker on the VPS.

---

## 1. The database (Supabase)

1. **Create a Supabase project** in the region closest to the clinics. Frankfurt suits Egypt and the Gulf.
2. **Run the setup.** Paste `everwake_clinic_supabase_setup.sql` (every migration in one file) into the SQL editor and run it once. Or, with `psql`:
   ```bash
   for f in database/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$f"; done
   ```
   The files, in order:

   | File | What it holds |
   |---|---|
   | 001 | clinics, members and roles |
   | 002 | doctors, locations, schedules, and the catalogue the assistant answers from |
   | 003 | WhatsApp: contacts, chats, the outbox |
   | 004 | patients and records |
   | 005 | appointments, slots and queues |
   | 006 | the assistant's alerts and context |
   | 007 | reminders, delays, cancelled sessions |
   | 008 | the dashboard's functions |
   | 009 | security |
   | 010 | engine extras |
   | 011 | the dashboard's reads and the patient's page |
   | 012 | the doctor's AI: recordings, scribe runs, the assistant's chats and cards, pre-visit questions |
   | 020 | the speciality presets |
   | 090 | storage buckets (including the private `clinic-recordings` for visit audio) and live updates (Supabase only) |
3. **Expose the schema.** Go to Settings → API → *Exposed schemas*, add `clinic` (keep `public`), and save.
4. **Set the sign-in addresses** under Authentication → URL configuration:
   - **Site URL:** the dashboard's address, e.g. `https://clinic.everwake.tech`.
   - **Redirect URLs:** add `https://clinic.everwake.tech/auth/callback`.
5. *(Optional)* **Load the demo clinic** for sales demos. Run `database/seed/demo_clinic.sql`, then `database/tools/showcase_clinic.sql`.
   - The showcase builds a living day around the time you run it: patients waiting, the dentist 20 minutes late with answers coming in, an emergency on WhatsApp, a dental chart and a quoted plan.
   - Run it again before each demo.

## 2. The dashboard

### Environment

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → the anon (publishable) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → the service_role key. Server only; never prefix it with `NEXT_PUBLIC_`. It is used for the patient's page (`/a/<token>`) and to wake the assistant after a team answer. |
| `OPENAI_API_KEY` | For listening to the visit, the assistant, and importing a price list from a PDF or a photo. Without it the doctor types the note and the assistant says it needs the key; a pasted price list is still read line by line. |
| `CATALOG_AI_MODEL` | Optional. Defaults to `gpt-5.6-luna`. It must read PDFs and photos. |
| `N8N_BASE_URL` | Your n8n's public address, e.g. `https://n8n.example.com` |
| `N8N_OUTBOX_SECRET` | A long random string. The same value goes into n8n (step 3). It also guards `/api/scribe/retention`. |
| `SCRIBE_TRANSCRIBE_MODEL` | Optional, `gpt-transcribe`. Hears each 20-second piece during the visit. |
| `SCRIBE_DIARIZE_MODEL` | Optional, `gpt-4o-transcribe-diarize`. Tells the doctor's words from the patient's after Stop; `off` skips it (the pieces' own words are used). |
| `SCRIBE_EXTRACT_MODEL` | Optional, `gpt-5.6-luna`. Fills the form, a quote behind every value. |
| `SCRIBE_VERIFY_MODEL` | Optional, `gpt-5-mini`. The independent check of every filled field. |
| `ASSISTANT_MODEL` | Optional, `gpt-5.6-luna`. The doctor's assistant. |
| `ASSISTANT_TRANSCRIBE_MODEL` | Optional, `gpt-transcribe`. Push-to-talk. |
| `ASSISTANT_TTS_MODEL` | Optional, `gpt-4o-mini-tts`. "Read replies aloud". |

### Deploy

- **Vercel:**
  - Set the root directory to `EVERWAKE-CLINIC/dashboard`.
  - Add the variables above.
  - The build command is `npm run build`.
- **Docker:**
  ```bash
  docker build -t everwake-clinic-dashboard --build-arg NEXT_PUBLIC_SUPABASE_URL=… --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=… .
  ```
  ```bash
  docker run -p 3000:3000 --env-file .env everwake-clinic-dashboard
  ```
  `/api/health` answers for the health check.

Then set `public_url` in the clinic's settings to the dashboard's address. The reminder links (`/a/<token>`) and the doctor's emergency message use it. The demo seed sets it to `https://clinic.everwake.tech`.

## 3. The engine (n8n)

1. **Build the workflows:**
   ```bash
   cd engine && npm install && npm run build
   ```
   This writes five files to `dist/`:

   | File | What it is |
   |---|---|
   | `clinic-main.json` | the assistant. Webhook `POST /webhook/clinic-evo?token=…` |
   | `clinic-tool-manage-booking.json` | the booking tool it calls |
   | `clinic-tool-staff-action.json` | the doctor's WhatsApp commands |
   | `clinic-outbox.json` | sends messages every minute, and at once when the dashboard pings `POST /webhook/clinic-outbox`; every hour it asks the dashboard to delete visit audio past its days |
   | `clinic-test-runner.json` | chat with the assistant from n8n without a phone |

   Model names are environment variables read at build time:
   - `EW_MODEL` (default `gpt-5.6-luna`);
   - `EW_TRANSCRIBE_MODEL` (`gpt-transcribe`);
   - `EW_VISION_MODEL` (`gpt-5-mini`);
   - `EW_DASHBOARD_URL`, the dashboard's address for the hourly audio deletion (`POST <it>/api/scribe/retention`, with the Outbox Secret header). Default `http://localhost:3000`.
2. **Create three credentials in n8n,** with these exact names:
   - **Everwake Clinic DB** (Postgres): the Supabase connection. Use the pooler, port 6543, with SSL.
   - **OpenAi account** (OpenAI).
   - **Everwake Clinic Outbox Secret** (Header Auth): name `x-everwake-secret`, value = `N8N_OUTBOX_SECRET`.
3. **Import the five workflows**, the two tools first.
4. **Link the tools.**
   - In Main, open the **manage_booking** and **staff_action** tool nodes and pick the two tool workflows you just imported.
   - In the Test Runner, open the node that calls Main and pick Main.
   - Optionally, save the ids n8n gave the workflows in `engine/n8n-ids.json` (`{ "main": "…", "booking": "…", "staff": "…" }`, taken from each workflow's address). A rebuilt and re-imported workflow then stays linked.
5. **Activate Main and the Outbox.**

## 4. WhatsApp (Evolution)

1. In Evolution, create an instance for the clinic's number and scan the QR code.
2. In the dashboard, go to **Settings → WhatsApp → Connect a number**. Enter the instance name, the Evolution address and the API key.
3. Click **Show the webhook address**. In Evolution, set the instance's webhook to that address, with the `MESSAGES_UPSERT` event on.
4. Until the clinic goes live, only the **test numbers** (Settings → The assistant) reach the assistant. Send "عايز أحجز كشف بكره بالليل" from one of them.

## 5. Checking it locally

```bash
cd database && PGPASSWORD=postgres ./tests/run.sh
```

```bash
cd engine && PGPASSWORD=postgres npm test
```

```bash
cd dashboard && npm run typecheck && npm run i18n:check && npm test && npm run build
```

Expected results:
- the SQL test files print "all 7 test files passed";
- the engine tests run whole conversations against a real database (120 tests);
- the dashboard checks that every text has its Arabic, and `npm test` runs 14 unit tests (the form's schema, the transcript, the evidence check, the upload queue, the assistant's loop with a scripted model).
