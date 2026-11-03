# Everwake Clinic: design

## The world

**Everwake navy and gold, calm enough to read at a glance.**
- A navy slab (the sidebar) holds the navigation. It is inset from the window and rounded, and the selected page is a paper tab that joins the content (the notch).
- The work sits on soft paper (`#F3F5F6`) in white cards: a hairline border, a 20 px radius, no shadow at rest.
- **One question per card.** Each card has a title, one answer (a big number, a ring, a timeline or a short list of at most 3–5 rows) and "See all" for the rest. Details live in drawers.
- **Colour does three jobs only:**
  - navy for structure and the primary action;
  - gold for "you are here / now / the one highlight" (gold text is `gold-ink`, never gold on white);
  - the status colours, on small dots and pills only.
- The dashboard is always the Everwake look. The clinic's logo and name sit in the sidebar; only the patient's page (`/a/<token>`) takes the clinic's own colour (`lib/brand.ts`).

**The signature elements:**
- the Everwake mark (the dot over two arches, in a gold ring), which draws itself in once on Today and on sign-in;
- Today's **day timeline**: a card per patient at their time, the patient with the doctor in navy with gold words, done patients dimmed, a dashed gold "now" line with a breathing dot, and the doctor's delay as a hatched band;
- the visit's **listen button**: a navy disc in a gold ring whose arc follows the voice.

## Tokens (`src/app/globals.css`, from `brand/tokens/everwake.css`)

| Role | Values |
|---|---|
| Navy | `navy #0B222E` · `navy-raised #102C3A` · `navy-soft #16384A` · `navy-line #2B4A59` · `on-navy-muted #9FB3BC` |
| Gold | `gold #B8913F` · `gold-bright #D4A94B` · `gold-ink #7F6320` (gold text on light) · `gold-wash #F6F0E2` · `gold-line #E3D4AE` |
| Surfaces | `paper #F3F5F6` · `sheet #FFF` · `raised #F7F9FA` · `sunk #E9EDEF` · `border #DFE5E8` · `rule #EBEFF1` · `control #C9D3D8` |
| Text | `ink #0B222E` · `muted #51666F` (6.0:1) · `faint #5B6F78` (5.3:1) |
| Positive | `#2E7D5B`, soft `#E8F2ED`, ink `#1F5C42` |
| Caution | `#8C6119`, soft `#FBF2E2`, line `#EBD9B3` |
| Critical | `#A33B32`, soft `#FAECEA`, ink `#7A2A23` |

The older `accent` names map onto navy, so every page took the new look at once.

**Type:** Inter (Latin) and IBM Plex Sans Arabic, through `next/font`. 24 px page titles, 15 px card titles, 13–14 px body, 26 px figures, `tabular-nums` for times, money and counts.

**Radii:** controls and pills are full; inputs 12 px; cards 20 px; drawers and the assistant sheet 24 px.

## Components (`src/components/ui.tsx`)

| Component | Notes |
|---|---|
| Button | primary (navy), accent (gold, for the single highlight such as Start visit or Sign), outline, ghost, danger, positive |
| Field · Input · Textarea · Select · Switch · Checkbox | the focus ring is a soft gold |
| Card | title, sub, action, and `more` for "See all" |
| Ring | a thin donut for a share of a whole, drawn once with `pathLength`, the answer in its middle |
| Stat · CountUp | a figure and what it is; numbers count to a new value, never on first paint |
| Pill · Dot | state beside its words |
| Segmented | a navy pill slides between the options (`layoutId`) |
| Drawer · Dialog | a side sheet (a bottom sheet on phones); a dialog for a choice that must be made |
| Toasts | navy, with gold accents, Undo and a timer bar |

Also: `mark.tsx` (the mark and wordmark), `today/Timeline.tsx`, `visit/*` (the visit workspace), `assistant/Assistant.tsx` (the orb and the sheet).

## The visit workspace (`/c/<slug>/visit/<appointment>`)

- **Left:** "Listen to the visit": consent first, the listen button, Pause and Done, the words as they come, then three named stages while the note is filled. After, the transcript with who said what; a tap plays that moment.
- **Right:** "New for the record" (allergies, medicines, conditions, teeth and plan items, each waiting for a tick), then the visit's reason, assessment, plan and follow-up, then the doctor's own form, a card per section, then the prescription.
- **Evidence:** a filled field has a small "Heard" chip that opens the quote, who said it and a play button. A field the check could not stand behind is left empty with a dashed amber edge and "Not clear in the recording — fill it in".
- **Finishing:** a floating navy bar saves the draft by itself and holds Sign (gold). After signing, "After the visit" offers the SOAP note, the prescription on the clinic's paper, the patient's summary to send on WhatsApp, the letters and the follow-up booking.

## The assistant

An orb in the corner (the mark, with a slow gold glow), ⌘J, opens a sheet that keeps the page in view. Replies stream in; tool chips ("Looking up the patient") turn into links; any change is a card with what it will do and Confirm / Not now. Hold the mic to talk.

## Motion

- **Arrivals:** cards rise 8 px and fade in, staggered 40 ms (at most 6). Numbers count up; rings draw in once.
- **Movement:** the nav tab and segmented controls slide (`layoutId`); lists make room (`layout`); timeline cards move when a delay lands; filled visit fields flash gold-wash once.
- **Small life:** the "now" dot and the listening dot breathe (2.4 s); the orb's glow (3.6 s); a card lifts 1 px on hover.
- **Rules:** transform and opacity only; 150–400 ms; ease-out `cubic-bezier(.23,1,.32,1)`, drawers `(.32,.72,0,1)`. The voice level is written to the element directly, not through React. The command palette opens instantly (it is keyboard-driven). `prefers-reduced-motion` turns animation off.

## Layout

| Size | Layout |
|---|---|
| ≥1024 px | the navy slab (236 px) inset at the start, content beside it, at most 1340 px wide |
| <1024 px | a header and a navy bottom bar (Today, Calendar, Patients, Inbox, More); the sidebar opens as a drawer |

- Today on desktop: the main column (greeting, who is now, three rings, needs you and the waiting room) and the day timeline beside it.
- No horizontal page scroll at 390 px; checked on every page.

## Copy

Sentence case. Verbs on buttons ("Start visit", "Tell 4 patients", "Book it"). Arabic is Egyptian for the desk ("ابدأ الكشف"، "ماجاش"، "متأخر"). No kicker above a heading. Database error codes become sentences (`lib/codes.ts`).

## How it was checked

Playwright screenshots against the production build and the real database (through a local stand-in for Supabase's API), at 390 and 1440 px, in Arabic and English: every page (17), the visit workspace (to review, and signed), and the assistant's sheet. No console errors and no horizontal overflow. The skills' bundled scripts were not available, so their checklists were applied by hand.
