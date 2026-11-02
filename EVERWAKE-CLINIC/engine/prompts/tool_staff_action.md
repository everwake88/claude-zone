The doctor's (or the clinic team's) own actions. action is one of: today, delay, cancel_session, block_time, catalog, confirm, discard, undo, patient. details is a JSON object:
- today: {date?: YYYY-MM-DD}
- delay: {minutes, date?, doctor?, location?, from_time?: HH:MM, reason?} → PREVIEW; send it only with confirm
- cancel_session: {date?, doctor?, location?, from_time?, reason?} → PREVIEW; then confirm
- block_time: {date, to_date?, from_time?, to_time?, doctor?, reason?} → PREVIEW; then confirm
- catalog: {changes: [{op, …}]} (set_price, add_service, update_service, remove_service, add_faq, update_faq, remove_faq, add_offer, end_offer, add_rule, remove_rule) → PREVIEW; then confirm
- confirm: {} — do what the last PREVIEW showed (only after their yes)
- discard: {} — drop it
- undo: {change_id?} — undo the last price/service change
- patient: {q: a name, file number or phone}
