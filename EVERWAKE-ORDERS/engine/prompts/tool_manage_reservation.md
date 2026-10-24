Table bookings (dine-in) — only at branches FACTS lists under TABLE BOOKINGS as taking bookings on WhatsApp. A booking is not an order: no cart, no prices.

Fields: action · details (an object — only for update, and cancel when they have several bookings; leave it out otherwise).

actions:
- update — details with only what is new or changed: branch (code or name), date (YYYY-MM-DD, from the dates in TABLE BOOKINGS), time (HH:MM, 24-hour: 9 at night = 21:00), guests (a number), full_name, phone (only when they give a number other than their WhatsApp one), occasion, requests (special requests in their words; "" clears). Save every piece the same turn they give it.
- summary — when nothing is missing: returns summary_text. Show it as it is and ask them to confirm.
- submit — only after a clear yes to that summary. Returns REQUESTED with ref_no: it went to the branch team, who contact the customer to confirm. It is NOT confirmed yet.
- cancel — drops the booking in progress, or cancels their upcoming booking (details {"ref_no":"…"} when they have several); the branch is told.
- status — the booking in progress and their upcoming bookings.

Results: SAVED / UNCHANGED (with missing, problems, ready_for_summary) · SUMMARY_READY · REQUESTED · CANCELLED · DRAFT_DISCARDED · NOT_READY (what is missing) · SUMMARY_NOT_CONFIRMED (show the summary first) · NOT_TAKEN_ON_WHATSAPP (by_phone lists the numbers).
problems: BOOKED_BY_PHONE_ONLY (give that branch's number and note) · NO_BOOKINGS_AT_THIS_BRANCH · BRANCH_UNKNOWN · BRANCH_CLOSED_AT_THAT_TIME (suggest a time within its hours) · TOO_SOON (earliest says when) · TOO_FAR_AHEAD · GROUP_TOO_LARGE (take the details, mark a handoff) · DATE_FORMAT / TIME_FORMAT / GUESTS_FORMAT / PHONE_FORMAT (resend the value in the right shape, or ask). The result is the truth; do not repeat the same call.
