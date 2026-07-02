# Self-Hosted Deployment — Client's Own Server

This is the production runbook for putting the **entire stack** (Node backend + PostgreSQL/pgvector + the chat widget + the admin dashboard) on the **client's own server**, so that:

- The **chat widget** appears on the client's website pages.
- The **admin dashboard** is available at a private, token-protected URL.
- **No demo pages or demo landing screens are exposed.**

---

## 1. What the visitor sees (the goal)

| Who | What they get | How |
|-----|---------------|-----|
| Website visitor | The chat bubble in the corner of the client's pages | The embed snippet (Step 9) loads the widget |
| Client / support team | The admin dashboard (conversations + leads) | Private URL `/admin/` + admin token |
| Anyone else | Nothing | Demo files are not deployed; admin needs a token |

The widget is **not a page** — it is injected into whatever page carries the snippet. There is no public "chatbot page" and no demo screen in production.

---

## 2. Architecture (one server)

```
                        client's server
  ┌──────────────────────────────────────────────────────┐
  visitor ──HTTPS──►  Nginx  ─/api/──►  Node backend (:3000)
  browser            (TLS)   ─/widget/─►  static widget files
                             ─/admin/──►  static admin files
                                              │
                                              ▼
                                     PostgreSQL 16 + pgvector
  ┌──────────────────────────────────────────────────────┐
```

Everything runs on this one machine. Nginx is the only thing exposed to the internet; it forwards API calls to Node and serves the static widget/admin files.

---

## 3. What ships vs what does NOT ship

**Deploy ONLY these (production):**

| Path | Purpose |
|------|---------|
| `backend/` (minus `.env`, `node_modules`) | The API + ingestion + migrations |
| `frontend/widget/ease-chatbot-left.js` | The chat widget |
| `frontend/widget/ease-chatbot-left.css` | The widget styles |
| `frontend/admin/` (all files) | The admin dashboard |

**Do NOT deploy these (demo / dev only):**

| Path | Why it's excluded |
|------|-------------------|
| `frontend/index.html` | Demo landing card ("Open Admin / Open Widget Demo") |
| `frontend/widget/demo.html` | Standalone demo page |
| `DEMO-VIDEO-SCRIPT.md`, `*.docx`, `PROJECT_OVERVIEW.md`, `EasePetVet-Chatbot-Overview.md` | Internal docs |
| `docker-compose.yml` | Only if you use managed Postgres instead of Docker |

The demo files are excluded **two ways** for safety: (a) don't copy them to the server, and (b) the Nginx config in Step 8 only routes `/widget/`, `/admin/`, and `/api/` — nothing else is reachable even if a stray file exists.

---

## 4. Server prerequisites

- Linux server (VPS/dedicated) the client controls, public IP, a domain or subdomain pointed at it (e.g. `easepetvet.com` or `chat.easepetvet.com`).
- **Node.js >= 18** (`backend/package.json` `engines`).
- **PostgreSQL 16 with the `pgvector` extension** (the app stores embeddings as vectors — pgvector is mandatory). Easiest: the Docker image `pgvector/pgvector:pg16`.
- **Nginx** for reverse proxy + TLS.
- Outbound internet (backend calls Groq/Gemini/OpenAI).
- At least one **chat API key** (Groq recommended) and one **embedding API key** (OpenAI).

---

## 5. Deploy step by step

### STEP 1 — Get the code on the server

```bash
git clone <your-repo-url> easepetvet
cd easepetvet
```

Copy only what's needed if you prefer, but keep `backend/` and `frontend/widget/` + `frontend/admin/`. `node_modules/` and `.env` are gitignored — you create them on the server.

### STEP 2 — Start PostgreSQL (pgvector)

**Before starting, change the dev password** in `docker-compose.yml` (`POSTGRES_PASSWORD`) to a strong one. Then:

```bash
docker compose up -d postgres
```

Postgres is now on host port **5433** (mapped to container 5432). The pgvector extension is included in this image.

> Native Postgres alternative: install PostgreSQL 16, create the database, and run `CREATE EXTENSION vector;`. The migration in Step 5 also enables it.

### STEP 3 — Install backend dependencies

```bash
cd backend
npm ci
```

### STEP 4 — Create the backend `.env`

```bash
cp .env.example .env
```

Edit `.env` for production. Minimum required:

```bash
NODE_ENV=production
PORT=3000

# Database (match Step 2)
PGHOST=localhost
PGPORT=5433
PGUSER=easepetvet
PGPASSWORD=<strong password from Step 2>
PGDATABASE=easepetvet

# AI providers (at least one chat key + the embedding key)
GROQ_API_KEY=<key>
OPENAI_API_KEY=<key>

# Encrypt saved emails/phones at rest (long random string)
DATA_ENCRYPTION_KEY=<random>

# Admin dashboard login token (long random string)
ADMIN_DASHBOARD_TOKEN=<random>

# The client's real domain(s) — browser CORS allowlist. Match exactly, incl. www.
CHAT_WIDGET_ALLOWED_ORIGINS=https://easepetvet.com,https://www.easepetvet.com
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # DATA_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ADMIN_DASHBOARD_TOKEN
```

> If `ADMIN_DASHBOARD_TOKEN` is left blank, the admin routes are disabled and `/admin/` cannot log in. Set it.

### STEP 5 — Create the database schema

```bash
npm run migrate:up
```

Builds all tables and enables the `vector` extension.

### STEP 6 — Load the website content (one time)

```bash
npm run ingest:create-jobs && npm run ingest:process && npm run embeddings:generate
```

Crawls easepetvet.com, stores the pages, and generates embeddings (uses `OPENAI_API_KEY`). Re-run when the site content changes materially, or enable the monthly auto re-sync in `.env` (`ADMIN_SYNC_AUTO_ENABLED=true`).

### STEP 7 — Run the backend as an always-on service

```bash
npm install -g pm2
pm2 start src/server.js --name easepetvet-api
pm2 save
pm2 startup      # follow the printed command so it restarts on reboot
```

Backend now listens on `localhost:3000`. (A `systemd` unit works equally well.)

### STEP 8 — Nginx: expose ONLY widget, admin, and API

This config serves only the three needed paths. The demo landing and demo page are **not routed**, so they are unreachable even if present on disk.

```nginx
server {
  listen 80;
  server_name easepetvet.com www.easepetvet.com;   # or chat.easepetvet.com

  root /path/to/easepetvet/frontend;

  # 1) API + chat + admin endpoints -> Node backend
  location /api/ {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # 2) Widget files (CSS/JS) — public, loaded by the client's pages
  location /widget/ {
    # Only serve the two real widget assets; block demo.html explicitly.
    location = /widget/demo.html { return 404; }
    try_files $uri =404;
  }

  # 3) Admin dashboard — reachable, but useless without the token
  location /admin/ {
    try_files $uri $uri/ /admin/index.html;
  }

  # 4) Everything else (incl. the demo landing index.html) -> not found
  location / {
    return 404;
  }
}
```

Then add HTTPS (required — the widget loads on an https page):

```bash
sudo certbot --nginx -d easepetvet.com -d www.easepetvet.com
sudo nginx -t && sudo systemctl reload nginx
```

Public URLs after this:

- `https://easepetvet.com/widget/ease-chatbot-left.js`
- `https://easepetvet.com/widget/ease-chatbot-left.css`
- `https://easepetvet.com/admin/`
- `https://easepetvet.com/api/chat/health`

### STEP 9 — Point the admin dashboard at the API

Edit `frontend/admin/index.html` so the admin talks to this same server (it currently defaults to the old Render URL):

```html
<script>
  window.EASE_ADMIN_API_BASE =
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? ''
      : 'https://easepetvet.com';   // <-- this server's public origin
</script>
```

### STEP 10 — Embed the widget in the client's website pages

Add this to the client's site. Because the stack is same-origin, all URLs are `easepetvet.com`:

```html
<link rel="stylesheet" href="https://easepetvet.com/widget/ease-chatbot-left.css">

<script>
  window.EASE_CHATBOT_LEFT_CONFIG = {
    apiBaseUrl: 'https://easepetvet.com',
    websiteBaseUrl: 'https://easepetvet.com',
    position: 'bottom-right',
    theme: 'light',
    emailLinkMode: 'gmail'
  };
</script>

<script src="https://easepetvet.com/widget/ease-chatbot-left.js" defer></script>
```

**Where to paste it (add once, appears on every page ONLY when the site uses a shared template):**

| Client site type | Where to add the snippet |
|------------------|--------------------------|
| WordPress | Theme header / a "header scripts" plugin (once) |
| Shopify / Wix / Squarespace | Site-wide "custom code / header injection" (once) |
| PHP with an include | The shared `header.php` (once) |
| React / Next / Vue | The root layout component (once) |
| Loose static `.html` files (no shared layer) | Paste into **each** `.html` file |

### STEP 11 — Verify

1. `https://easepetvet.com/api/chat/health` -> JSON `status: ok`.
2. Open a real client page -> chat bubble appears -> ask a question -> real answer from site content.
3. `https://easepetvet.com/admin/` -> enter `ADMIN_DASHBOARD_TOKEN` -> conversations load.
4. Confirm the demo is gone: `https://easepetvet.com/` and `https://easepetvet.com/widget/demo.html` both return **404**.
5. If the widget loads but questions fail with a CORS error -> the origin in `CHAT_WIDGET_ALLOWED_ORIGINS` must match the page's origin exactly (including `www`).

---

## 6. Ongoing maintenance

- **Restart on reboot:** handled by `pm2 startup` (Step 7).
- **Content refresh:** re-run Step 6, or set `ADMIN_SYNC_AUTO_ENABLED=true` for monthly auto re-sync.
- **TLS renewal:** certbot auto-renews; confirm the timer with `systemctl list-timers | grep certbot`.
- **Logs:** `pm2 logs easepetvet-api`.
- **Secrets:** keep `.env` off git (already gitignored). Rotating `DATA_ENCRYPTION_KEY` makes existing encrypted emails/phones unreadable — do not change it after go-live.
- **Backups:** back up the Postgres volume/database regularly (it holds conversations, leads, and embeddings).

---

## 7. Handoff checklist

- [ ] Server has Node 18+, Postgres 16 + pgvector, Nginx.
- [ ] `docker-compose.yml` Postgres password changed from the default.
- [ ] `backend/.env` filled: DB creds, `GROQ_API_KEY`, `OPENAI_API_KEY`, `DATA_ENCRYPTION_KEY`, `ADMIN_DASHBOARD_TOKEN`, `CHAT_WIDGET_ALLOWED_ORIGINS`.
- [ ] `npm run migrate:up` ran successfully.
- [ ] Content ingested + embeddings generated.
- [ ] Backend running under pm2 (or systemd) and set to start on boot.
- [ ] Nginx routes only `/widget/`, `/admin/`, `/api/`; `/` and `/widget/demo.html` return 404.
- [ ] HTTPS certificate installed.
- [ ] `frontend/admin/index.html` `EASE_ADMIN_API_BASE` points at this server.
- [ ] Embed snippet added to the client's site template.
- [ ] All Step 11 checks pass.
