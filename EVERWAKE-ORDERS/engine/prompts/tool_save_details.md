Save the customer's details the SAME turn they give them, before replying — even if early or unasked. details = a JSON object with only what is new or changed.

Fields: full_name, phone, phone_confirmed ("yes" = their WhatsApp number is the order number), alt_phone, delivery_method (delivery | pickup), payment_method (cash | card | wallet | instapay | online — only what the customer's branch takes; online = a payment link after the order is placed), address_governorate, address_city, address_area, address_street, address_building, address_floor, address_apartment, address_landmark, address_notes, address_confirmed ("yes" = they confirmed the address that came from their location pin), order_notes, food_prefs (what they ruled out, in their words; "" clears it).
Add "reset_address": true when they give a DIFFERENT address — the old one and the old pin are cleared first.
Add "use_saved_address": <the saved address number from FACTS> (or "last") when they want an address from a previous order.
Examples: {"full_name":"أحمد"} · {"phone_confirmed":"yes"} · {"delivery_method":"pickup"} · {"use_saved_address":"12"} · {"address_area":"المعادي","address_street":"شارع 9","address_building":"8","address_floor":"3","address_apartment":"6"}
The result says whether the address is inside a delivery zone (delivery_area). The branch is NOT a field here — use manage_cart set_branch.
