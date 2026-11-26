-- Opt-in platform module: oauth. An app enables it with `"modules": ["oauth"]` in its
-- migrations.manifest.json and `createPlatform({ mcp: {...} })`, which adds Better Auth's
-- `@better-auth/mcp` / `@better-auth/oauth-provider` 1.7.12 plugin so AI clients (Claude,
-- ChatGPT) can connect to the app's MCP endpoint with OAuth 2.1 (dynamic client registration,
-- authorization code + PKCE, refresh tokens). Apps that do not list the module never receive
-- these tables.
--
-- The `oauth*` tables keep the plugin's own model and field names (camelCase, like the core
-- Better Auth tables in 0001_better_auth.sql) because the plugin reads them by those names;
-- `createAuth` runs with `validateSchema`, so a drifted column fails the first auth request. References to
-- "user" cascade so the account deletion purge can delete the user row. `agent_grants` is the
-- platform's own table and follows platform naming.
--
-- These are account-level auth tables, not workspace data, so they carry no workspace_id.

CREATE TABLE IF NOT EXISTS oauthClient (
  id text NOT NULL PRIMARY KEY,
  clientId text NOT NULL UNIQUE,
  clientSecret text,
  clientDiscoveryId text,
  disabled integer DEFAULT 0,
  skipConsent integer,
  enableEndSession integer,
  subjectType text,
  scopes text,
  clientCredentialsScopes text DEFAULT '[]',
  userId text REFERENCES "user" (id) ON DELETE SET NULL,
  createdAt date,
  updatedAt date,
  name text,
  uri text,
  icon text,
  contacts text,
  tos text,
  policy text,
  softwareId text,
  softwareVersion text,
  softwareStatement text,
  redirectUris text NOT NULL,
  postLogoutRedirectUris text,
  backchannelLogoutUri text,
  backchannelLogoutSessionRequired integer,
  tokenEndpointAuthMethod text,
  applicationType text,
  jwks text,
  jwksUri text,
  grantTypes text,
  responseTypes text,
  requirePKCE integer,
  dpopBoundAccessTokens integer DEFAULT 0,
  referenceId text,
  metadata text
);

CREATE INDEX IF NOT EXISTS oauthClient_userId_idx ON oauthClient (userId);

CREATE TABLE IF NOT EXISTS oauthResource (
  id text NOT NULL PRIMARY KEY,
  identifier text NOT NULL UNIQUE,
  name text NOT NULL,
  accessTokenTtl integer,
  refreshTokenTtl integer,
  signingAlgorithm text,
  signingKeyId text,
  allowedScopes text,
  customClaims text,
  dpopBoundAccessTokensRequired integer DEFAULT 0,
  disabled integer DEFAULT 0,
  createdAt date,
  updatedAt date,
  policyVersion integer DEFAULT 1,
  metadata text
);

CREATE TABLE IF NOT EXISTS oauthClientResource (
  id text NOT NULL PRIMARY KEY,
  clientId text NOT NULL REFERENCES oauthClient (clientId) ON DELETE CASCADE,
  resourceId text NOT NULL REFERENCES oauthResource (identifier) ON DELETE CASCADE,
  metadata text,
  createdAt date,
  UNIQUE (clientId, resourceId)
);

CREATE INDEX IF NOT EXISTS oauthClientResource_clientId_idx ON oauthClientResource (clientId);
CREATE INDEX IF NOT EXISTS oauthClientResource_resourceId_idx ON oauthClientResource (resourceId);

CREATE TABLE IF NOT EXISTS oauthRefreshToken (
  id text NOT NULL PRIMARY KEY,
  token text NOT NULL UNIQUE,
  clientId text NOT NULL REFERENCES oauthClient (clientId) ON DELETE CASCADE,
  sessionId text REFERENCES "session" (id) ON DELETE SET NULL,
  userId text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  referenceId text,
  authorizationCodeId text,
  resources text,
  requestedUserInfoClaims text,
  expiresAt date NOT NULL,
  createdAt date NOT NULL,
  revoked date,
  rotatedAt date,
  rotationReplayResponse text,
  rotationReplayExpiresAt date,
  authTime date,
  confirmation text,
  scopes text NOT NULL
);

CREATE INDEX IF NOT EXISTS oauthRefreshToken_clientId_idx ON oauthRefreshToken (clientId);
CREATE INDEX IF NOT EXISTS oauthRefreshToken_sessionId_idx ON oauthRefreshToken (sessionId);
CREATE INDEX IF NOT EXISTS oauthRefreshToken_userId_idx ON oauthRefreshToken (userId);
CREATE INDEX IF NOT EXISTS oauthRefreshToken_authorizationCodeId_idx ON oauthRefreshToken (authorizationCodeId);

CREATE TABLE IF NOT EXISTS oauthAccessToken (
  id text NOT NULL PRIMARY KEY,
  token text NOT NULL UNIQUE,
  clientId text NOT NULL REFERENCES oauthClient (clientId) ON DELETE CASCADE,
  sessionId text REFERENCES "session" (id) ON DELETE SET NULL,
  userId text REFERENCES "user" (id) ON DELETE CASCADE,
  referenceId text,
  authorizationCodeId text,
  resources text,
  requestedUserInfoClaims text,
  refreshId text REFERENCES oauthRefreshToken (id) ON DELETE CASCADE,
  expiresAt date NOT NULL,
  createdAt date NOT NULL,
  revoked date,
  confirmation text,
  scopes text NOT NULL
);

CREATE INDEX IF NOT EXISTS oauthAccessToken_clientId_idx ON oauthAccessToken (clientId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_sessionId_idx ON oauthAccessToken (sessionId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_userId_idx ON oauthAccessToken (userId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_authorizationCodeId_idx ON oauthAccessToken (authorizationCodeId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_refreshId_idx ON oauthAccessToken (refreshId);

CREATE TABLE IF NOT EXISTS oauthConsent (
  id text NOT NULL PRIMARY KEY,
  clientId text NOT NULL REFERENCES oauthClient (clientId) ON DELETE CASCADE,
  userId text REFERENCES "user" (id) ON DELETE CASCADE,
  referenceId text,
  resources text,
  requestedUserInfoClaims text,
  scopes text NOT NULL,
  createdAt date NOT NULL,
  updatedAt date NOT NULL
);

CREATE INDEX IF NOT EXISTS oauthConsent_clientId_idx ON oauthConsent (clientId);
CREATE INDEX IF NOT EXISTS oauthConsent_userId_idx ON oauthConsent (userId);

CREATE TABLE IF NOT EXISTS oauthClientAssertion (
  id text NOT NULL PRIMARY KEY,
  expiresAt date NOT NULL
);

-- One row per (user, client) the user consented to. `generation` is the Better Auth consent
-- reference stamped on every token; revoking rotates it, so in-flight issuance for the old
-- generation is refused by the triggers below even if it races the revocation on another
-- Worker. `revoked_at` (epoch ms) rejects authorization requests issued before a revocation.
CREATE TABLE IF NOT EXISTS agent_grants (
  id text NOT NULL PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES oauthClient (clientId) ON DELETE CASCADE,
  generation text NOT NULL UNIQUE,
  scopes text NOT NULL CHECK (json_valid(scopes)),
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  revoked_at integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, client_id)
);

CREATE INDEX IF NOT EXISTS agent_grants_user_idx ON agent_grants (user_id, active);

-- A token is stored only for an active grant of the same generation and only with scopes the
-- user granted. This is the authoritative check; the application checks are a fast path.
CREATE TRIGGER IF NOT EXISTS agent_grants_access_token BEFORE INSERT ON oauthAccessToken
WHEN NOT EXISTS (
  SELECT 1 FROM agent_grants g
  WHERE g.user_id = NEW.userId AND g.client_id = NEW.clientId
    AND g.generation = NEW.referenceId AND g.active = 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.scopes) s
      WHERE s.value NOT IN (SELECT value FROM json_each(g.scopes))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'inactive_agent_grant');
END;

CREATE TRIGGER IF NOT EXISTS agent_grants_refresh_token BEFORE INSERT ON oauthRefreshToken
WHEN NOT EXISTS (
  SELECT 1 FROM agent_grants g
  WHERE g.user_id = NEW.userId AND g.client_id = NEW.clientId
    AND g.generation = NEW.referenceId AND g.active = 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.scopes) s
      WHERE s.value NOT IN (SELECT value FROM json_each(g.scopes))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'inactive_agent_grant');
END;

-- Dynamic client registration is open to anyone; cap the table so it cannot be filled.
CREATE TRIGGER IF NOT EXISTS oauth_client_registration_limit BEFORE INSERT ON oauthClient
WHEN (SELECT count(*) FROM oauthClient) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'agent_registration_limit');
END;
