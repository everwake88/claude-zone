# Desk capture

The screens in `desk.html` are the real desk (the `2b-desk` app), run in demo
mode and filmed with Playwright. Nothing in them belongs to a client: the
desk is dressed in Everwake's colours and mark, the store is a made-up one
("Volta"), and every customer, agent, order and number is invented.

`film/` holds what the page uses: the screenshots as JPEGs (2160×2700, twice
the 4:5 frame) and `boxes.js`, where things sit on each screenshot, so the
camera and the cursor land on the right button. With `film/` committed, the
film renders without running the desk.

## Filming again

You need a checkout of the desk (branch
`claude/2b-reply-dashboard-ai-routing-oemmbt`), its `npm install` done in
`server/`, and a Postgres it can reach (`DATABASE_URL`, by default
`postgres://postgres@%2Ftmp:5433/desk_demo`). Keep that checkout outside this
repo: the dressing below edits it and must not go back to its branch.

```sh
./prepare.sh /path/to/2b-desk      # Everwake skin, "Volta" demo data, Youssef added
DESK=/path/to/2b-desk ./reset.sh   # fresh 2-day demo, desk on :8090
DESK_URL=http://localhost:8090 node capture.mjs          # all shots → shots/
DESK_URL=http://localhost:8090 node capture.mjs agent    # or one part: agent | super | admin
```

Run `reset.sh` before each take: it reseeds the demo, so earlier runs' chats
and Ready states don't leak in.

- `story.mjs`: the chats the film follows, sent the way the AI agent hands them
  over (`POST /api/ingest/handoff`): the laptop sale that started as a Facebook
  comment, the cracked-screen complaint, and the rest of the queue. Also the
  reply Nour types and her transfer note.
- `capture.mjs`: signs in as Nour (agent), Youssef (receives the transfer),
  Heba (supervisor) and admin, plays the story and saves each step to
  `shots/` with its boxes. On the Track page it picks the late chat that moved
  through the most agents.
- `everwake-skin.css`: the colours and the Arabic font, appended to the desk's
  stylesheet by `prepare.sh`.

Then copy what the film uses into `film/` (`shots/` is not committed):

```sh
for n in a0-not-ready a1-sale-arrives a2-queue a3-sale-open a4-typing a5-typed a6-sent \
         a10-transfer-filled y1-request y2-accepted s1-live s2-reports s3-reports-1 \
         s4-journey s5-journey-more; do
  ffmpeg -v error -y -i shots/$n.png -q:v 3 film/$n.jpg
done
cp shots/boxes.js shots/boxes.json film/
```

A new take moves things a little: check the Track scene's rings in `desk.html`
(the Sara and Yasmin cards are placed by hand) against the new `s4-journey`
and `s5-journey-more`.
