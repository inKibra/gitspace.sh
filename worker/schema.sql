-- gitspace.sh D1 Database Schema

-- Users (via GitHub OAuth)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                    -- uuid
  github_id TEXT UNIQUE NOT NULL,
  github_username TEXT NOT NULL,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);

-- CLI Tokens (one user can have multiple devices)
-- SECURITY: Tokens are hashed before storage. Only prefix is stored for display.
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,                    -- SHA256 hash of full token
  prefix TEXT NOT NULL,                   -- First 12 chars for display: "gst_abc12345"
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT,
  device_fingerprint TEXT,                -- Machine identity public key
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                     -- Optional expiration (90 days recommended)
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_prefix ON tokens(prefix);

-- Portal sessions (stored in D1, not KV, to avoid write limits)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                    -- session ID (random UUID)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,            -- created_at + 7 days
  ip_address TEXT,                        -- For audit trail
  user_agent TEXT                         -- For audit trail
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Encrypted user-root identity backups (ciphertext only)
CREATE TABLE IF NOT EXISTS identity_backups (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  owner_user_root_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Subdomains (users can have MULTIPLE subdomains)
-- Free tier: 3 subdomains max
-- Paid tier: 10 subdomains max
CREATE TABLE IF NOT EXISTS subdomains (
  id TEXT PRIMARY KEY,                    -- uuid
  subdomain TEXT UNIQUE NOT NULL,         -- "brad" (not full domain)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tunnel_id TEXT NOT NULL,                -- Cloudflare tunnel UUID
  dns_record_ids TEXT NOT NULL,           -- JSON array of DNS record IDs for cleanup
  custom_hostname_id TEXT,                -- Cloudflare for SaaS hostname ID (for *.subdomain.gitspace.sh)
  tunnel_token_encrypted TEXT NOT NULL,   -- Encrypted tunnel token
  status TEXT NOT NULL DEFAULT 'active',  -- active, suspended, deleted
  is_primary INTEGER DEFAULT 0,           -- 1 = Primary subdomain for this user
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subdomains_user ON subdomains(user_id);
CREATE INDEX IF NOT EXISTS idx_subdomains_status ON subdomains(status);

-- Reserved subdomains (cannot be claimed by users)
CREATE TABLE IF NOT EXISTS reserved_subdomains (
  subdomain TEXT PRIMARY KEY,
  reason TEXT NOT NULL                    -- e.g., "system", "offensive", "trademark"
);

-- Pre-populate reserved subdomains
INSERT OR IGNORE INTO reserved_subdomains (subdomain, reason) VALUES
  ('api', 'system'), ('www', 'system'), ('admin', 'system'),
  ('mail', 'system'), ('ftp', 'system'), ('relay', 'system'),
  ('static', 'system'), ('cdn', 'system'), ('auth', 'system'),
  ('login', 'system'), ('status', 'system'), ('docs', 'system'),
  ('help', 'system'), ('support', 'system'), ('billing', 'system'),
  ('app', 'system'), ('dashboard', 'system'), ('console', 'system'),
  ('git', 'system'), ('ssh', 'system'), ('sftp', 'system'),
  ('test', 'system'), ('dev', 'system'), ('staging', 'system'),
  ('prod', 'system'), ('production', 'system');

-- Subdomain access (who can connect to your relay) - future feature
CREATE TABLE IF NOT EXISTS subdomain_access (
  id TEXT PRIMARY KEY,
  subdomain_id TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,              -- Public key of authorized client
  label TEXT,
  permissions TEXT NOT NULL,              -- JSON: {read, write, manage}
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subdomain_access_subdomain ON subdomain_access(subdomain_id);
CREATE INDEX IF NOT EXISTS idx_subdomain_access_identity ON subdomain_access(identity_id);
