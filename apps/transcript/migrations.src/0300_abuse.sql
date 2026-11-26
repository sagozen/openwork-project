-- Job abuse blocks. Copy of packages/platform/sql/abuse_blocks.sql (the canonical SQL read by the
-- platform tests); keep the two in step.
--
-- A row blocks one subject (a tenant, a guest id or an IP) from creating jobs until
-- `blocked_until` (NULL means until an admin releases it). Released rows stay as history.
CREATE TABLE IF NOT EXISTS abuse_blocks (
  id text NOT NULL PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('tenant', 'guest', 'ip')),
  subject_id text NOT NULL,
  reason text NOT NULL,
  detail_json text NOT NULL DEFAULT '{}',
  source text NOT NULL CHECK (source IN ('auto', 'admin')),
  blocked_until text,
  cancelled_jobs integer NOT NULL DEFAULT 0,
  created_by text,
  created_at text NOT NULL,
  released_at text,
  released_by text
);

CREATE INDEX IF NOT EXISTS abuse_blocks_subject_idx ON abuse_blocks (subject_kind, subject_id, released_at);
CREATE INDEX IF NOT EXISTS abuse_blocks_created_idx ON abuse_blocks (created_at DESC);
