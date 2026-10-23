# Dashboard design notes

The people using this dashboard run restaurants, not software. Every screen
should say what it is for and what each option changes, in their words.
The `ui-ux-pro-max` and `frontend-design` skills in `../.claude/skills/` are
the reference; these are the rules this dashboard follows.

## Finding your way

- The side menu is grouped: **Every day** (orders, inbox, bookings, customers),
  **Your restaurant** (menu, branches, zones, drivers, offers), **Grow**
  (get customers, analytics), then Settings. A new page goes in the group that
  matches when people use it.
- Settings opens on a page that lists every area with one line on what it
  changes (`components/settings/sections.ts`). A new settings tab gets its
  line there; the same line shows under the tabs on its page.
- Tab and button names say what they are about: "Ordering rules", not "Ordering".
  When a name changes, change every "Settings → …" reference too.

## Explaining a page

- A setup or daily page starts with `<PageGuide id="…" steps={[…]} />`
  (`components/guide.tsx`): 2–4 plain steps, in the order people do them.
  It closes with "Got it" and stays one line away ("How this page works").
- A step names the real button as it is written on the screen.
- Field hints say what happens, not what the field is: "Empty = the branch
  confirms the price", "0 = never by itself".
- The go-live checklist on Overview says why each step matters (`WHY` in
  `app/r/[slug]/page.tsx`) and marks the next one with "Start here".

## Words

- Plain words, sentence case, no jargon: "the agent", "a branch", "a location
  pin" — never webhook, snapshot or tenant.
- A button says what happens: "Accept and tell the customer", and its message
  afterwards uses the same verb.
- Every English string has its Arabic in `src/lib/i18n-ar.ts` (Egyptian
  Arabic, the agent is "المساعد").

## Quality floor

Visible labels on every input, keyboard focus rings, `aria-current` on the
page you are on, icons with text (never icon-only without `aria-label`),
layouts that work at phone width, and no colour as the only signal.
