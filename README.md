# Rabbit Rabbi Awards

A working awards-voting site: public ballot, single-use ballot tokens, PostgreSQL storage, and a password-protected admin dashboard with live results, open/close controls and CSV export.

**Stack:** Node 20+ · Express · PostgreSQL (`pg`) · plain HTML/CSS/JS (no build step).

## Put it online for free, from your phone

You need three free accounts: **GitHub** (holds the code), **Neon** (holds the votes), **Render** (runs the site). No credit card is needed for any of them.

### 1. Make the admin password hash
The site stores only a scrypt hash of the admin password, never the password. Ask Claude for the `ADMIN_PASSWORD_HASH=...` line for your password, or run `npm run hash` on any computer. Keep it handy.

### 2. Create the database (Neon)
1. Sign up at neon.tech and create a project (any name; pick the region nearest you).
2. On the project page, copy the **connection string** (starts with `postgres://`). This is your `DATABASE_URL`.

Tables are created automatically the first time the site starts.

### 3. Put the code on GitHub
1. Sign up at github.com and create a **new repository** (private is fine).
2. Upload the project files (unzip first; do not upload `node_modules` or `.env`). The GitHub mobile website's "Add file → Upload files" works for this. If folder upload is awkward on your phone, ask Claude to guide you or to push it for you.

### 4. Deploy (Render)
1. Sign up at render.com with your GitHub account.
2. **New → Blueprint**, pick the repository. Render reads `render.yaml` and creates a free web service.
3. When asked, paste the two secrets: `DATABASE_URL` (from Neon) and `ADMIN_PASSWORD_HASH` (from step 1).
4. Wait for the deploy to finish. Your site is at `https://rabbit-rabbi-awards.onrender.com` (or similar), with HTTPS included. Admin login: `/admin`.

**Free-tier behavior:** Render's free service goes to sleep after ~15 minutes without visitors, and the next visitor waits about a minute for it to wake. Votes are safe, because they live in Neon, not on Render. To avoid the wake-up delay on voting day, add a free monitor at uptimerobot.com that pings `https://YOUR-SITE/api/health` every 5 minutes.

Neon's free plan also pauses an idle database and wakes it on the next request (about a second). Nothing is lost.

## Run locally (computer)

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL and ADMIN_PASSWORD_HASH
npm run hash             # prompts for the admin password, prints the hash line
npm start                # http://localhost:3000
```

Any Postgres works: Neon, Supabase, or a local install.

- Voting page: `/`
- Admin login: `/admin` (small "Admin" link in the footer)
- Tests: `TEST_DATABASE_URL=<an empty disposable database> npm test` (**erases that database**)

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. Store as a host secret. |
| `ADMIN_PASSWORD_HASH` | **Yes** | scrypt hash from `npm run hash`. Store as a host secret. |
| `ADMIN_PASSWORD` | No | Alternative to the hash (hashed in memory at startup). Prefer the hash. |
| `NODE_ENV` | Recommended | `production` enables `Secure` cookies and HSTS. |
| `TRUST_PROXY` | Yes behind a host/proxy | `1` on Render/Railway/Fly/nginx/Caddy so rate limits see real visitor addresses. |
| `PORT` | No | Default `3000` (hosts set this for you). |
| `VOTING_DEFAULT` | No | `open` (default) or `closed`, used only the first time the database is created. |

## Editing categories, nominees and photos

Everything lives in **`config/awards.js`**: add people once, then list them per category (any number of nominees, 2 or more). Redeploy or restart to apply.

**Photos:** add `<id>.jpg|png|webp` to `public/img/nominees/` (for example `griffin.jpg`). Without a photo, a colored initials badge is shown. Square images around 300×300 work best.

> Once voting has started, do not change category or person **ids**, because votes are stored by id. Display names can change any time.

## Backups and recovery

```bash
npm run backup                            # backups/rabbit-rabbi-<timestamp>.json
npm run restore -- backups/<file>.json    # re-adds any missing ballots; never deletes
```

Take a backup right before closing voting and keep the file somewhere safe. Neon also keeps a short history you can restore from in its dashboard. The admin dashboard's **Export CSV** gives you the results at any time.

## How voting is protected

- **Single-use ballot tokens.** Each browser gets a random token in an HttpOnly cookie; only its SHA-256 hash is stored. Submitting checks "voting open", consumes the token and writes the ballot in **one database transaction**, so double-clicks, retries and parallel requests create at most one ballot. The "open?" check takes a row lock that closing voting also needs, so no ballot can be saved after the admin closes voting.
- **Reopening voting** never revives a used token and never touches saved ballots.
- Every ballot is **validated on the server** (all 8 categories, each nominee must belong to its category).
- **Rate limiting** on ballot submission, on new-token issuance, and on login (5 wrong passwords locks that address out for 15 minutes).
- **No IP addresses are stored.** Addresses are used only in memory for rate limits.
- **Admin:** scrypt password check, random 8-hour session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in production, stored hashed), CSRF token on every write, same-origin checks, strict Content-Security-Policy. Every admin API route is protected, and the dashboard page and script are only served to a signed-in admin.
- Public API responses never include counts, leaders, or individual ballots.

**Honest limitation:** with no accounts, nothing can guarantee one vote per real person. Clearing cookies or switching browsers/devices gets a new ballot token. The tokens and rate limits stop casual repeats and scripts, not a determined person. If that matters, add a shared access code or a CAPTCHA (not included).

## Project layout

```
config/awards.js      categories + nominees (edit this)
render.yaml           one-click Render blueprint (free plan)
server/awards.js      config validation + ballot validation
server/db.js          schema, atomic ballot submission, results
server/auth.js        admin password, sessions, lockout, CSRF
server/index.js       routes, security headers, rate limits
public/               voting site, admin login, CSS/JS, fonts
private/              dashboard (served only to a signed-in admin)
scripts/              hash-password.js, backup.js, restore.js
test/app.test.js      automated acceptance tests
```
