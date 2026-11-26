-- Share links. A share is public by its token alone (plus an optional password), so every query
-- that does not start from a token still names tenant_id.

CREATE TABLE IF NOT EXISTS shares (
  -- The token in /s/<token>: 128 random bits as base32.
  id text NOT NULL PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text,
  password_hash text,
  password_salt text,
  -- Null keeps the link until it is revoked.
  expires_at text,
  revoked_at text,
  view_count integer NOT NULL DEFAULT 0,
  download_count integer NOT NULL DEFAULT 0,
  last_viewed_at text,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_tenant ON shares (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS share_items (
  share_id text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  position integer NOT NULL,
  PRIMARY KEY (share_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_share_items_artifact ON share_items (tenant_id, artifact_id);
