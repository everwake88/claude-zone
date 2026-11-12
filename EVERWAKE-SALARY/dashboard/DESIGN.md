# Dashboard design notes

HR officers use this at a desk, mostly in daylight: every day for disputes, once a
month for the new payroll sheet. The look follows the reference the client chose: a
calm HR desk of white cards on a soft stone ground, sage on the data and the actions
that matter, one black disc for "you are here". Arabic first.

## The look

- **Ground and cards.** Stone ground `--ground #e9e8e4`, white cards with a 22px
  radius and no border or shadow at rest; inner wells `--well #f7f7f4`.
- **Ink and sage.** Ink `--ink #1c2320`, secondary text `--muted #5c635e` (5:1 on the
  ground). Sage `--sage #5b7b66` is the data hue (lines, bars, the gauge, months on
  file) and the primary button; `--sage-dark #4e6b58` fills the one card that needs
  action (Waiting for HR). Status uses pale pairs (`pill pos / neg / warn / sage`).
- **One face:** Alexandria (an Egyptian design, Arabic and Latin), loaded as a variable
  font, tabular figures on every number. Sizes 11 / 12 / 13 / 14 / 16 / 27.
- **Shell:** a floating white rail (labels as tooltips) with a black disc on the current
  page; on a phone the same pages as a floating bottom bar. The header row holds the
  page title (the greeting on Overview) and, on the other side, search, language and
  the disputes bell.
- **"Powered by Everwake"** sits small at the foot of every page and the sign-in page.

## Motion: alive, never in the way

- Cards rise into place when a page opens (400ms, 32ms stagger, `cubic-bezier(.16,1,.3,1)`).
- Charts draw themselves once: the activity line reveals left to right, bars grow, the
  gauge sweeps with its needle, numbers count up (and count from old to new on refresh).
- The rail disc and the segmented pills slide to a choice the moment it is clicked,
  before the server answers; a skeleton in the page's own shape shows meanwhile.
- Overview, Disputes and Chats refresh themselves every 20s while visible ("Live");
  new rows, bubbles and saved messages fade in through `@starting-style`.
- The agent's face breathes while she is answering; the live dots ping.
- Press feedback: buttons `scale(.97)`, icon buttons `scale(.93)`; hover lifts only on
  linked cards, behind `(hover: hover)`.
- `prefers-reduced-motion`: no travel, no loops; content appears with a short fade.

## Rules

- Every English string has its Arabic in `src/lib/i18n.ts`; a missing one is a type
  error. Logical CSS properties throughout; `--dir` (1 / -1) mirrors transforms in RTL.
  Isolate mixed-script values with `<bdi>`, `.ltr` or FSI/PDI.
- Names: "عبد الرحمن" and "أبو بكر" are one name (`firstName`, `initials` in `lib/format.ts`).
- Identity numbers print exactly as typed; money gets separators.
- Forms use `ActionForm` (`components/Submit.tsx`) so typing survives an error.
- One database round trip per Overview render (`OVERVIEW` query); the Vercel functions
  run in Stockholm (`vercel.json`), next to the database.
- Check every change at 1440 and 390 wide, in Arabic and English.
