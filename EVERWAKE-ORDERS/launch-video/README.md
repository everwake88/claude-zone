# Launch videos

| File | Length | What it is |
|---|---|---|
| `everwake-orders-film.mp4` | 3:38 | **The full film.** The real dashboard, every feature, with music |
| `everwake-orders-vertical.mp4` | 0:59 | **The vertical cut** for Reels, TikTok and WhatsApp Status, in Egyptian Arabic |
| `everwake-orders-launch.mp4` | 0:46 | The short teaser, drawn rather than filmed |
| `everwake-sales-agent.mp4` | 1:38 | **The AI sales agent** (WhatsApp and Instagram) for LinkedIn: for any e-commerce brand and the agencies that serve them |

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

```sh
node render-film.cjs --page sales-agent.html                # everwake-sales-agent.mp4
node render-film.cjs --page sales-agent.html --stills 40,70 # still-40.png …
```

No footage needed. The music is `music.py`'s calm style (100 BPM, D major,
soft drums, no claps), quiet enough to sit under the captions.

## The teaser

`video.html` and `render.cjs`: a 46-second piece drawn in HTML (no footage
needed). `node render.cjs` writes `everwake-orders-launch.mp4`.

## Dish photos

The showcase restaurant has no dish photos, so the film shows the menu with
its photo placeholders and leaves out the agent sending a dish's photo. With
real photos (one per dish), add them in the menu's Photos tab during capture
and the film can show both.
