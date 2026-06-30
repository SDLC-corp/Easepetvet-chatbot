# EasePetVet Chatbot — Project Overview

A website-grounded (RAG) chatbot for **easepetvet.com**. It crawls the live
website, builds a searchable knowledge base, and answers visitor questions using
only that content — never inventing facts. It ships with an embeddable chat
widget, an admin dashboard, lead capture, and a self-service re-sync pipeline.

- **Backend:** Node.js (>= 18), Express, raw SQL on PostgreSQL + `pgvector`. No ORM.
- **Frontend:** Dependency-free vanilla JS/CSS — an embeddable widget and an admin dashboard.
- **AI:** Pluggable embedding + chat-completion providers with automatic fallback.

---

## 1. What the chatbot does

1. A visitor opens the chat widget on the website.
2. They pick an audience (pet parent / vet) and optionally leave their name,
   email and phone (lead capture).
3. They ask a question in natural language.
4. The backend classifies the question, retrieves the most relevant content from
   the crawled site, and generates a grounded answer with source links.
5. If nothing on the site is relevant, it honestly replies that it doesn't know
   instead of hallucinating.
6. Every conversation is stored and viewable in the admin dashboard.

---

## 2. Architecture at a glance

```
Website (easepetvet.com)
        │  crawl via sitemap
        ▼
┌──────────────────────────────────────────────┐
│ INGESTION  sitemap → URLs → fetch → extract → │
│            clean → chunk → facts → store      │
└──────────────────────────────────────────────┘
        │                       │
        ▼                       ▼
   page_chunks            page_facts / pages
        │
        ▼
┌──────────────────────────────────────────────┐
│ EMBEDDINGS  chunk text → vectors (pgvector)   │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│ RETRIEVAL  classify question → fact / page /  │
│            vector / full-text search          │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│ ANSWER  provider chain (Groq→Gemini→…) or     │
│         deterministic retrieval-only          │
└──────────────────────────────────────────────┘
        │
        ▼
   Chat widget  +  Admin dashboard
```

---

## 3. Ingestion pipeline (building the knowledge base)

Located in `backend/src/ingestion/`. Nothing auto-runs — it is driven by scripts.

| Stage | File | What it does |
|-------|------|--------------|
| Sitemap read | `sitemap-reader.js` | Reads `sitemap_index.xml`, recurses into child sitemaps |
| URL collect | `url-collector.js` | Collects all page URLs |
| URL filter | `url-filter.js` | Drops non-content URLs (applied only to final page URLs) |
| Job create | `crawl-job-creator.js` | Inserts one `crawl_jobs` row per URL |
| Fetch | `page-fetcher.js` | Fetches HTML, respecting a configurable crawl delay (default 10s) and timeout |
| Extract | `html-extractor.js` | Parses HTML (cheerio): title, meta description, H1, main text |
| Clean | `text-cleaner.js` | Normalizes whitespace / boilerplate |
| Chunk | `chunk-creator.js` | Splits clean text into overlapping retrieval chunks |
| Facts | `fact-extractor.js` | Pulls structured facts (see below) |

**Structured facts extracted per page** (`fact-extractor.js`): links, images,
videos (tagged with the nearest heading so answers can deep-link to a section),
CTAs/buttons, pricing snippets, FAQ Q&A pairs, emails, phone numbers, and
headings. Each fact type has a cap and is de-duplicated by URL or by text.

The orchestrator `ingestion.service.js` runs fetch → extract → clean → chunk →
facts → store per job and records each job's final status
(`completed` / `failed` / `skipped`). Failures and non-HTML responses are handled
gracefully and never abort the whole run.

**Run it via npm scripts:**
```
npm run ingest:create-jobs    # collect URLs into crawl jobs
npm run ingest:process        # process pending jobs
npm run ingest:status         # job counts by status
npm run ingest:reprocess      # re-run targeted jobs
```

---

## 4. Embeddings (semantic search)

Located in `backend/src/embeddings/`. Stored in `pgvector`, dimension-agnostic.

- **Active provider:** OpenAI (`text-embedding-3-small`, 768 dims). A legacy
  Gemini provider is also wired in and switchable via `EMBEDDING_PROVIDER`.
- Batch generation with rate-limit handling: retries 429/5xx with 10s/20s/40s
  backoff, waits between batches, and can stop and resume safely if the provider
  becomes unavailable (re-run to continue the remaining chunks).
- **Coverage gating:** vector search is only trusted once embedding coverage is
  >= `EMBEDDING_MIN_COVERAGE` (default 0.95) with no missing/stale rows.
  Otherwise the system falls back to full-text search.
- The backend and full-text retrieval run **without** an API key; the key is only
  needed to generate or query embeddings.

```
npm run embeddings:generate   # embed chunks needing it
npm run embeddings:status     # coverage report
npm run embeddings:test       # try a similarity query
npm run embeddings:reset      # clear embedding rows
```

---

## 5. Retrieval (finding the right answer)

`backend/src/retrieval/`. **Read-only and never fabricates** — unmatched queries
return `found: false` with empty results.

**Question classification** (`question-detector.js`) — pure, rule-based, no AI.
It routes each question to one of:

- **smalltalk** — greetings / thanks / goodbye, answered instantly with no DB call.
- **fact** — email, phone, pricing, links, images, videos, CTAs, headings, FAQ,
  canonical / OG tags. Email & phone are looked up site-wide; others are scoped
  to a page slug where possible.
- **page-attribute** — single page values: H1, title, meta description, page URL
  (e.g. "give me the vets page link" returns that page's own URL).
- **chunk** — open-ended questions; the default route. Includes a special
  **overview** intent ("what does this site do?") that pins the homepage.

**Search strategy** (`retrieval.service.js`):

1. Slug/keyword match resolves a target page; its chunks are searched first.
2. Otherwise **vector search** runs (when embeddings are ready).
3. Falls back to **full-text search**, then to an expanded-keyword full-text
   query for broad overview questions.
4. **Off-topic gate:** for open-ended questions, if embeddings are ready and the
   best similarity is below `EMBEDDING_MIN_SCORE`, the query is judged off-topic
   and returns nothing — this stops a stray keyword (e.g. "question" → FAQ page)
   from surfacing an irrelevant answer to nonsense input.
5. Low-value pages (privacy, login, cart, category, etc.) are filtered out unless
   the user explicitly asks about them.

---

## 6. Answer generation

`backend/src/chat/`. Two modes:

- **Deterministic (retrieval-only):** exact structured values (H1, links,
  canonical, etc.) and not-found cases are formatted without any LLM.
- **Conversational (LLM):** page chunks and pricing answers are passed to a chat
  provider for a natural-language reply grounded in the retrieved context.

**Provider fallback chain** (`provider-chain.js`, `ai-answer.service.js`):

```
Groq → Gemini → OpenRouter → Ollama → retrieval-only
```

- All providers use a shared OpenAI-compatible client.
- The first success wins. A provider with no API key is skipped; a failure
  (timeout, 429, auth, server error) **silently** falls through to the next — the
  visitor never sees a provider switch, only the server logs record it.
- A provider answer that is empty or just the canned "not found" line while
  retrieval actually has results is rejected, so questions that *do* have data
  always get answered consistently across repeats.
- Generation params are shared and configurable: `CHAT_MAX_COMPLETION_TOKENS`
  (400), `CHAT_TEMPERATURE` (0.2), `CHAT_TIMEOUT_MS` (20s).

Set `CHAT_ANSWER_MODE=retrieval_only` to disable LLMs entirely.

---

## 7. Conversation management & lead capture

`backend/src/chat/chat.service.js`, `lead.service.js`.

- **Sessions:** each conversation has a public session token persisted by the
  widget in `localStorage`, carrying the audience choice across messages.
- **Per-message limits:** messages over `CHAT_MAX_MESSAGE_CHARS` (800) or
  `CHAT_MAX_MESSAGE_WORDS` (120) are rejected before any storage/retrieval/AI.
- **Conversation cap:** `CHAT_CONVERSATION_MESSAGE_LIMIT` (20) questions per
  conversation. The limit-th question is still answered; the next is blocked with
  a friendly message that includes the support email (`CHAT_SUPPORT_EMAIL`).
- **Lead capture:** the widget intro form posts name/email/phone + audience to
  `POST /api/chat/lead`, linked to the session.
- **In-chat email prompt:** optionally asks for an email after the first message
  and every N messages (`CHAT_EMAIL_PROMPT_INTERVAL`), unless one is already saved.
- Each response carries a **usage** object (messages used/remaining, warning
  flag, whether to show the email prompt) that drives the widget UI.

---

## 8. Admin dashboard & automatic re-sync

`backend/src/admin/`, `backend/src/routes/admin.routes.js`,
`frontend/admin/`.

- Every admin route requires a bearer token (`ADMIN_DASHBOARD_TOKEN`). Leaving
  the token blank disables the dashboard entirely.
- **Endpoints:** summary stats, paginated/searchable chat list (filter by
  audience and date range), full chat transcript detail, sync status, and a
  manual "run sync now" trigger.
- **Re-sync** (`sync.service.js`) reuses the ingestion + embedding pipeline to
  refresh the knowledge base. Runs are tracked in `website_sync_runs` and
  summarized on the `websites` row, with in-process + DB guards preventing two
  concurrent syncs. A sync runs in the background and returns `202` immediately.
- **Scheduler** (`sync-scheduler.js`): optional automatic ~monthly re-sync,
  configurable via `ADMIN_SYNC_AUTO_ENABLED` / `ADMIN_SYNC_INTERVAL_DAYS` /
  run hour/minute. Disabled by default.

---

## 9. Frontend

`frontend/widget/` and `frontend/admin/` — both dependency-free vanilla JS/CSS.

**Embeddable chat widget** (`ease-chatbot-left.js`, the shipped conversation-based widget):
- Self-contained, namespaced (`epv-chatbot-*`), no API keys in the browser.
- Configurable via a `window.EASE_CHATBOT_LEFT_CONFIG` object: API base URL,
  position, default audience, website base URL, email link mode.
- Conversation-based with **no upfront form**: starts anonymously, greets
  immediately, detects audience (Vet / Pet Parent / Not sure) from the
  conversation, and captures email/contact conversationally (via `/api/chat/email`)
  only when follow-up is needed.
- Floating launcher + chat panel, typewriter rendering, safe linkify, source
  links, usage/limit handling, and conversation reset.
- Reuses the shared `.epv-chatbot-*` styles from `ease-chatbot-widget.css`, so that
  stylesheet stays loaded alongside it.
- `ease-chatbot-widget.js` is retained as a legacy/form-based variant and
  shared-style reference, but it is **not** loaded in the final demo or production embed.
- A `demo.html` page is served for local testing.

**Admin dashboard** (`frontend/admin/`, ~270 lines JS): token login, summary
cards, chat browser with filters, and a sync control panel.

Both are served as static files by the backend:
- Widget: `http://localhost:3000/widget/demo.html`
- Admin: `http://localhost:3000/admin`

---

## 10. Data model (PostgreSQL)

Raw SQL migrations in `backend/src/db/migrations/` (8 migrations).

| Table | Purpose |
|-------|---------|
| `websites` | Registered sites to crawl |
| `crawl_jobs` | One row per URL crawl task (with status, retries, errors) |
| `pages` | Crawled pages (title, H1, meta description, clean text, raw HTML) |
| `page_facts` | Structured key/value facts per page |
| `page_chunks` | Retrieval chunks of clean page text |
| `page_chunk_embeddings` | pgvector embeddings (dimension-agnostic) |
| `chat_sessions` | A conversation, with audience + public token |
| `chat_messages` | User/assistant messages |
| `chat_leads` | Captured visitor contact details |
| `website_sync_runs` | Re-sync run history + summaries |
| `template_questions`, `ai_provider_logs` | Predefined questions / provider log |

Migrations run via `npm run migrate:up` / `migrate:down`.

---

## 11. HTTP API surface

| Method & path | Purpose |
|---------------|---------|
| `GET /health` | Liveness |
| `GET /api/chat/health` | Chat config + active provider chain |
| `POST /api/chat/message` | Ask a question (returns answer, sources, usage) |
| `POST /api/chat/lead` | Capture name/email/phone + audience |
| `POST /api/chat/email` | Attach an email to a session (in-chat prompt) |
| `GET /api/admin/summary` | Dashboard stats (token required) |
| `GET /api/admin/chats` | Paginated/filtered chat list |
| `GET /api/admin/chats/:sessionId` | Full transcript |
| `GET /api/admin/sync/status` | Sync + embedding + job status |
| `POST /api/admin/sync/run` | Trigger a background re-sync |

**CORS:** a no-dependency middleware allows only the origins listed in
`CHAT_WIDGET_ALLOWED_ORIGINS` (no wildcard); `file://` pages are allowed in
non-production for local widget testing.

---

## 12. Cross-cutting engineering choices

- **Grounded, never hallucinates:** every layer returns "not found" rather than
  inventing answers; found/sources stay consistent with the visible answer.
- **Graceful degradation:** works with no AI keys at all (full-text + deterministic
  formatting); each AI/embedding provider failure falls back silently.
- **No heavy dependencies:** raw SQL (no ORM), hand-rolled CORS/validation, vanilla
  JS frontend — small, auditable surface (backend deps: express, pg, cheerio,
  dotenv, pino).
- **Reusable:** retrieval and ingestion take `websiteId` as a parameter; nothing is
  hardcoded to a single page.
- **Observability:** structured Pino logging, plus dev-only end-to-end traces of how
  each question resolved (retrieval type → provider → final found) without logging
  any secrets.
- **Config-driven:** all limits, providers, models, crawl delays, prompt cadence and
  thresholds live in environment variables (see `backend/.env.example`).

---

## 13. Running it locally

```bash
# 1. Start PostgreSQL (with pgvector)
docker compose up -d                 # exposes postgres on localhost:5433

# 2. Backend
cd backend
npm install
cp .env.example .env                 # fill in API keys as needed
npm run migrate:up
npm run ingest:create-jobs
npm run ingest:process               # crawl + build knowledge base
npm run embeddings:generate          # (optional) enable semantic search
npm start                            # serves API + widget + admin on :3000

# 3. Try it
#    Widget: http://localhost:3000/widget/demo.html
#    Admin:  http://localhost:3000/admin   (needs ADMIN_DASHBOARD_TOKEN)
```
