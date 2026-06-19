-- Initial schema for the EasePetVet chatbot knowledge base and chat runtime.
-- Raw SQL only. No ORM, no pgvector, no embeddings. page_chunks stores raw text.

-- Registered websites to crawl (e.g. easepetvet.com).
CREATE TABLE websites (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  base_url TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per URL crawl task. Sitemap URLs are filtered and inserted here as
-- individual jobs to be processed.
CREATE TABLE crawl_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  skip_reason TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (website_id, url)
);

CREATE INDEX idx_crawl_jobs_website_id ON crawl_jobs(website_id);
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs(status);

-- Crawled pages.
CREATE TABLE pages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  http_status INTEGER,
  fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (website_id, url)
);

CREATE INDEX idx_pages_website_id ON pages(website_id);
CREATE INDEX idx_pages_url ON pages(url);

-- Structured key/value facts extracted from a page.
CREATE TABLE page_facts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  fact_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_page_facts_page_id ON page_facts(page_id);

-- Retrieval chunks. Raw chunk_text only (no embeddings in MVP).
CREATE TABLE page_chunks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, chunk_index)
);

CREATE INDEX idx_page_chunks_page_id ON page_chunks(page_id);

-- A chat conversation.
CREATE TABLE chat_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'unknown'
    CHECK (audience IN ('vet', 'pet_parent', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages within a chat session.
CREATE TABLE chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);

-- Predefined template questions per audience.
CREATE TABLE template_questions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('vet', 'pet_parent')),
  question TEXT NOT NULL,
  answer TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Log of AI provider calls (used in a later phase; table only for now).
CREATE TABLE ai_provider_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  prompt TEXT,
  response TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
