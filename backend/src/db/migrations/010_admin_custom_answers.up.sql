-- Admin-authored custom Q&A overrides. When a user asks a matching question, the
-- chatbot returns the admin answer verbatim before running RAG/AI. Not training:
-- a manual override table. Normalized_question stores the corrected/normalized
-- form used for matching (the raw question is kept for display).

CREATE TABLE IF NOT EXISTS admin_custom_answers (
  id BIGSERIAL PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,

  question TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  answer TEXT NOT NULL,

  audience TEXT NOT NULL DEFAULT 'all'
    CONSTRAINT admin_custom_answers_audience_check
    CHECK (audience IN ('all', 'vet', 'pet_parent', 'unknown')),
  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT admin_custom_answers_status_check
    CHECK (status IN ('active', 'inactive')),
  priority INTEGER NOT NULL DEFAULT 100,

  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One answer per (website, normalized question, audience): blocks exact duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_custom_answers_unique_question
  ON admin_custom_answers (website_id, normalized_question, audience);

CREATE INDEX IF NOT EXISTS idx_admin_custom_answers_website_status
  ON admin_custom_answers (website_id, status);

CREATE INDEX IF NOT EXISTS idx_admin_custom_answers_priority
  ON admin_custom_answers (website_id, priority DESC);
