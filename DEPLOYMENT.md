# Deployment Guide — Backend on Render, Frontend on Vercel

This app has three parts:

| Part | What it is | Where it goes |
|------|-----------|---------------|
| **Backend** | Node/Express API (`backend/`) | **Render** (Web Service) |
| **Database** | PostgreSQL + pgvector | **Render** (Managed Postgres) |
| **Frontend** | Widget + Admin static files (`frontend/`) | **Vercel** |

## About Docker / PostgreSQL (important)

- **Docker is only for your local computer.** You used it to run Postgres while developing.
- **You do NOT deploy Docker anywhere.** On Render, you use **Render's Managed PostgreSQL**, which replaces your local Docker Postgres. Render runs the Node backend natively (no Docker needed).
- So after deploying, the live app uses Render's database — your local Docker stays on your machine for development only.

## Files that must be in the repo for deployment

- `backend/` — `package.json`, **`package-lock.json`** (required for `npm ci`), `src/` (incl. `src/db/migrations/`).
- `frontend/` — `admin/`, `widget/`, and `frontend/vercel.json`.
- `render.yaml` (repo root) — the Render blueprint.
- `.gitignore` — must keep ignoring `node_modules/` and `.env`.
- **Never commit `.env`** (it has secrets). Set secrets in the Render dashboard.

---

## STEP 1 — Push the code to GitHub

```bash
git add -A
git commit -m "Prepare for deployment"
git push origin main
```

---

## STEP 2 — Deploy the BACKEND + DATABASE on Render

**Option A — Blueprint (uses `render.yaml`, easiest):**
1. Render Dashboard → **New +** → **Blueprint**.
2. Connect this GitHub repo → Render reads `render.yaml` → **Apply**.
3. It creates the Postgres DB and the web service, and wires `DATABASE_URL` automatically.
4. Open the web service → **Environment** → fill the secret values (these are `sync:false`):
   - `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`, `OPENAI_API_KEY`
   - `ADMIN_DASHBOARD_TOKEN` (pick a long random string)
   - `CHAT_WIDGET_ALLOWED_ORIGINS` (fill after you know your Vercel URL — STEP 5)

**Option B — Manual:**
1. **New + → PostgreSQL** → create it. Copy its **Internal Database URL**.
2. **New + → Web Service** → connect repo:
   - Root Directory: `backend`
   - Build Command: `npm ci`
   - Start Command: `npm run migrate:up && npm start`
3. **Environment** → add: `NODE_ENV=production`, `DATABASE_URL=<internal url>`, all the API keys, `ADMIN_DASHBOARD_TOKEN`, `ADMIN_DASHBOARD_TIMEZONE=America/Chicago`, `CHAT_SUPPORT_EMAIL=support@easepetvet.com`, and `CHAT_WIDGET_ALLOWED_ORIGINS` (STEP 5).

On deploy, `npm run migrate:up` creates the schema + the `vector` extension automatically.

Your backend URL will look like: `https://easepetvet-backend.onrender.com`

---

## STEP 3 — Load the website data into the Render database

The schema is created by migrations, but the **website content + embeddings** must be loaded. Pick one:

**Option 1 — Re-ingest (simplest):** in the Render web service → **Shell**, run:
```bash
npm run ingest:create-jobs && npm run ingest:process && npm run embeddings:generate
```
(Re-crawls easepetvet.com and regenerates embeddings — uses your embedding API key.)

**Option 2 — Copy your local data (keeps existing embeddings):**
```bash
# on your machine (Docker Postgres running):
docker exec easepetvet-postgres pg_dump -U easepetvet -d easepetvet -Fc -f /tmp/epv.dump
docker cp easepetvet-postgres:/tmp/epv.dump ./epv.dump
# restore into Render (use the EXTERNAL database URL from Render):
pg_restore --no-owner -d "postgresql://...EXTERNAL_URL..." ./epv.dump
```

---

## STEP 4 — Deploy the FRONTEND on Vercel

1. Vercel → **Add New… → Project** → import this repo.
2. **Root Directory: `frontend`**, Framework Preset: **Other**, no build command (it's static).
3. Deploy. Your frontend URL will look like: `https://easepetvet-frontend.vercel.app`
   - Admin: `https://easepetvet-frontend.vercel.app/admin/`
   - Widget files: `https://easepetvet-frontend.vercel.app/widget/...`

---

## STEP 5 — Connect Frontend ↔ Backend (the 3 links)

1. **Tell the backend to trust the frontend (CORS).** On Render, set:
   ```
   CHAT_WIDGET_ALLOWED_ORIGINS=https://easepetvet-frontend.vercel.app,https://easepetvet.com,https://www.easepetvet.com
   ```
   (Include every site that loads the widget.) Save → Render redeploys.

2. **Point the ADMIN at the backend.** Edit `frontend/admin/index.html`:
   ```html
   <script>window.EASE_ADMIN_API_BASE = 'https://easepetvet-backend.onrender.com';</script>
   ```
   Commit + push → Vercel redeploys.

3. **Point the WIDGET at the backend.** On the page that embeds the widget (easepetvet.com), set:
   ```html
   <link rel="stylesheet" href="https://easepetvet-frontend.vercel.app/widget/ease-chatbot-widget.css">
   <link rel="stylesheet" href="https://easepetvet-frontend.vercel.app/widget/ease-chatbot-left.css">

   <script>
     window.EASE_CHATBOT_LEFT_CONFIG = {
       apiBaseUrl: 'https://easepetvet-backend.onrender.com',
       websiteBaseUrl: 'https://easepetvet.com',
       position: 'bottom-right',
       theme: 'light',
       defaultAudience: 'unknown',
       emailLinkMode: 'gmail'
     };
   </script>

   <script src="https://easepetvet-frontend.vercel.app/widget/ease-chatbot-left.js" defer></script>
   ```
   The shipped chatbot is the conversation-based `ease-chatbot-left.js` (no upfront form). The
   `ease-chatbot-widget.css` link must stay because the conversational widget reuses its shared
   `.epv-chatbot-*` styles. `ease-chatbot-widget.js` (the legacy form-based variant) is intentionally
   not loaded. (For the Vercel-hosted `demo.html`, also change its `apiBaseUrl` from `localhost:3000` to the Render URL.)

---

## STEP 6 — Test

1. Backend health: open `https://easepetvet-backend.onrender.com/api/chat/health` → should return JSON `status: ok`.
2. Admin: open the Vercel `/admin/`, enter the `ADMIN_DASHBOARD_TOKEN` → conversations should load.
3. Widget: open the page where it's embedded → ask a question → it should answer.
4. If the admin or widget shows network/CORS errors → re-check `CHAT_WIDGET_ALLOWED_ORIGINS` and the API base URLs.

## Notes
- Free Render services **sleep** (slow first request) and free Postgres **expires in 90 days** — use the **Starter** plan for production.
- Keep secrets in the Render dashboard, never in git.
