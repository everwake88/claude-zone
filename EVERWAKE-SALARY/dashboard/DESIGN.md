# Dashboard design notes

The people using this dashboard work in HR, at a desk, mostly in daylight; they
open it every day for disputes and once a month for the new payroll sheet. It is a
quiet payroll ledger in Everwake's own colours, Arabic first.

## The look

- **Colour goes on data, not chrome.** Navy ink (`--text #0b222e`) on the Everwake
  paper ground (`--ground #f3f5f6`), white panels with a 1px `--border`. The sidebar
  sits on the page ground. Gold (`--accent #8a6b23`, wash `#f6f0e2`) is the one data
  hue: the months on file in the payroll year, the disputed item in an employee's
  row. Status uses pale pairs (`pill pos / neg / warn`), never saturated fills.
- **One face**, IBM Plex Sans Arabic (Arabic and Latin), with tabular figures on
  every number. Sizes 12 / 13 / 14 / 16 / 24; weights 400 / 500 / 600.
- **Tight radius**: 8px panels, 6px controls, pills fully round.
- **Motion is feedback only**: buttons and month cells press to `scale(0.97)` in
  160ms; switches slide in 180ms. Nothing animates on load.
- **"Powered by Everwake"** sits small at the foot of the sidebar and the sign-in page.

## Things only this product has

- **The payroll year** (Overview): twelve months, the published ones in gold with
  their employee count, gaps dashed, the current month outlined until it is uploaded.
- **The live WhatsApp preview** (Identity check): the checkboxes redraw the chat the
  employee will have, in the agent's Egyptian Arabic.
- **The employee's row beside the dispute**, with the disputed column in gold.

## Rules

- Every English string has its Arabic in `src/lib/i18n.ts`; a missing one is a type
  error. Write with logical CSS properties (`inline-start`, `inset-inline-*`) so one
  stylesheet serves RTL and LTR. Isolate mixed-script values with `<bdi>` or `.ltr`.
- Identity numbers (national IDs, codes, phones) print exactly as typed, never with
  thousands separators; money gets separators.
- Forms use `ActionForm` (`components/Submit.tsx`): it keeps what was typed when the
  server answers with an error.
- A missing value is a grey dash; a real zero prints as 0. An empty block keeps its
  frame and says in one sentence what will appear there.
- Check every change at 1440 and 390 wide, in Arabic and English.
