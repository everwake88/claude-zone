# Working in this repository

## Any UI / UX work: use the design skills, every time

Whenever a task builds, edits, redesigns, reviews or polishes anything people
see — the Everwake dashboard, the customer QR menu and waiting page, the
kitchen and TV screens, the driver app, the website, any page or component —
load these skills (Skill tool) before writing the code, and follow them:

- `impeccable` — the design direction, hierarchy, layout, colour, type, copy,
  accessibility and the finishing checklist (pick its sub-command: shape,
  critique, polish, animate, quieter, bolder…).
- `taste-skill` (design-taste-frontend) — art direction and its no-slop rules;
  for app screens (dashboards, settings, inboxes) use its app-screens reference.
- `emil-design-eng` — the details that make an interface feel right; for any
  motion also `animate` / `improve-animations` / `review-animations`
  (and `animation-performance` when it could jank).
- The project's own `frontend-design` and `ui-ux-pro-max`
  (EVERWAKE-ORDERS/.claude/skills) still apply alongside them.

Then look at the result: screenshot it in the browser (Playwright, phone and
desktop, Arabic and English) and fix what the skills' checklists catch before
committing.

The skills were copied without their bundled scripts and binaries (live-browser
helpers, linters, the `impeccable` CLI): where a skill says to run one, do that
check by hand with the screenshots instead.
