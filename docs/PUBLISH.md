# Getting your website online

Written for someone who has never used GitHub or published a website. Follow it
in order. Total time: about 30 minutes, once.

Your website is currently **code in a repository**. Nobody can see it yet. By
the end of this guide it will be live at a real web address.

---

## Part 0 — The words you will keep seeing

| Word | What it actually means |
|---|---|
| **Repository** (or "repo") | A folder of your project that keeps every version you ever saved. Yours is called `claude-zone`. |
| **Branch** | A separate copy of the folder where changes are made before they become official. Yours is `claude/jolly-darwin-i1bnww`. |
| **Commit** | Saving a change, with a note about what you changed. |
| **Push** | Uploading your saved changes to GitHub. |
| **Pull request** | Asking for changes on a branch to be merged into the main version. |
| **Main** | The official, current version of your project. |
| **Deploy** | Copying your website onto a server so the public can open it. |

---

## Part 1 — Get the website on your own computer

### 1.1 Install GitHub Desktop

Forget the command line. GitHub Desktop is a normal app with buttons.

1. Go to **[desktop.github.com](https://desktop.github.com)** and download it.
2. Install and open it.
3. Sign in with your GitHub account (create one free at
   [github.com/signup](https://github.com/signup) if you do not have one).

### 1.2 Download your project

1. In GitHub Desktop: **File → Clone repository**.
2. Choose **everwake88/claude-zone** from the list.
3. Pick where to save it on your computer. Note the folder — you will open it often.
4. Click **Clone**.

You now have the whole website on your computer.

### 1.3 Switch to the right branch

At the top of GitHub Desktop there is a button called **Current branch**.

1. Click it.
2. Choose **claude/jolly-darwin-i1bnww**.

This is where your website currently lives. (After Part 4 you will work on
`main` instead.)

### 1.4 Look at it

Open the project folder, go into `web`, and double-click `index.html`. Your
website opens in your browser. It is working — it is just only on your computer.

---

## Part 2 — Make your first change

Let's add your email address.

1. Open the project folder → `web` → `site-config.js`.
   Open it with **Notepad** (Windows), **TextEdit** (Mac) or, better,
   **[VS Code](https://code.visualstudio.com)** — free and much easier to read.
2. Find `email: ""` and put your address between the quotes:
   `email: "hello@everwake.com"`.
3. Save the file.
4. Refresh `index.html` in your browser. Your email is now in the footer.

### Saving the change properly

Go back to GitHub Desktop. It is already showing what you changed.

1. Bottom left, in the **Summary** box, type what you did:
   `Add company email address`.
2. Click **Commit to claude/jolly-darwin-i1bnww**.
3. Click **Push origin** at the top.

Your change is now safely on GitHub. If you ever break something, you can come
back to this exact point.

> **Do this every time you change anything.** Commit, then push. It takes ten
> seconds and it means you can never lose work.

---

## Part 3 — Put it on the internet

We will use **Netlify**. It is free, it is the standard choice for a site like
yours, and it gives you a working address in about three minutes.

### Option A — The fast way (no GitHub needed)

Good for seeing it live right now.

1. Go to **[app.netlify.com/drop](https://app.netlify.com/drop)**.
2. Drag your **`web` folder** onto the page.
3. Done. You get an address like `https://random-name-123.netlify.app`.

The catch: every time you change something you must drag the folder again.

### Option B — The proper way (recommended)

Netlify watches GitHub and updates your site automatically every time you push.

1. Create a free account at **[netlify.com](https://netlify.com)** — sign up
   *with GitHub*, which saves a step.
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub**, then authorise Netlify, then pick **claude-zone**.
4. On the settings screen, enter exactly this:

   | Field | What to enter |
   |---|---|
   | Branch to deploy | `main` (or `claude/jolly-darwin-i1bnww` for now) |
   | Build command | **leave completely empty** |
   | Publish directory | `web` |

   > The publish directory **must** be `web`, not blank. That is the folder your
   > website actually lives in. This is the single most common mistake.

5. Click **Deploy**.

After about a minute your site is live. From now on, every time you push from
GitHub Desktop, Netlify rebuilds the site by itself. You do nothing.

### Giving it a proper name

1. In Netlify: **Site configuration → Change site name**.
2. Type `everwake`. Your address becomes `https://everwake.netlify.app`.

---

## Part 4 — Making this the official version

Right now your work sits on a branch. To make it the main version of the project:

1. Go to **github.com/everwake88/claude-zone** in your browser.
2. You will see a yellow bar: *"claude/jolly-darwin-i1bnww had recent pushes"*.
   Click **Compare & pull request**.
3. Click **Create pull request**, then **Merge pull request**, then **Confirm**.
4. Back in GitHub Desktop: **Current branch → main**, then **Fetch origin**.

From now on you can work directly on `main`.

---

## Part 5 — Your own domain name

`everwake.netlify.app` works, but `everwake.com` is what you want on a proposal.

1. **Buy the domain.** [Namecheap](https://namecheap.com),
   [Cloudflare](https://cloudflare.com) or [GoDaddy](https://godaddy.com).
   Roughly $10–15 a year.
2. In Netlify: **Domain management → Add a domain** → type `everwake.com`.
3. Netlify shows you some **nameservers** — two or more addresses.
4. Go to where you bought the domain, find **Nameservers**, and replace what is
   there with the ones Netlify gave you.
5. Wait. It usually takes an hour, occasionally up to a day.

Netlify adds the padlock (HTTPS) automatically and free. You do not need to buy
an SSL certificate from anyone.

### Email on your domain

Buying `everwake.com` does **not** give you `hello@everwake.com`. That is a
separate service:

- **Google Workspace** — about $6/user/month, what most businesses use.
- **Zoho Mail** — has a free tier for one domain. Good enough to start.

Set it up, then put the address in `site-config.js`.

---

## Your routine from now on

Every change you ever make follows the same four steps:

1. **Edit** the file on your computer and save it.
2. **Check** it by opening `web/index.html` in your browser.
3. **Commit** in GitHub Desktop with a short note about what you changed.
4. **Push**.

Netlify updates the live site within a minute. That is the whole workflow.

---

## If the site will not open at all ("can't reach this page")

If your browser says **ERR_CONNECTION_TIMED_OUT** or *"took too long to respond"*,
that is **not** a problem with your website. A broken deploy shows a
*"Page not found"* message from Netlify. A timeout means your browser never
reached Netlify in the first place.

`netlify.app` is one shared address used by millions of websites. Some internet
providers — this is reported in Egypt — block the whole of `netlify.app` because
of other people's sites on it. Your site is live; you just cannot see it from
your own connection.

### Step 1 — Find out whether it is only you

**Open the link on your phone with Wi-Fi switched off, using mobile data.**

| Result | What it means | What to do |
|---|---|---|
| It loads | Your Wi-Fi, router or office network is blocking it | Step 2 |
| It does not load | Your internet provider blocks `netlify.app` | Step 3 |

Also check your Netlify dashboard. If **Deploys** shows a green **Published**,
the website is genuinely online.

### Step 2 — It is your local network

- Try a different browser, and try a private/incognito window.
- Turn off any VPN, ad-blocker or security extension and retry.
- Change your computer's DNS to Cloudflare: `1.1.1.1` and `1.0.0.1`.
- Restart your router.

### Step 3 — Your provider blocks netlify.app

You have three good options. All are free.

**Option A — Use your own domain (best, and you need it anyway).**
`everwake.com` is a different address from `netlify.app`, so a block on the
shared domain does not apply to it. Follow Part 5 above. This also stops you
ever sending a client a link with `netlify.app` in it, which never looks
professional on a proposal.

**Option B — Move to Cloudflare Pages.** Different company, different domain
(`pages.dev`), strong presence in the Middle East.

1. Create a free account at [pages.cloudflare.com](https://pages.cloudflare.com).
2. **Create a project → Connect to Git →** choose `claude-zone`.
3. Settings:

   | Field | Value |
   |---|---|
   | Framework preset | **None** |
   | Build command | **leave empty** |
   | Build output directory | `web` |

4. **Save and Deploy.**

Nothing in the project needs changing — `web/_redirects` and `web/_headers`
already configure Cloudflare exactly as they configure Netlify.

**Option C — GitHub Pages.** Served from `github.io`, which is almost never
blocked because developers everywhere depend on it.

1. On github.com open your repository → **Settings → Pages**.
2. Under **Source**, choose **GitHub Actions**.
3. Push to `main`. The included workflow publishes `web/` automatically.

Your address becomes `https://everwake88.github.io/claude-zone/`.

> **One catch with GitHub Pages:** the site sits in a sub-folder, so a few links
> may need adjusting. Tell me if you choose this one and I will fix them.

### Which should you pick?

Get the domain (**Option A**) — it solves this permanently and you need it for
client-facing work regardless. If you want something working this afternoon
while the domain is being set up, do **Option B** as well. You can run both at
once; they do not conflict.

---

## When something goes wrong

**The page will not open at all / connection timed out.**
See the section above — this is a network block, not a broken website.

**The site looks broken / unstyled after I edited something.**
You probably deleted a quote mark, a comma or a bracket in `site-config.js`.
In GitHub Desktop, right-click the file in the changes list and choose
**Discard changes**. You are back to the last working version.

**My change is not showing on the live site.**
Check in order: did you commit? did you push? Then open Netlify and look at
**Deploys** — it tells you if the deploy failed and why.

**The agent bubble does not appear.**
That is deliberate until it is configured. See the agent section of
`docs/EDITING.md`.

**The agent appears but every message fails.**
Almost always CORS on your n8n webhook. See the same section.

**I have broken everything and I want yesterday's version back.**
Nothing is ever lost. On github.com open your repository, click **Commits**,
find a point where things worked, and you can restore it. Ask me and I will walk
you through it.
