# Running Everwake Orders

## The restaurant's switches

| Switch | Where | What the customer experiences |
|---|---|---|
| **Agent ON / OFF** | Top bar, every page | OFF: one warm apology per person, and they are remembered. ON: everyone remembered gets "we're back, you can order now" (optional, staggered) |
| **Too busy** (15 min – 2 h) | Branches | The agent says that branch is too busy right now and offers another open one; it resumes by itself |
| **Taking orders** | Branches | Same, until switched back |
| **Out of stock** (1 h / today / until switched back) | Menu, per dish, all branches or one | The agent stops offering it at once and takes it out of open carts |
| **Take over / Hand back** | Inbox | The agent stays quiet while a person has the chat. After handing back (or after the idle time in Settings → Ordering) it continues, knowing what the person said |
| A reply typed on the restaurant's phone | — | Logged in the inbox as a team reply; by default it takes the chat over |

## Watching the platform

```sql
-- what the agent did, per turn (tokens, repairs, tools, timing)
select created_at, wa_id, order_stage, qa_passed, repair_used, duration_total_ms, prompt_tokens + completion_tokens as tokens
from everwake.agent_events where tenant_id = '<id>' order by created_at desc limit 50;

-- messages that could not be sent (also shown in the inbox)
select created_at, purpose, to_jid, last_error from everwake.outbox where status = 'failed' order by created_at desc;

-- restaurants whose WhatsApp has gone quiet (a disconnected phone)
select t.name_en, c.instance_name, c.last_inbound_at from everwake.whatsapp_channels c
join everwake.tenants t on t.id = c.tenant_id where t.status = 'live' and c.last_inbound_at < now() - interval '6 hours';

-- who changed what from the dashboard
select created_at, user_id, action, entity, detail from everwake.audit_log where tenant_id = '<id>' order by created_at desc limit 50;
```

Housekeeping runs every minute from the Outbox workflow:
- idle takeovers return to the agent
- stuck locks and stuck sends are freed
- expired "out of stock until…" dishes come back

## What a conversation costs

Price the plans from real numbers, not guesses:

```sql
-- model tokens per placed order, last 30 days
select t.name_en,
       sum(e.prompt_tokens + e.completion_tokens) / nullif(count(distinct o.id), 0) as tokens_per_order,
       count(distinct o.id) as orders
from everwake.agent_events e
join everwake.tenants t on t.id = e.tenant_id
left join everwake.orders o on o.tenant_id = e.tenant_id and o.placed_at > now() - interval '30 days' and o.status <> 'draft'
where e.created_at > now() - interval '30 days'
group by t.name_en;
```

The system prompts are identical across restaurants and come first in every call, so the model provider's prompt caching applies to all of them.

## Scaling

| Restaurants | Do |
|---|---|
| Up to ~10 | One n8n, the defaults |
| 10–30 | n8n in queue mode with 2–4 workers; Supabase's next compute size |
| 30+ | Consider moving the engine from n8n to a Node service. The logic is already in SQL functions and plain JS files with tests, so it ports without a rewrite |

The heavy reads are prepared ahead of time (the menu snapshot rebuilds only
when something changed), and every hot query has an index on `tenant_id`.

## Moving to the official WhatsApp Cloud API

Evolution is an unofficial connection: numbers can be banned. Move paying
restaurants to Meta's Cloud API (embedded signup).
- `whatsapp_channels` already has `provider = 'cloud_api'`, `cloud_phone_number_id` and `cloud_access_token`.
- The engine needs:
  - a second webhook (Meta's payload into the same Normalize shape)
  - the send nodes switched on `provider`
- Replies to customer-started chats are free on the Cloud API; only the broadcasts you start are paid. The "we're back" message is a reply only within 24 hours of the customer's last message, so an older pause needs an approved template.

## Moving Seagull, Bazooka and 5 Roosters over

Each client becomes a restaurant on the platform. A few hours each:

1. **Sign them up** (`/new`, or as platform admin) and connect a *new* Evolution instance for their number (step 4 in SETUP).
   - Keep the old workflow active until the switch.
   - Then point the old instance's webhook at the new address. Use the same instance name in the dashboard and the history carries on.
2. **Bring everything over** with `everwake.import_legacy_schema` (`database/tools/import_legacy.sql`). Copy the old schema into the platform database first, then run the importer as the database owner:
   ```sh
   pg_dump "$OLD_DB" -n seagull --no-owner | psql "$NEW_DB"
   psql "$NEW_DB" -f database/tools/import_legacy.sql
   psql "$NEW_DB" -c "select jsonb_pretty(everwake.import_legacy_schema('<tenant id>', 'seagull'))"
   ```
   What it copies:

   | From the old schema | Becomes |
   |---|---|
   | `branches` | Branches, keyed by the old ids, with hours, fees, minimum, VAT, the kitchen WhatsApp |
   | `max_delivery_km` | A delivery circle per branch, so delivery works as before until real zones are drawn |
   | `menu_snapshot` | The menu with the **same dish codes** (M001…), every choice level, each branch's own prices, what a branch does not sell |
   | `menu_media` | The menu pages (only those with a public web address) |
   | `settings` and the snapshot's settings | The agent's name, facts, contacts, payment methods, kitchen WhatsApp, the order-number prefix. Only fills what the restaurant has not set itself |
   | `customers` | Customers, by number or by WhatsApp private id (read from the old messages) |
   | `orders` | Past orders, as finished (delivered, picked up or cancelled), so nothing rings on the board. Their addresses fill the address book. A number typed on an order is linked to the customer |
   | `messages` | The last 90 days of messages, so the inbox and the agent see the history |

   The order numbers carry on: after `SG-1043` the next order is `SG-1044`. Returning customers are recognised and "same as last time" rebuilds their last order from today's menu, from the first message.

   It returns a report: what came over, plus what to check next (a branch without readable hours, menu pages still on the old storage, the agent's English name). Running it again is safe: imported rows are matched, not duplicated. Options, as a third argument:
   - `'{"messages_days": 30}'`: how much message history to bring
   - `'{"orders": false}'` or `'{"zones": false}'`: skip that part
   - `'{"menu": false}'`: keep a menu already made in the dashboard. A restaurant that already has a menu is refused unless you pass this or `'{"force_menu": true}'`

   No old schema, or a menu that changed a lot? Import their current menu PDF with the AI instead.
3. **Check zones, offers and the agent's name**, add a test number, place test orders, then switch the webhook and press **Go live**.

## Backups

Supabase takes daily backups (point-in-time recovery on paid plans). The
engine keeps no state of its own. n8n holds only the workflows, which are
generated from this repository.
