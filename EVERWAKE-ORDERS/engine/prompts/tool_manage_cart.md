The cart, the branch, offers and placing the order. The tool prices everything from the chosen branch's menu and applies the restaurant's offers — never send a price.

Fields: action · items (a list — only when the action touches dishes; leave it out otherwise, never an empty list) · branch (for set_branch, or with the first add or a quote when no branch is set yet).

actions:
- add / update / remove / replace / clear — dishes in items
- set_branch — branch = the branch code or name. Required before the first dish (unless the restaurant has one branch) — or send it with that first add (action add + branch + items) in ONE call: never set_branch and add as two calls at once. Changing it re-checks and re-prices the whole cart.
- reorder_last — the customer's latest order back in the cart, priced from today's menu (no items).
- apply_code — a promo code the customer gave: items = [{"promo_code":"CODE"}].
- quote — changes nothing: prices the dishes in items (with VAT and the delivery fee when known) without adding them, for "how much would that come to?". Returns QUOTE with the totals; their order stays as it was.
- summary — changes nothing: re-prices the order with what is known now (the delivery area saved since, today's menu) and returns the totals. Call it right before you show the order summary.
- place_order — only after the customer confirmed the order summary you showed. Returns PLACED with order_no, or NOT_PLACED with reasons. When they pay online, PLACED carries payment: LINK_READY with the link to send (or why there is no link yet).

items shape (a list):
[{"menu_id":"M003","quantity":1,"choices":[{"level":1,"selected":["فرخة كاملة"]}],"notes":"من غير بصل"}]
- menu_id exactly as in the MENU. quantity = kilos for dishes sold per kilo (0.5, 0.75, 1 …), otherwise a count.
- choices: option names from the MENU or the tool; the level number may be left out.
- line_id: change/remove one specific cart line. pending_id: answer for a dish that is waiting on a choice. force_new: true for a second, differently made portion of the same dish.
- update/replace may carry only what changed; the rest of the line is kept.

Results: DONE (saved) · NEEDS_CHOICES (dish waiting — ask about ask_about) · BRANCH_SET · REORDERED · CODE_APPLIED / CODE_NOT_VALID · BRANCH_NEEDED · BRANCH_NOT_FOUND · BRANCH_NOT_ACCEPTING · PLACED · NOT_PLACED. menu_changes lists dishes the restaurant switched off or re-priced since they went in the cart. The result is the truth; do not repeat the same call.
