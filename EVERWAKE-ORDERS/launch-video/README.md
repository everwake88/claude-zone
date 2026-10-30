# Launch videos

| File | Length | What it is |
|---|---|---|
| `everwake-orders-film.mp4` | 3:38 | **The full film.** The real dashboard, every feature, with music |
| `everwake-orders-vertical.mp4` | 0:59 | **The vertical cut** for Reels, TikTok and WhatsApp Status, in Egyptian Arabic |
| `everwake-orders-launch.mp4` | 0:46 | The short teaser, drawn rather than filmed |
| `everwake-sales-agent.mp4` | 1:38 | **The AI sales agent** (WhatsApp and Instagram) for LinkedIn: for any e-commerce brand and the agencies that serve them |
| `everwake-sales-agent-4x5.mp4` | 1:38 | The same film in 4:5 (1080×1350) for LinkedIn on phones |
| `everwake-desk.mp4` | 1:47 | **The desk** in 4:5 for LinkedIn: comments and DMs answered by the AI, then one desk that runs the human team |

The film and the teaser are 1920×1080, the vertical cut 1080×1920; all 30 fps. The music and sounds are generated (`music.py`),
so there is nothing to license. The restaurant in them, "بيت المشويات" (Grill
House), its customers and its numbers are made up — the showcase restaurant in
`database/tools/showcase_restaurant.sql`.

## The full film

| Time | Scene |
|---|---|
| 0:00 | A phone filling with WhatsApp orders at 9:47 on a Friday → *Your WhatsApp, taking orders.* |
| 0:10 | The agent, on the customer's phone: an order by **voice note**, then a **photo** of the menu with a dish circled, a **location pin**, the summary, a **payment link** and the paid page |
| 0:41 | The order **rings in live** on the board: opened, accepted with a delivery time, a driver picked, out for delivery |
| 1:02 | The **driver's app**: the route to her door |
| 1:10 | The **inbox**: what the agent heard and saw, a **question** it asks the team, a manager **taking over** an unhappy customer and handing back |
| 1:38 | **Overview**: what WhatsApp saved this month |
| 1:43 | The **menu**: out of stock for today, a dish's choices and branch prices, a branch's own menu, **menu pictures** designed from it, a **spreadsheet import** |
| 2:12 | **Branches** (a "too busy" pause) and **delivery zones** (testing spots on the map) |
| 2:30 | **Table bookings** and **customers** |
| 2:40 | **Get customers** (links, QR codes and what each brought) and **offers** |
| 2:49 | **Analytics**, and the sales missed |
| 2:59 | **Settings**: the agent, automatic messages, Paymob, the daily report |
| 3:09 | The whole dashboard in **Arabic** |
| 3:15 | The **agent switch**: off with an apology, on with "we're back" |
| 3:29 | Everwake |

Every dashboard frame is a screenshot of the real dashboard, filmed by
[`capture/`](capture/README.md); the film page adds the browser window, the
camera moves, the cursor, the captions and the customer's phone.

### Changing it

- **Words, timing, camera:** `film.html` — the timeline is one block of
  `show(...)` calls, scene by scene. Open the page in a browser to preview it.
- **The footage:** refilm with `capture/` (its README says how), then render again.
- **The music:** `music.py` — tempo, chords, and the sections it follows.

```sh
node render-film.cjs                       # the film (about 25 minutes)
node render-film.cjs --stills 12,45.5      # still-12.png … to check moments
node render-film.cjs --from 40 --to 60     # a preview of part of it
```

Needs Node, Playwright with Chromium, ffmpeg, and Python 3 with numpy. The
footage (`capture/shots/`, about 45 MB) is not committed — film it first.

## The vertical cut

59 seconds, 1080×1920, captions in professional Egyptian Arabic. The screen is
split: the Arabic dashboard on top, the customer's WhatsApp below, so every
click shows what it sends the customer at that moment — accept and the
confirmation arrives, "out for delivery" and the driver's name and number
arrive, the agent switched off and every waiting customer gets the apology.
Those messages are the system's real automatic-message templates.

The script, scene by scene, with the voice-over lines and notes for the
voice, is in [`vertical-script.md`](vertical-script.md).

```sh
FILM_LANG=ar SHOTS_DIR=shots-ar node capture.mjs     # in capture/: the Arabic footage
node render-film.cjs --page vertical.html            # everwake-orders-vertical.mp4
node render-film.cjs --page vertical.html --voice vo.wav   # with a voice-over, the music ducking under it
```

The voice file should run the full 59.5 seconds, each line starting at its
time in the script.

## The AI sales agent film

1920×1080, for LinkedIn. Not Everwake Orders: the chat sales agent, shown for
any store. Everything in it is made up: Volta Home, Bloom Beauty, the
customers, products, prices and the month's numbers. The dashboard is
white-labelled ("YOUR BRAND"), drawn after the real one and filled with that
made-up data. The captions carry the story, so it works with the sound off,
the way LinkedIn plays it.

| Time | Scene |
|---|---|
| 0:00 | Messages flood in at 11:47 PM → *Your best salesperson never sleeps.* |
| 0:07 | A **voice note** in Gulf Arabic: heard, understood (pet hair, mop, budget), answered with three options inside the budget and one question |
| 0:16 | A **photo** from an influencer's story, Egyptian Arabic: matched to the catalogue, in stock, priced |
| 0:25 | **Dialects**: the same question in Gulf, Egyptian, Levantine and English, each answered in kind |
| 0:32 | **The close**: a sales plan beside the chat; the price objection handled without a discount, one upsell, the payment link, paid (+40% basket) |
| 0:46 | **Order updates** along a timeline, then an **abandoned cart** reminded in the evening window and recovered |
| 0:59 | The **dashboard**: conversations from both channels, a customer handed to the team, the team's reply arriving on his phone, handed back to the AI |
| 1:11 | **Campaigns**: best customers ranked, an approved template, test run off, approved, sent; an opt-out confirmed |
| 1:23 | A month's results (demo data) |
| 1:29 | Everwake: AI sales agents for E-commerce: your social channels + your online store + any dialect or language, *Book a free demo* |

What the agent says follows the method on the website's agent page (a price
ladder inside the budget, one question at a time, objections answered without
discounting, one upsell). Shots follow the video skills in `.claude/skills/`:
one direction of travel, cut-the-curve between scenes, an inverse zoom only for
the dashboard's and the end's arrival, an oversized cursor whose clicks cause
what happens next.

The 4:5 cut is the same page opened with `?format=45`: the same scenes and
text sizes, with what sat side by side stacked (the dashboard shows one panel at
a time, the list sliding away as the chat comes in).

```sh
node render-film.cjs --page sales-agent.html                # everwake-sales-agent.mp4
node render-film.cjs --page sales-agent.html --format 45    # everwake-sales-agent-4x5.mp4
node render-film.cjs --page sales-agent.html --stills 40,70 # still-40.png …
```

No footage needed. The music is `music.py`'s calm style (100 BPM, D major,
soft drums, no claps), quiet enough to sit under the captions.

## The desk film

1080×1350 (4:5), for LinkedIn. Everwake's AI agents plus the desk where the
human team works, shown for any electronics or retail store. The desk on screen
is the real one (`2b-desk`), filmed in demo mode in Everwake's colours; the
store ("Volta Electronics"), the customers, agents, orders and numbers are all
made up. How the screens were filmed, and how to film them again, is in
`desk-capture/README.md`.

| Time | Scene |
|---|---|
| 0:00 | Messages from WhatsApp, Messenger and Instagram pour into one tray → *Your customers write everywhere. Your team answers from one place.* |
| 0:06 | A **Facebook post**: three comments, each answered publicly within seconds, each in different words |
| 0:15 | The **DM** that follows: the price once, specs turned into reasons, one question, two options inside the budget; handed to the team as a sale |
| 0:27 | **How it fits**: every channel → the AI agent → sales / complaint / order tracking / inquiry → the desk → Ready agents, least busy first, never more than 25 each; replies go back to the customer's app |
| 0:38 | An agent goes **Ready** and the sale lands in her queue |
| 0:46 | The **AI's note** on top of the chat, her reply typed and sent |
| 0:54 | **The 15-minute rule**: reminders at 5 and 8 minutes, the chat moves at 10 and every minute after, LATE at 15 and the team lead alerted |
| 1:08 | **Teamwork**: a complaint handed to a colleague with a note; he accepts |
| 1:16 | The **live floor** for team leads: who is ready, who is busy, what is waiting |
| 1:23 | **Track a late reply**: every agent it passed through, and why each didn't answer |
| 1:33 | **Reports**: first-reply time, on-time rate, by source and category, per agent |
| 1:40 | Everwake: *AI agents that sell. A desk that runs your team.* *Book a free demo* |

The 15-minute chain is drawn rather than filmed (in the real desk it takes 15
minutes); everything else is the desk's own screens. The desk rules shown
(Ready only, least busy first, 25 at most, reminders at 5 and 8, moving at 10,
late at 15) are the desk's real ones. The AI's replies follow the Meta comments
and DM agent: a public reply in rotating wording, then one private message, then
the sales method (price once, specs into reasons, a budget question, two
options).

```sh
node render-film.cjs --page desk.html                # everwake-desk.mp4 (4:5)
node render-film.cjs --page desk.html --stills 30,60 # still-30.png …
```

The music is `music.py`'s calm style, with the drums dropping out for the
15-minute rule.

## The teaser

`video.html` and `render.cjs`: a 46-second piece drawn in HTML (no footage
needed). `node render.cjs` writes `everwake-orders-launch.mp4`.

## Dish photos

The showcase restaurant has no dish photos, so the film shows the menu with
its photo placeholders and leaves out the agent sending a dish's photo. With
real photos (one per dish), add them in the menu's Photos tab during capture
and the film can show both.
