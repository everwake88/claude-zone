# Signing up a restaurant — live in a day

The dashboard's **Overview** shows a go-live checklist. The restaurant can do
it alone, or you do it with them on a call. Until they press **Go live**:
- only the test numbers reach the agent
- every other customer is answered by the staff from the phone, as today

## What to collect from the restaurant

| What | Why the agent needs it | Where it goes |
|---|---|---|
| The menu — PDF, photos of the pages, a website link, or a spreadsheet | Dishes, prices, sizes, add-ons | Menu → **Import a menu with AI** (review, then publish) |
| A photo of each popular dish (optional, recommended) | Sent when a customer asks what a dish looks like | Menu → dish → Photos |
| The menu pages or PDF as they want customers to see them — or none: **Design menu pictures** draws them from the live menu with their logo, on as few pictures as it takes | Sent when a customer asks for the menu | Menu → **Menu pictures / PDF** |
| Their logo (a square PNG is best) | On the dashboard and on top of the designed menu pictures, in the brand colour | Settings → **Logo and colour** |
| Every branch: address, Google Maps link, phone, opening hours (split shifts allowed), delivery fee, minimum order, VAT, usual delivery time | Prices, "are you open?", the nearest branch | **Branches** |
| How each branch differs: dishes it does not serve (or only it serves), its own prices and choice prices, categories only some branches have, seating or delivery/pickup only, its own payment methods | Each branch's customers hear that branch's menu, prices and ways to pay; no "eat in" or table booking where there is no seating | **Menu** → *Menu of* a branch (bulk on/off, prices by %, "set up like…", import that branch's own menu) · **Branches** → a branch → *What is different at this branch* |
| Where each branch delivers | The zone decides the fee, the minimum and the branch | **Delivery zones** — draw them on the map; list the area names customers type |
| The commission the delivery apps take from them | The "saved commission" figure owners watch | Settings → **Ordering** |
| The owner's WhatsApp number(s) and a time for the daily report | Their numbers every day without opening the dashboard | Settings → **Daily report** |
| Dine-in: which branches take table bookings on WhatsApp, which only by phone, the largest group, and anything to tell customers (e.g. "the sea-view tables are limited") | The agent books a table in conversation and sends the request to the branch; or gives the number | **Branches** → a branch → *Table bookings*; rules on **Table bookings** |
| Their own drivers: name and WhatsApp number, and which branches each drives for | Orders go to a driver; the customer hears who is coming and when they are close | **Drivers** — each gets a sign-in link on WhatsApp |
| Payment methods they accept | The agent never promises anything else | Settings → **Ordering** |
| Paying online (optional): their own Paymob account — public key, secret key, HMAC secret, card (and wallet) integration IDs | Customers pay by card or wallet from a link; the order shows Paid | Settings → **Payments** (then a 10 EGP test link) |
| The kitchen's WhatsApp for order tickets (per branch or one for all) | New orders as a WhatsApp message too | Branches / Settings → Ordering |
| What the restaurant is, its tone, key facts, contacts | How the agent introduces and describes it | Settings → **Agent** |
| Answers to the usual questions: parking, catering, allergens, kids' menu… | So the agent answers instead of guessing | Settings → **Answers** |
| Their own wording for the automatic messages (optional) | Apology while off, "we're back", order updates | Settings → **Messages** |
| WhatsApp-only offers (strongly recommended) | The reason customers switch from the delivery apps | **Offers** |
| The WhatsApp number | — | Settings → **WhatsApp** (QR scan from their phone) |
| Who on their team uses the dashboard | Owners, managers, branch staff | Settings → **Team** (invite by e-mail) |

## The day

1. **Sign up.** At the dashboard, `/new` creates the restaurant, and the person signing up becomes its owner. Done by you as platform admin? Invite their owner from Settings → Team.
2. **Menu.** Import it and check every price the AI marked; anything it could not read is outlined. Publish, then fine-tune choices in the dish editor.
3. **Branches, then zones.** Add branches with their Maps links first, then draw zones. Use **Test an address** on the zones map with a few real customer addresses.
4. **Agent, Answers, Ordering, Messages.**
5. **WhatsApp.** Connect, set the webhook, send a test.
6. **Test orders.** Add two or three staff numbers as test numbers and have them order everything awkward:
   - a dish with sizes and add-ons
   - a weight dish
   - a pin outside the zones
   - a promo code
   - switching to pickup halfway
   - "same as last time" on a second order

   Move the orders along the board and check the WhatsApp messages.
7. **Go live.** Overview → **Go live** (the owner can press it once every required step is green).

## The first week

- Watch the **Inbox** "Needs you" tab: the agent flags anything it should not handle alone.
- In **Orders**, accept quickly. Customers see each step.
- In **Analytics**, "commission saved" is the number to show them at renewal.
- Hand them the growth kit:
  - a QR code on packaging and tables
  - the `wa.me` link in their Instagram bio and Google Maps listing
  - one WhatsApp-only offer

## Roles to explain

| Role | Can |
|---|---|
| Owner | Everything, including the team, the WhatsApp number and going live |
| Manager | Menu, offers, branches, zones, settings, reports |
| Staff | Orders, the inbox (take over, reply), stock switches, "too busy", the agent ON/OFF switch. Branch staff see only their branch's orders |
