-- Lead capture: visitor contact details collected by the widget intro form
-- before chatting. One lead per chat session (unique session_id) so a resubmit
-- updates rather than duplicates. website_id/session_id are SET NULL on parent
-- delete so leads survive for follow-up even if the session is cleared.

CREATE TABLE chat_leads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  session_id BIGINT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  audience TEXT NOT NULL DEFAULT 'unknown'
    CHECK (audience IN ('vet', 'pet_parent', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One lead per session (NULLs are distinct in Postgres, so session-less leads
-- are still allowed). Enables INSERT ... ON CONFLICT (session_id) upsert.
CREATE UNIQUE INDEX idx_chat_leads_session ON chat_leads(session_id);
CREATE INDEX idx_chat_leads_email ON chat_leads(email);
CREATE INDEX idx_chat_leads_created_at ON chat_leads(created_at DESC);
