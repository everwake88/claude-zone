# Everwake Clinic: design

## The world

The clinic's day, written in **ballpoint ink on clinic paper**:
- a cool paper frame holds the navigation;
- the work sits on a white sheet inset from it (`.sheet`: a hairline border, 16 px radius, no shadow);
- one ink blue carries the data, the current selection and the one primary action;
- state colours appear only where they mean something.

The clinic's own colour (Settings → Brand) replaces the ink. `lib/brand.ts` darkens it until it passes 4.5:1 both ways, and derives the soft and track tints.

**The signature element is the session ribbon** on Today:
- each doctor's session is a line;
- every patient is a block at their time, coloured by where they are;
- a red needle marks now;
- when the doctor is late, a hatched amber band opens at the first moved patient's original time, and the blocks slide along (Motion layout animation).

## Tokens (`src/app/globals.css`)

**Surfaces and text**

| Token | Value | Use |
|---|---|---|
| ground | #eef1f6 | the frame |
| sheet | #fff | where the work sits |
| raised | #f6f8fb | a quiet panel in the sheet |
| active | #e2e7f0 | |
| border | #e1e6ee | |
| rule | #edf0f5 | lines between rows |
| control | #c7cfdb | input borders |
| ink | #0f1729 | text |
| muted | #535d72 | 6.5:1 |
| faint | #687186 | 4.7:1; placeholders and meta only |

**Accent:** `--brand`, default #2347b5, with soft, track and ink tints.

**States, each with a soft and an ink tint**

| State | Colour | Meaning |
|---|---|---|
| positive | #1d7448 | done, confirmed |
| caution | #8f530a | waiting, no answer, late |
| critical | #bd2128 | emergency, did not come, allergies |

**Type:** Readex Pro, Arabic and Latin, the only family. 14 px body, 13 px secondary, 22 px page titles, `tabular-nums` for times and money.

**Radii:**

| Element | Radius |
|---|---|
| controls | 7–9 px |
| cards | 10 px |
| sheet | 16 px |
| status pills | full |

## Components (`src/components/ui.tsx`)

| Component | Notes |
|---|---|
| Button | primary (ink), accent, outline, ghost, danger, positive; sizes sm and md |
| Field / Input / Textarea / Select / Switch / Checkbox | |
| Card | title, sub, action |
| Pill | tones |
| PageTitle | title, one finding, actions |
| Empty | a sentence and an action |
| Skeleton | |
| Avatar | initials on a stable hue |
| CountUp | |
| Drawer | side sheet; bottom sheet on phones |
| Dialog | |
| Segmented | the selection slides |
| Toasts | with Undo, and a timer bar |

Also:
- `booking/SlotPicker` is the day strip and time grid, the same slots the assistant offers.
- `booking/pickers` holds the doctor and place chips.

## Motion

- **Purpose:** only to show what changed. Arrivals rise 6 px; selections slide (layoutId); lists make room (layout); the ribbon's blocks move on a delay; the emergency banner drops in.
- **Timing:** 150–300 ms, ease-out `cubic-bezier(.23,1,.32,1)`; the drawer uses `(.32,.72,0,1)`.
- **Properties:** transform and opacity only. The now-needle moves by `translateX`.
- **Exceptions:** the command palette opens instantly, because it is keyboard-driven. Everything respects `prefers-reduced-motion`.

## Layout

| Size | Layout |
|---|---|
| ≥1024 px | a 236 px sidebar on the ground, and the sheet beside it |
| <1024 px | the sheet fills the screen, with a header and a bottom bar (Today, Calendar, Patients, Inbox, More) |

- **The ribbon and the week view** scroll sideways on phones. The ribbon opens at now.
- **Gutters:** 16 px on phones, 32 px on desktop; content is at most 1320 px wide.
- **No horizontal page scroll** at 390 px; this was checked on every page.

## Copy

Sentence case. Verbs on buttons: "Call in", "Tell 4 patients", "Send the quote on WhatsApp". Arabic is Egyptian for the desk ("دخّله"، "ماجاش"، "متأخر"). Error codes from the database are turned into sentences (`lib/codes.ts`).

## How it was checked

Playwright screenshots of every page (17 pages) at 390 and 1440 px, in Arabic and English, against the real database:
- no console errors;
- no overflow;
- the production build.

The skills' bundled scripts were not available, so the review was done by hand against their checklists.
