# Putting everwake.tech online with Cloudflare

Your situation: the domain **everwake.tech** is registered at **Hostinger**, and
`netlify.app` appears to be blocked on your connection. This guide moves the
site to **Cloudflare Pages** and puts it on your own domain, which solves both
problems at once.

Follow it in order. About 30 minutes of work, then up to a few hours of waiting.

---

## Why this plan

- **Cloudflare Pages** hosts the website. Free, fast, and not on the blocked
  `netlify.app` domain.
- **Cloudflare DNS** runs your domain. Free, and it is the only way to put
  `everwake.tech` itself (not just `www.`) on Pages cleanly.
- **Hostinger** stays your registrar — you still own the domain there and renew
  it there. You are only changing which company answers DNS questions about it.

You are not cancelling anything at Hostinger.

---

## ⚠️ Before you start — one thing that can break

**Do you use email on everwake.tech right now?** Anything like
`hello@everwake.tech` or `info@everwake.tech` set up through Hostinger?

- **No / not yet** → carry on, nothing to lose.
- **Yes** → stop and read this. Moving nameservers to Cloudflare means Cloudflare
  must be told about your email records (MX records) or **your email will stop
  arriving**. In Step 2 below, Cloudflare scans and copies your existing records
  automatically — but you must check the MX records survived before you switch.
  If you are unsure, tell me and I will walk you through it separately.

Also: if you have a website currently on Hostinger hosting at this domain, this
replaces it.

---

## Step 1 — Put the site on Cloudflare

Cloudflare currently shows one of two different setup screens. Both work — use
whichever you get.

### Screen A — "Set up your application / Configure your Worker project"

Three fields: the repository, **Project name**, and **Build command**.

| Field | What to enter |
|---|---|
| Project name | `everwake` |
| Build command | **leave completely empty** |

Then click **Deploy**. That is all.

There is no "output directory" box on this screen, and you do not need one —
the `wrangler.jsonc` file in the repository tells Cloudflare that the website is
in the `web/` folder. It is already committed, so Cloudflare reads it when it
clones the project.

> **Branch:** your repository's default branch is
> `claude/jolly-darwin-i1bnww`, and Cloudflare uses the default branch
> automatically. There is nothing to change.

### Screen B — the classic Pages screen

If instead you see a screen with **Framework preset** and **Build output
directory**, fill it in like this:

| Field | What to enter |
|---|---|
| Project name | `everwake` |
| Production branch | `claude/jolly-darwin-i1bnww` |
| Framework preset | **None** |
| Build command | **leave empty** |
| Build output directory | `web` |

### Either way

After about a minute you get an address ending in `.pages.dev`.
**Open it.** If the Everwake home page loads, hosting is done and the rest of
this guide is only about putting your own name on it.

**If you get a "page not found" or a file listing instead**, Cloudflare served
the wrong folder. On Screen A, check that `wrangler.jsonc` exists in your
repository. On Screen B, set the build output directory to `web` and redeploy.
Tell me what you see and I will sort it.

## Step 2 — Move everwake.tech to Cloudflare DNS

1. In Cloudflare, click **Add a domain** (top of the dashboard).
2. Type `everwake.tech` and continue.
3. Choose the **Free** plan.
4. Cloudflare scans your current DNS and shows what it found. **Look at this
   list.** If you have email on this domain, check that records of type **MX**
   are present. If they are missing, add them before continuing.
5. Cloudflare now shows you **two nameservers**, something like:

   ```
   dana.ns.cloudflare.com
   rick.ns.cloudflare.com
   ```

   **Keep this page open.** You need these in the next step.

---

## Step 3 — Point Hostinger at Cloudflare

1. Log in to **[hpanel.hostinger.com](https://hpanel.hostinger.com)**.
2. Go to **Domains** and click **everwake.tech**.
3. Find **DNS / Nameservers** (sometimes under *Domain settings*).
4. Choose **Change nameservers** → **Use custom nameservers**.
5. Delete what is there and paste the two Cloudflare addresses from Step 2.
6. **Save.**

Then go back to Cloudflare and click **Continue** / **Check nameservers**.

**Now you wait.** Usually 10–60 minutes, occasionally up to 24 hours. Cloudflare
emails you when the domain is active. There is nothing to do meanwhile.

---

## Step 4 — Attach the domain to your site

Once Cloudflare says everwake.tech is **Active**, the domain is on Cloudflare but
still shows whatever it showed before — for a Hostinger domain, that is the
"Registered at Hostinger" parking page. That is expected. Cloudflare copied
Hostinger's existing DNS record when it took the domain over, so it is faithfully
proxying you to Hostinger's parking server. Nothing is broken; the website simply
is not connected yet.

### 4a. Check the site itself is deployed

In the left sidebar go to **Compute (Workers & Pages)**. You should see a project
named `everwake` (or `claude-zone`).

- **No project there?** Step 1 did not complete. Go back and do it.
- **Project is there?** Open it and find its own address — it ends in
  `.workers.dev` or `.pages.dev`. **Open that address.**
  - The Everwake site loads → good, continue to 4b.
  - "Page not found" → Cloudflare is serving the wrong folder. Check that
    `wrangler.jsonc` is in the repository, then redeploy.

Do not continue until that address shows the website. Connecting a domain to a
project that is not working just moves the problem.

### 4b. Connect the domain — exact clicks

Your Worker is called **everwake** and lives at
`everwake.everwake88.workers.dev`. You are going to tell Cloudflare that
`everwake.tech` should serve it too.

**Route 1 — from the Worker (most reliable)**

1. Left sidebar → **Compute (Workers & Pages)**.
2. Click the **everwake** project.
3. Along the top, click **Settings**.
4. Scroll to the section called **Domains & Routes**. It currently lists only
   `everwake.everwake88.workers.dev`.
5. Click **+ Add** → choose **Custom domain**.
6. Type `everwake.tech` → **Add domain**.
7. Repeat from step 5 for `www.everwake.tech`.

**Route 2 — from the domain**

1. Left sidebar → **Back to Domains** → click **everwake.tech**.
2. On the **Overview** page, right-hand panel, under *"No Workers connected"*,
   click **Connect Worker**.
3. Choose **everwake**.

Either route does the same thing. If one is greyed out or missing, use the other.

### 4c. Let it replace the Hostinger record

Cloudflare will say something like *"An A record with the name everwake.tech
already exists"* and offer to **replace** it. **Confirm.** That record is the
one pointing at Hostinger's parking page, and it is what you are replacing.

If it refuses instead of offering, clear the record by hand first:

1. **DNS → Records.**
2. Find the row of type **A** with name `everwake.tech`, and the row for `www`.
3. **Delete** both.
4. Go back and add the custom domain again.

Deleting these is safe. They only point at a parking page. **Do not delete any
row of type MX, TXT or NS** — those are email and domain records.

### 4d. Set the encryption mode

1. Left sidebar → **SSL/TLS** → **Overview**.
2. If it shows **Automatic SSL/TLS**, click **Configure** and switch to
   **Custom SSL/TLS**.
3. Choose **Full (strict)** → **Save**.

Do this now. The wrong mode here is the usual cause of a "too many redirects"
error, which is much easier to prevent than to diagnose.

### 4e. Check it

Give it two or three minutes for the certificate, then open
**https://everwake.tech** in a **private/incognito window** — your normal
browser has the Hostinger parking page cached and will keep showing it.

## Step 5 — Tidy up

**Redirect www to the main address** so you have one canonical address:
In Cloudflare go to **Rules → Redirect Rules → Create rule**:

- Name: `www to apex`
- If: **Hostname** *equals* `www.everwake.tech`
- Then: **Dynamic redirect**, status **301**, expression:
  `concat("https://everwake.tech", http.request.uri.path)`

**Delete the Netlify site** if you are no longer using it, so nobody finds the
old copy. Netlify → Site configuration → Delete site. (Or keep it as a backup —
it costs nothing.)

---

## Step 6 — Email on your domain

`everwake88@gmail.com` works, but `hello@everwake.tech` is what belongs on a
proposal to a Gulf client.

Buying the domain does **not** include email. Options:

| Service | Cost | Notes |
|---|---|---|
| **Zoho Mail** | Free for 1 domain, 5 users | Best starting point |
| **Google Workspace** | ~$6/user/month | What most businesses use |
| **Hostinger email** | Varies | You may already have it included |

Whichever you choose, it gives you **MX records** to add in Cloudflare:
**DNS → Records → Add record**, type **MX**, with the values they give you.

Then update `web/site-config.js`:

```js
email: "hello@everwake.tech",
```

Commit, push, and the address updates across all six pages.

---

## Your routine from now on

1. Edit a file and save it.
2. **Commit** in GitHub Desktop with a short note.
3. **Push**.

Cloudflare rebuilds the live site within about a minute. Nothing else to do.

---

## If something is wrong

**"Page not found" on the pages.dev address.**
Cloudflare is serving the wrong folder. Either `wrangler.jsonc` is missing from
the repository, or (on the classic screen) the build output directory is not
set to `web`. Fix it, then **Retry deployment**.

**The domain still shows a Hostinger parking page.**
DNS has not propagated yet. Wait. To confirm what the world sees, check
[dnschecker.org](https://dnschecker.org) for `everwake.tech`.

**"Too many redirects" after adding the domain.**
In Cloudflare: **SSL/TLS → Overview** → set encryption mode to **Full (strict)**.
This is the classic cause.

**My email stopped working.**
The MX records did not come across. Cloudflare → **DNS → Records** → add the MX
records from your email provider. Tell me and I will help.

**The site loads but looks unstyled.**
A file did not upload. Check the **Deploys** log in Cloudflare for errors.
