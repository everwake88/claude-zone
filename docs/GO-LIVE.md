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

## Step 1 — Add your site to Cloudflare Pages

1. Create a free account at **[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)**.
2. In the left sidebar choose **Compute (Workers & Pages)** → **Create** →
   **Pages** tab → **Connect to Git**.
3. Authorise GitHub and pick the **claude-zone** repository.
4. Fill in the build settings **exactly** like this:

   | Field | What to enter |
   |---|---|
   | Production branch | `main` |
   | Framework preset | **None** |
   | Build command | **leave completely empty** |
   | Build output directory | `web` |

   > The output directory **must** be `web`. This is the one setting people get
   > wrong, and it produces a "page not found" when they do.

5. Click **Save and Deploy**.

After about a minute you get an address like
`https://claude-zone-abc.pages.dev`. **Open it.** If it loads, the website works
and the rest of this guide is just putting your own name on it.

> If your production branch is still `claude/jolly-darwin-i1bnww` rather than
> `main`, either select that branch here, or merge it to `main` first — Part 4
> of `docs/PUBLISH.md` explains how.

---

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

Once Cloudflare says everwake.tech is **Active**:

1. Go back to **Workers & Pages** → your project → the **Custom domains** tab.
2. Click **Set up a custom domain**, type `everwake.tech`, confirm.
3. Do it **a second time** for `www.everwake.tech`.

Cloudflare creates the DNS records itself, because it now runs your DNS. This is
exactly why we moved the nameservers — it makes this step one click instead of a
fight.

The padlock (HTTPS) is issued automatically and free, usually within a few
minutes.

**Open https://everwake.tech.** That is your website.

---

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
The build output directory is not `web`. Project → **Settings → Builds &
deployments** → fix it → **Retry deployment**.

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
