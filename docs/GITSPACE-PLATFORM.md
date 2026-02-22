# gitspace.sh Platform Specification

> **Complete specification for the gitspace.sh hosting platform**

---

## Overview

gitspace.sh is a lightweight platform that gives developers instant hosting via Cloudflare Tunnels. Users reserve a subdomain, get a tunnel token, and `gssh machine serve start --foreground` handles the rest.

**Core Principles**:
- **Zero infrastructure for us** - Users run their own tunnels
- **Instant setup** - Reserve subdomain, start serving
- **Peer relay model** - One machine with subdomain can relay for others
- **E2E encryption** - Terminal access remains encrypted

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GITSPACE.SH PLATFORM                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   CLOUDFLARE (managed by gitspace.sh)                                       │
│   ────────────────────────────────────                                      │
│                                                                              │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│   │ Workers      │  │ Pages        │  │ D1           │  │ KV           │   │
│   │ (API)        │  │ (Portal)     │  │ (Database)   │  │ (Sessions)   │   │
│   │              │  │              │  │              │  │              │   │
│   │ api.         │  │ gitspace.sh  │  │ users        │  │ sessions     │   │
│   │ gitspace.sh  │  │              │  │ subdomains   │  │ (TTL: 7d)    │   │
│   │              │  │              │  │ tokens       │  │              │   │
│   └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│          │                                    │                              │
│          │         Cloudflare Tunnel API      │                              │
│          └────────────────┬───────────────────┘                              │
│                           │                                                  │
│                           ▼                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  DNS: gitspace.sh                                                    │   │
│   │  ├── brad.gitspace.sh      → tunnel-brad-xxx.cfargotunnel.com      │   │
│   │  ├── *.brad.gitspace.sh    → tunnel-brad-xxx.cfargotunnel.com      │   │
│   │  ├── sarah.gitspace.sh     → tunnel-sarah-xxx.cfargotunnel.com     │   │
│   │  └── *.sarah.gitspace.sh   → tunnel-sarah-xxx.cfargotunnel.com     │   │
│   │                                                                      │   │
│   │  SSL: Total TLS ($10/mo) - covers *.*.gitspace.sh                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                              │
│   USER'S MACHINES (user-owned, user-operated)                               │
│   ───────────────────────────────────────────                               │
│                                                                              │
│   Brad's MacBook (PRIMARY - has subdomain)                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  gssh machine serve start --foreground                                                          │   │
│   │  ├── cloudflared (tunnel: brad.gitspace.sh)                         │   │
│   │  ├── Local HTTP server (:8080)                                      │   │
│   │  │   ├── HTTP routes → services/Lima VMs                            │   │
│   │  │   └── WebSocket /ws → terminal (E2E encrypted)                   │   │
│   │  ├── Embedded relay (accepts connections from other machines)       │   │
│   │  └── tmux-lite server (PTY sessions)                                │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│         ▲                    ▲                                               │
│         │ WebSocket          │ WebSocket                                     │
│         │                    │                                               │
│   Brad's Work Desktop        Brad's Home Server                             │
│   (SECONDARY - no subdomain) (SECONDARY - no subdomain)                     │
│   ┌───────────────────┐      ┌───────────────────┐                          │
│   │ gssh machine serve start --foreground        │      │ gssh machine serve start --foreground        │                          │
│   │ --relay brad.     │      │ --relay brad.     │                          │
│   │   gitspace.sh     │      │   gitspace.sh     │                          │
│   └───────────────────┘      └───────────────────┘                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Authentication

gitspace.sh uses **GitHub as the identity provider**. Users can authenticate via:
- **Portal**: GitHub OAuth (redirect-based) for browser access
- **CLI**: GitHub Device Flow for terminal access

Both methods create/access the **same account** (keyed by GitHub user ID).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TWO ENTRY POINTS, ONE ACCOUNT                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PORTAL (Browser)                        CLI (Terminal)                    │
│   ────────────────                        ──────────────                    │
│                                                                              │
│   gitspace.sh                             $ gssh user auth login                 │
│   ┌─────────────────────┐                                                   │
│   │ Sign in with GitHub │                 ! Code: ABCD-1234                 │
│   └──────────┬──────────┘                 Open github.com/login/device      │
│              │                                       │                       │
│              ▼                                       ▼                       │
│   GitHub OAuth (redirect)                 GitHub Device Flow                │
│              │                                       │                       │
│              ▼                                       ▼                       │
│   Callback with token                     Poll for token                    │
│              │                                       │                       │
│              └───────────────┬───────────────────────┘                      │
│                              │                                               │
│                              ▼                                               │
│              ┌───────────────────────────────────────┐                      │
│              │  gitspace.sh API                      │                      │
│              │                                       │                      │
│              │  1. Verify GitHub token               │                      │
│              │  2. Get GitHub user ID                │                      │
│              │  3. Find or create account            │                      │
│              │     (keyed by GitHub ID)              │                      │
│              │  4. Return session/token              │                      │
│              └───────────────────────────────────────┘                      │
│                              │                                               │
│                              ▼                                               │
│              ┌───────────────────────────────────────┐                      │
│              │  Same account in D1:                  │                      │
│              │  {                                    │                      │
│              │    id: "uuid",                        │                      │
│              │    github_id: "12345",  ◄──────────── │ ── Unique identifier │
│              │    github_username: "brad",           │                      │
│              │    email: "...",                      │                      │
│              │  }                                    │                      │
│              └───────────────────────────────────────┘                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## User Flow

### 1. Sign Up / Login (Portal)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Browser: gitspace.sh                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                                                                      │   │
│   │                         gitspace.sh                                  │   │
│   │                                                                      │   │
│   │              Instant hosting for your dev environment               │   │
│   │                                                                      │   │
│   │                    ┌──────────────────────┐                         │   │
│   │                    │  Sign in with GitHub │                         │   │
│   │                    └──────────────────────┘                         │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   OAuth flow (redirect-based):                                              │
│   1. User clicks "Sign in with GitHub"                                      │
│   2. Redirects to GitHub OAuth authorize URL                                │
│   3. User authorizes gitspace.sh app                                        │
│   4. GitHub redirects to callback with code                                 │
│   5. API exchanges code for token, verifies user                            │
│   6. Creates/updates user in D1 (keyed by github_id)                        │
│   7. Sets session cookie, redirects to dashboard                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Sign Up / Login (CLI - GitHub Device Flow)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Terminal                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  $ gssh user auth login                                                          │
│                                                                              │
│  ! First, copy your one-time code: ABCD-1234                                │
│  Press Enter to open github.com in your browser...                          │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│  Browser: github.com/login/device                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │   Device Activation                                                  │   │
│  │                                                                      │   │
│  │   Enter the code displayed on your device:                          │   │
│  │                                                                      │   │
│  │   ┌──────────────────────────────────────┐                          │   │
│  │   │  ABCD-1234                           │                          │   │
│  │   └──────────────────────────────────────┘                          │   │
│  │                                                                      │   │
│  │                    ┌──────────┐                                     │   │
│  │                    │ Continue │                                     │   │
│  │                    └──────────┘                                     │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│  Browser: GitHub authorization page                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │   Authorize gitspace.sh                                              │   │
│  │                                                                      │   │
│  │   gitspace.sh by @gitspacesh                                        │   │
│  │   wants to access your account                                      │   │
│  │                                                                      │   │
│  │   This will allow gitspace.sh to:                                   │   │
│  │   • Read your profile information                                   │   │
│  │   • Read your email addresses                                       │   │
│  │                                                                      │   │
│  │              ┌──────────────────────┐                               │   │
│  │              │ Authorize gitspace.sh │                               │   │
│  │              └──────────────────────┘                               │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│  Terminal (after authorization):                                            │
│                                                                              │
│  ✓ Authentication complete                                                  │
│  ✓ Logged in as username                                                   │
│  ✓ Token saved to keychain                                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Device Flow Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  GITHUB DEVICE FLOW - DETAILED SEQUENCE                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  CLI                          GitHub                      gitspace.sh API   │
│   │                             │                              │            │
│   │ POST /login/device/code     │                              │            │
│   │ {client_id, scope}          │                              │            │
│   │────────────────────────────►│                              │            │
│   │                             │                              │            │
│   │◄────────────────────────────│                              │            │
│   │ {device_code, user_code,    │                              │            │
│   │  verification_uri, interval}│                              │            │
│   │                             │                              │            │
│   │ [Display code to user]      │                              │            │
│   │ [Open browser]              │                              │            │
│   │                             │                              │            │
│   │         [User visits github.com/login/device]              │            │
│   │         [User enters code: ABCD-1234]                      │            │
│   │         [User clicks "Authorize gitspace.sh"]              │            │
│   │                             │                              │            │
│   │ POST /login/oauth/access_token (polling)                   │            │
│   │ {device_code, client_id,    │                              │            │
│   │  grant_type: device_code}   │                              │            │
│   │────────────────────────────►│                              │            │
│   │                             │                              │            │
│   │◄────────────────────────────│                              │            │
│   │ {access_token, token_type,  │                              │            │
│   │  scope}                     │                              │            │
│   │                             │                              │            │
│   │                                                            │            │
│   │ POST /auth/github/device                                   │            │
│   │ {github_token, machine_pubkey, device_name}                │            │
│   │───────────────────────────────────────────────────────────►│            │
│   │                                                            │            │
│   │                              [Verify token with GitHub API]│            │
│   │                              [GET github.com/user]         │            │
│   │                              [Create/find account by       │            │
│   │                               github_id]                   │            │
│   │                              [Create CLI token]            │            │
│   │                                                            │            │
│   │◄───────────────────────────────────────────────────────────│            │
│   │ {token: "gst_xxx", user: {github_username, ...}}           │            │
│   │                                                            │            │
│   │ [Save token to keychain]    │                              │            │
│   │                             │                              │            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3. Reserve Subdomain

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Terminal                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  $ gssh user host reserve brad                                                   │
│                                                                              │
│  Checking availability... ✓                                                 │
│  Creating tunnel... ✓                                                       │
│  Configuring DNS... ✓                                                       │
│  Saving credentials... ✓                                                    │
│                                                                              │
│  ✓ Reserved: brad.gitspace.sh                                              │
│                                                                              │
│  Your subdomain is ready:                                                   │
│    • brad.gitspace.sh                                                       │
│    • *.brad.gitspace.sh (dev.brad.gitspace.sh, api.brad.gitspace.sh, etc.) │
│                                                                              │
│  Run 'gssh machine serve start --foreground' to start hosting.                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4. Start Serving

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Terminal                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  $ gssh                                                                     │
│                                                                              │
│  Starting Gitspace...                                                       │
│                                                                              │
│  ✓ Identity loaded                                                          │
│  ✓ Tunnel connected (brad.gitspace.sh)                                     │
│  ✓ Relay started (accepting connections from other machines)               │
│  ✓ HTTP server listening on :8080                                          │
│                                                                              │
│  Your machine is accessible at:                                             │
│    • https://brad.gitspace.sh                                               │
│    • wss://brad.gitspace.sh/ws (terminal)                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GITSPACE TUI                                                         │   │
│  │  ...                                                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema (D1)

```sql
-- Users (via GitHub OAuth)
CREATE TABLE users (
  id TEXT PRIMARY KEY,                    -- uuid
  github_id TEXT UNIQUE NOT NULL,
  github_username TEXT NOT NULL,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- CLI Tokens (one user can have multiple devices)
-- SECURITY: Tokens are hashed before storage. Only prefix is stored for display.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,                    -- SHA256 hash of full token
  prefix TEXT NOT NULL,                   -- First 8 chars for display: "gst_abc1..."
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT,
  device_fingerprint TEXT,                -- Machine identity public key
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                     -- Optional expiration (90 days recommended)
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_tokens_user ON tokens(user_id);
CREATE INDEX idx_tokens_prefix ON tokens(prefix);  -- For token lookup by prefix

-- Subdomains (users can have MULTIPLE subdomains)
-- Free tier: 3 subdomains max
-- Paid tier: 10 subdomains max
CREATE TABLE subdomains (
  id TEXT PRIMARY KEY,                    -- uuid
  subdomain TEXT UNIQUE NOT NULL,         -- "brad" (not full domain)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tunnel_id TEXT NOT NULL,                -- Cloudflare tunnel UUID
  dns_record_ids TEXT NOT NULL,           -- JSON array of DNS record IDs for cleanup
  tunnel_token_encrypted TEXT NOT NULL,   -- Encrypted tunnel token
  status TEXT NOT NULL DEFAULT 'active',  -- active, suspended, deleted
  is_primary BOOLEAN DEFAULT false,       -- Primary subdomain for this user
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_subdomains_user ON subdomains(user_id);
CREATE INDEX idx_subdomains_status ON subdomains(status);

-- Reserved subdomains (cannot be claimed by users)
CREATE TABLE reserved_subdomains (
  subdomain TEXT PRIMARY KEY,
  reason TEXT NOT NULL                    -- e.g., "system", "offensive", "trademark"
);

-- Pre-populate reserved subdomains
INSERT INTO reserved_subdomains (subdomain, reason) VALUES
  ('api', 'system'), ('www', 'system'), ('admin', 'system'),
  ('mail', 'system'), ('ftp', 'system'), ('relay', 'system'),
  ('static', 'system'), ('cdn', 'system'), ('auth', 'system'),
  ('login', 'system'), ('status', 'system'), ('docs', 'system'),
  ('help', 'system'), ('support', 'system'), ('billing', 'system');

-- Subdomain access (who can connect to your relay)
CREATE TABLE subdomain_access (
  id TEXT PRIMARY KEY,
  subdomain_id TEXT NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,              -- Public key of authorized client
  label TEXT,
  permissions TEXT NOT NULL,              -- JSON: {read, write, manage}
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_subdomain_access_subdomain ON subdomain_access(subdomain_id);
CREATE INDEX idx_subdomain_access_identity ON subdomain_access(identity_id);
```

## Sessions (D1)

Sessions are stored in D1 (not KV) for better query support and to avoid KV write limits (1,000/day).

```sql
-- Portal sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                    -- session ID (random UUID)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,            -- created_at + 7 days
  ip_address TEXT,                        -- For audit trail
  user_agent TEXT                         -- For audit trail
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

```typescript
// Create session
const sessionId = crypto.randomUUID();
const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days

await env.DB.prepare(`
  INSERT INTO sessions (id, user_id, created_at, expires_at, ip_address, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`).bind(sessionId, userId, Date.now(), expiresAt, request.headers.get('CF-Connecting-IP'), request.headers.get('User-Agent')).run();

// Validate session (with cleanup of expired)
const session = await env.DB.prepare(
  'SELECT * FROM sessions WHERE id = ? AND expires_at > ?'
).bind(sessionId, Date.now()).first();

// Cleanup job: DELETE FROM sessions WHERE expires_at < ?
```

Note: GitHub Device Flow handles device codes entirely through GitHub's API - we never store them.

---

## API Specification

### Base URL
```
https://api.gitspace.sh
```

### Authentication

**Portal (browser)**: Cookie-based sessions stored in KV

**CLI**: Bearer token in Authorization header
```
Authorization: Bearer gst_xxxxxxxxxxxx
```

### Endpoints

#### Auth

```
# Portal: GitHub OAuth (redirect-based)
GET /auth/github
  → Redirects to GitHub OAuth authorize URL
  → Params: client_id, redirect_uri, scope=read:user,user:email

GET /auth/github/callback?code={code}
  → GitHub OAuth callback
  → Exchanges code for GitHub access token
  → Fetches user info from GitHub API
  → Creates/updates user in D1 (keyed by github_id)
  → Sets session cookie
  → Redirects to dashboard

# CLI: GitHub Device Flow
POST /auth/github/device
  Body: {
    github_token,           # GitHub access token from device flow
    machine_pubkey,         # Ed25519 public key (base64)
    device_name,            # e.g., "Brad's MacBook"
    auth_timestamp,         # Current timestamp (ms)
    auth_signature          # Signature proving private key ownership
  }
  → Verifies signature: sign(`gitspace-device-auth:${timestamp}`, private_key)
  → Rejects if timestamp > 5 minutes old (prevent replay)
  → Verifies GitHub token by calling GitHub API /user
  → Creates/updates user in D1 (keyed by github_id)
  → Creates CLI token in D1 (hashed)
  → Returns: { token: "gst_xxx", user: { github_username, email, ... } }

# Logout
POST /auth/logout
  Cookie: session
  → Deletes session from KV
```

#### User

```
GET /me
  Auth: Bearer token
  → Returns: { id, github_username, email, name, avatar_url }

GET /me/tokens
  Auth: Bearer token
  → Returns: [{ id, device_name, created_at, last_used_at }]

DELETE /me/tokens/{tokenId}
  Auth: Bearer token
  → Revokes token
```

#### Subdomains

```
GET /subdomains
  Auth: Bearer token
  → Returns: [{ subdomain, status, created_at }]

GET /subdomains/check?name={subdomain}
  Auth: Bearer token
  → Checks: not taken, not reserved, valid format (lowercase, alphanumeric, 3-20 chars)
  → Returns: { available: boolean, reason?: string }

POST /subdomains
  Auth: Bearer token
  Body: { subdomain, isPrimary?: boolean }
  → Validates: subdomain format, not reserved, not taken
  → Checks limit: free=3, paid=10 subdomains per user
  → Creates tunnel via CF API
  → Creates DNS records (subdomain + wildcard), stores record IDs
  → Stores encrypted tunnel token
  → Sets isPrimary=true if user's first subdomain
  → Returns: { subdomain, hosts: ['brad.gitspace.sh', '*.brad.gitspace.sh'], isPrimary }

POST /subdomains/{subdomain}/set-primary
  Auth: Bearer token
  → Sets this subdomain as primary, unsets others
  → Primary subdomain is used by default in `gssh machine serve start --foreground`

GET /subdomains/{subdomain}/token
  Auth: Bearer token
  → Returns: { tunnelToken } (decrypted)
  → Used by CLI to configure cloudflared

DELETE /subdomains/{subdomain}
  Auth: Bearer token
  → Deletes tunnel via CF API
  → Deletes DNS records
  → Marks subdomain as deleted (or releases)
```

#### Access Control (future)

```
GET /subdomains/{subdomain}/access
  Auth: Bearer token
  → Returns: [{ identity_id, label, permissions }]

POST /subdomains/{subdomain}/access
  Auth: Bearer token
  Body: { identityId, label, permissions }
  → Grants access

DELETE /subdomains/{subdomain}/access/{identityId}
  Auth: Bearer token
  → Revokes access
```

---

## Worker Implementation

### Project Structure

```
worker/
├── src/
│   ├── index.ts              # Main entry, routing
│   ├── middleware/
│   │   ├── auth.ts           # Token/session validation
│   │   └── cors.ts           # CORS headers
│   ├── handlers/
│   │   ├── auth.ts           # OAuth, device flow
│   │   ├── user.ts           # User endpoints
│   │   └── subdomains.ts     # Subdomain management
│   ├── services/
│   │   ├── cloudflare.ts     # CF API client (tunnels, DNS)
│   │   └── crypto.ts         # Token encryption/decryption
│   └── types.ts
├── schema.sql                # D1 schema
├── wrangler.toml
└── package.json
```

### wrangler.toml

```toml
name = "gitspace-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
GITHUB_CLIENT_ID = "xxx"
PORTAL_URL = "https://gitspace.sh"

[[d1_databases]]
binding = "DB"
database_name = "gitspace"
database_id = "xxx"

[[kv_namespaces]]
binding = "KV"
id = "xxx"

[secrets]
# Set via wrangler secret put
# GITHUB_CLIENT_SECRET
# CF_API_TOKEN
# CF_ACCOUNT_ID
# CF_ZONE_ID
# ENCRYPTION_KEY
```

### Key Implementation Details

```typescript
// src/services/crypto.ts - Token hashing

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// src/middleware/auth.ts - Token validation

export async function validateToken(
  request: Request,
  env: Env
): Promise<{ user: User } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const tokenPlain = authHeader.slice(7);
  const tokenHash = await hashToken(tokenPlain);

  // Look up by hash, check expiration and revocation
  const token = await env.DB.prepare(`
    SELECT t.*, u.* FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.id = ? AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > ?)
  `).bind(tokenHash, Date.now()).first();

  if (!token) return null;

  // Update last_used_at (fire-and-forget)
  env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')
    .bind(Date.now(), tokenHash).run();

  return { user: token as User };
}
```

```typescript
// src/services/cloudflare.ts

export async function createTunnel(
  env: Env,
  name: string
): Promise<{ id: string; token: string }> {
  // Generate tunnel secret (32 random bytes, base64)
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `gitspace-${name}`,
        tunnel_secret: secret,
      }),
    }
  );

  const data = await response.json();
  return {
    id: data.result.id,
    token: data.result.token,
  };
}

export async function createDNSRecords(
  env: Env,
  subdomain: string,
  tunnelId: string
): Promise<void> {
  const records = [
    { name: subdomain, type: 'CNAME' },                    // brad.gitspace.sh
    { name: `*.${subdomain}`, type: 'CNAME' },             // *.brad.gitspace.sh
  ];

  for (const record of records) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
        }),
      }
    );
  }
}

export async function deleteTunnel(env: Env, tunnelId: string): Promise<void> {
  // This immediately prevents new connections
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );
}

// src/handlers/auth.ts - GitHub Device Flow handler

import { ed25519 } from '@noble/curves/ed25519';

interface GitHubDeviceAuthRequest {
  github_token: string;
  machine_pubkey: string;
  device_name: string;
  auth_timestamp: number;
  auth_signature: string;
}

export async function handleGitHubDeviceAuth(
  request: Request,
  env: Env
): Promise<Response> {
  const body: GitHubDeviceAuthRequest = await request.json();
  const { github_token, machine_pubkey, device_name, auth_timestamp, auth_signature } = body;

  // Step 0: Verify signature to prevent device impersonation
  // SECURITY: Without this, an attacker could register with a stolen public key
  const now = Date.now();
  const MAX_TIMESTAMP_AGE = 5 * 60 * 1000; // 5 minutes

  // Check timestamp freshness (prevent replay attacks)
  if (Math.abs(now - auth_timestamp) > MAX_TIMESTAMP_AGE) {
    return Response.json(
      { error: 'Auth timestamp expired. Please try again.' },
      { status: 401 }
    );
  }

  // Verify the signature proves ownership of private key
  const authMessage = `gitspace-device-auth:${auth_timestamp}`;
  const messageBytes = new TextEncoder().encode(authMessage);
  const signatureBytes = Buffer.from(auth_signature, 'base64');
  const publicKeyBytes = Buffer.from(machine_pubkey, 'base64');

  try {
    const isValid = ed25519.verify(signatureBytes, messageBytes, publicKeyBytes);
    if (!isValid) {
      return Response.json(
        { error: 'Invalid device signature' },
        { status: 401 }
      );
    }
  } catch (err) {
    return Response.json(
      { error: 'Invalid signature format' },
      { status: 400 }
    );
  }

  // Step 1: Verify GitHub token by fetching user info
  const githubUserRes = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${github_token}`,
      'User-Agent': 'gitspace.sh',
      'Accept': 'application/vnd.github+json',
    },
  });

  if (!githubUserRes.ok) {
    return Response.json(
      { error: 'Invalid GitHub token' },
      { status: 401 }
    );
  }

  const githubUser = await githubUserRes.json();

  // Step 2: Fetch user emails (need scope: user:email)
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: {
      'Authorization': `Bearer ${github_token}`,
      'User-Agent': 'gitspace.sh',
      'Accept': 'application/vnd.github+json',
    },
  });

  let email: string | null = null;
  if (emailsRes.ok) {
    const emails = await emailsRes.json();
    const primary = emails.find((e: any) => e.primary && e.verified);
    email = primary?.email || null;
  }

  // Step 3: Find or create user (keyed by github_id)
  let user = await env.DB.prepare(
    'SELECT * FROM users WHERE github_id = ?'
  ).bind(String(githubUser.id)).first();

  const now = Date.now();

  if (!user) {
    // Create new user
    const userId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO users (id, github_id, github_username, email, name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      String(githubUser.id),
      githubUser.login,
      email,
      githubUser.name,
      githubUser.avatar_url,
      now,
      now
    ).run();

    user = { id: userId, github_id: String(githubUser.id), github_username: githubUser.login, email };
  } else {
    // Update existing user
    await env.DB.prepare(`
      UPDATE users SET github_username = ?, email = ?, name = ?, avatar_url = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      githubUser.login,
      email || user.email,
      githubUser.name,
      githubUser.avatar_url,
      now,
      user.id
    ).run();
  }

  // Step 4: Create CLI token (hashed for storage)
  const tokenPlain = `gst_${crypto.randomUUID().replace(/-/g, '')}`;
  const tokenPrefix = tokenPlain.slice(0, 12); // "gst_abc12345"
  const tokenHash = await hashToken(tokenPlain);
  const expiresAt = now + (90 * 24 * 60 * 60 * 1000); // 90 days

  await env.DB.prepare(`
    INSERT INTO tokens (id, prefix, user_id, device_name, device_fingerprint, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tokenHash,  // Store hash, not plain token
    tokenPrefix,
    user.id,
    device_name,
    machine_pubkey,
    now,
    expiresAt,
    now
  ).run();

  // Step 5: Return token and user info
  // IMPORTANT: This is the only time the plain token is returned!
  return Response.json({
    token: tokenPlain,
    user: {
      id: user.id,
      github_username: githubUser.login,
      email: email,
      name: githubUser.name,
      avatar_url: githubUser.avatar_url,
    },
  });
}
```

---

## CLI Implementation

### Commands

```bash
# Authentication
gssh user auth login              # Device auth flow
gssh user auth logout             # Clear local token
gssh user auth status             # Show current user

# Hosting (supports multiple subdomains: free=3, paid=10)
gssh user host reserve <name>     # Reserve subdomain
gssh user host release [name]     # Release subdomain
gssh user host list               # List your subdomains
gssh user host set-primary <name> # Set primary subdomain for `gssh machine serve start --foreground`
gssh user host status             # Show current hosting status

# Main entry (starts everything)
gssh                          # TUI + tunnel + relay
gssh client connect <target>  # Connect to remote machine
```

### Dependencies

```bash
# New CLI dependencies
bun add open           # Open browser URLs cross-platform
bun add which          # Find executables (cloudflared check)
bun add yaml           # Parse/generate cloudflared config
```

### Implementation

```typescript
// src/commands/auth.ts

import open from 'open';      // Opens browser URLs cross-platform
import os from 'os';
import { getSecret, setSecret, deleteSecret } from '../utils/secrets.js';
import { loadKeypair, getPublicKeyWithoutPassword } from '../core/identity.js';
import { sign, serializePublicKey } from '../lib/tmux-lite/crypto/identity.js';
import { promptPassword } from '../utils/prompts.js';

const API_BASE = 'https://api.gitspace.sh';
const GITHUB_CLIENT_ID = 'Iv1.xxxxxxxxxxxxxxxx'; // Your GitHub OAuth App client ID

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function authLogin(): Promise<void> {
  // Load identity (requires password to access private key for signing)
  const password = await promptPassword('Enter identity password: ');
  const identity = await loadKeypair(password);

  // Step 1: Request device code from GitHub
  console.log('Starting GitHub authentication...');

  const deviceRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user user:email',
    }),
  });

  const deviceData: DeviceCodeResponse = await deviceRes.json();
  const { device_code, user_code, verification_uri, interval } = deviceData;

  // Step 2: Display code and open browser
  console.log(`\n! First, copy your one-time code: ${user_code}\n`);

  // Try to open browser, with fallback for headless/SSH environments
  const canOpenBrowser = process.stdout.isTTY && !process.env.SSH_CLIENT;

  if (canOpenBrowser) {
    console.log(`Press Enter to open ${verification_uri} in your browser...`);
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });

    try {
      await open(verification_uri);
      console.log('\nWaiting for authorization...');
    } catch (err) {
      // Browser open failed (WSL, headless, etc.)
      console.log(`\nCould not open browser automatically.`);
      console.log(`Please open this URL manually: ${verification_uri}`);
      console.log(`\nWaiting for authorization...`);
    }
  } else {
    // Headless environment (SSH, CI, etc.)
    console.log(`Open this URL in your browser: ${verification_uri}`);
    console.log(`Enter the code: ${user_code}`);
    console.log(`\nWaiting for authorization...`);
  }

  // Step 3: Poll GitHub for access token
  const githubToken = await pollForGitHubToken(device_code, interval);

  // Step 4: Exchange GitHub token for gitspace.sh token
  // SECURITY: Sign auth request to prove private key ownership
  console.log('Completing authentication...');

  const authTimestamp = Date.now();
  const authMessage = `gitspace-device-auth:${authTimestamp}`;
  const authSignature = sign(authMessage, identity.signingSecretKey);

  const response = await fetch(`${API_BASE}/auth/github/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      github_token: githubToken,
      machine_pubkey: serializePublicKey(identity.signingPublicKey),
      device_name: os.hostname(),
      auth_timestamp: authTimestamp,
      auth_signature: authSignature,  // Proves private key ownership
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Authentication failed: ${error.message}`);
  }

  const { token, user } = await response.json();

  // Step 5: Save token to keychain
  await setSecret('GITSPACE_TOKEN', token);

  console.log(`\n✓ Authentication complete`);
  console.log(`✓ Logged in as ${user.github_username}`);
  console.log(`✓ Token saved to keychain`);
}

async function pollForGitHubToken(deviceCode: string, interval: number): Promise<string> {
  const maxAttempts = 60; // ~5 minutes with default 5s interval

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval * 1000);

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data: GitHubTokenResponse = await res.json();

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      // User hasn't authorized yet, keep polling
      continue;
    }

    if (data.error === 'slow_down') {
      // Rate limited, increase interval
      interval += 5;
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Authorization expired. Please try again.');
    }

    if (data.error === 'access_denied') {
      throw new Error('Authorization denied by user.');
    }

    throw new Error(`GitHub auth error: ${data.error_description || data.error}`);
  }

  throw new Error('Authorization timeout. Please try again.');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function authLogout(): Promise<void> {
  await deleteSecret('GITSPACE_TOKEN');
  console.log('✓ Logged out');
}

export async function authStatus(): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');

  if (!token) {
    console.log('Not logged in. Run: gssh user auth login');
    return;
  }

  const res = await fetch(`${API_BASE}/me`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    console.log('Session expired. Run: gssh user auth login');
    return;
  }

  const user = await res.json();
  console.log(`Logged in as: ${user.github_username}`);
  console.log(`Email: ${user.email || '(not set)'}`);
}

// src/commands/host.ts

export async function hostReserve(subdomain: string): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    console.log('Not logged in. Run: gssh user auth login');
    return;
  }

  // Check availability
  console.log('Checking availability...');
  const checkRes = await fetch(
    `${API_BASE}/subdomains/check?name=${subdomain}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const { available } = await checkRes.json();

  if (!available) {
    console.error(`Subdomain "${subdomain}" is not available`);
    return;
  }

  // Reserve
  console.log('Creating tunnel...');
  const res = await fetch(`${API_BASE}/subdomains`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subdomain }),
  });

  if (!res.ok) {
    const { error } = await res.json();
    console.error(`Failed: ${error}`);
    return;
  }

  const data = await res.json();
  console.log(`✓ Reserved: ${data.subdomain}.gitspace.sh`);
  console.log(`  Wildcard: *.${data.subdomain}.gitspace.sh`);
  if (data.isPrimary) {
    console.log(`  (set as primary)`);
  }

  // Fetch and store tunnel token for this subdomain
  const tokenRes = await fetch(
    `${API_BASE}/subdomains/${subdomain}/token`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const { tunnelToken } = await tokenRes.json();

  // Store tunnel token in keychain (per-subdomain)
  // SECURITY: Uses system keychain, not plaintext file
  await setSecret(`TUNNEL_TOKEN_${subdomain}`, tunnelToken);

  console.log('\nRun `gssh` to start hosting.');
  console.log(`Or `gssh user host list` to see all your subdomains.`);
}

export async function hostList(): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    console.log('Not logged in. Run: gssh user auth login');
    return;
  }

  const res = await fetch(`${API_BASE}/subdomains`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const subdomains = await res.json();

  if (subdomains.length === 0) {
    console.log('No subdomains reserved. Run: gssh user host reserve <name>');
    return;
  }

  console.log('Your subdomains:\n');
  for (const sub of subdomains) {
    const primary = sub.is_primary ? ' (primary)' : '';
    const status = sub.status === 'active' ? '✓' : '✗';
    console.log(`  ${status} ${sub.subdomain}.gitspace.sh${primary}`);
    console.log(`    Created: ${new Date(sub.created_at).toLocaleDateString()}`);
  }

  console.log(`\n${subdomains.length}/3 subdomains used (free tier)`);
}

export async function hostSetPrimary(subdomain: string): Promise<void> {
  const token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    console.log('Not logged in. Run: gssh user auth login');
    return;
  }

  const res = await fetch(`${API_BASE}/subdomains/${subdomain}/set-primary`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    const { error } = await res.json();
    console.error(`Failed: ${error}`);
    return;
  }

  console.log(`✓ ${subdomain}.gitspace.sh is now your primary subdomain`);
}
```

### gssh machine serve start --foreground Integration

```typescript
// src/commands/serve.ts - cloudflared integration

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import * as yaml from 'yaml';

let cloudflaredProcess: ChildProcess | null = null;

async function startCloudflared(subdomain: string): Promise<void> {
  // SECURITY: Read tunnel token from keychain (not from config file)
  const tunnelToken = await getSecret(`TUNNEL_TOKEN_${subdomain}`);
  if (!tunnelToken) {
    throw new Error(`No tunnel token found for ${subdomain}. Run: gssh user host reserve ${subdomain}`);
  }

  // Write cloudflared config for gitspace (separate from user's own config)
  const configDir = join(os.homedir(), '.gitspace');
  const configPath = join(configDir, 'cloudflared.yml');

  await writeFile(configPath, yaml.stringify({
    // Token-based auth (no credentials file needed)
    ingress: [
      // Main subdomain
      {
        hostname: `${subdomain}.gitspace.sh`,
        service: 'http://localhost:8080'
      },
      // Wildcard for workspaces/services
      {
        hostname: `*.${subdomain}.gitspace.sh`,
        service: 'http://localhost:8080'
      },
      // Catch-all (required)
      { service: 'http_status:404' }
    ],
  }));

  // Check cloudflared is installed
  const cloudflaredPath = await which('cloudflared').catch(() => null);
  if (!cloudflaredPath) {
    throw new Error(
      'cloudflared not found. Install it:\n' +
      '  macOS: brew install cloudflared\n' +
      '  Linux: See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
    );
  }

  // Start cloudflared with token via env var (not CLI arg - visible in `ps`)
  // SECURITY: TUNNEL_TOKEN env var is not visible to other users on the system
  cloudflaredProcess = spawn('cloudflared', [
    'tunnel',
    '--config', configPath,
    'run',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TUNNEL_TOKEN: tunnelToken,  // Pass token via env, not CLI arg
    },
  });

  cloudflaredProcess.stdout?.on('data', (data) => {
    logger.dim(`[cloudflared] ${data.toString().trim()}`);
  });

  cloudflaredProcess.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes('error')) {
      logger.error(`[cloudflared] ${msg}`);
    } else {
      logger.dim(`[cloudflared] ${msg}`);
    }
  });

  // Handle cloudflared crash - restart with backoff
  cloudflaredProcess.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) {
      logger.warn(`[cloudflared] Exited with code ${code}, restarting in 5s...`);
      setTimeout(() => startCloudflared(subdomain), 5000);
    }
  });

  // Wait for tunnel to be ready
  await waitForTunnel(subdomain);
}

async function waitForTunnel(subdomain: string, timeout = 30000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`https://${subdomain}.gitspace.sh/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }

  throw new Error('Tunnel failed to connect');
}

function stopCloudflared(): void {
  if (cloudflaredProcess) {
    cloudflaredProcess.kill();
    cloudflaredProcess = null;
  }
}
```

---

## Local Server (Embedded Relay + HTTP)

```typescript
// src/serve/local-server.ts

import { serve } from 'bun';
import net from 'net';

interface LocalServerConfig {
  port: number;
  subdomain: string;
  identity: Identity;
  accessList: AccessControlList;
  sessionManager: ClientSessionManager;
  serviceRouter: ServiceRouter;
}

// Check if a port is available
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

// Find an available port, starting from preferred
async function findAvailablePort(preferred: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferred + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${preferred}-${preferred + maxAttempts - 1}`);
}

export async function createLocalServer(config: LocalServerConfig) {
  const { subdomain, identity, accessList, sessionManager, serviceRouter } = config;

  // Find available port (fallback if 8080 is taken)
  const port = await findAvailablePort(config.port);
  if (port !== config.port) {
    logger.warn(`Port ${config.port} in use, using ${port} instead`);
  }

  return serve({
    port,

    async fetch(req, server) {
      const url = new URL(req.url);
      const host = req.headers.get('host') || '';

      // Health check
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok', subdomain });
      }

      // WebSocket upgrade for terminal
      if (url.pathname === '/ws') {
        const upgraded = server.upgrade(req, {
          data: { type: 'terminal' }
        });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Route HTTP to services based on subdomain
      // e.g., dev.brad.gitspace.sh → dev workspace
      // e.g., api.brad.gitspace.sh → api service
      const subHost = extractSubdomain(host, subdomain);
      return serviceRouter.route(subHost, req);
    },

    websocket: {
      open(ws) {
        sessionManager.handleConnect(ws.data.connectionId);
      },

      message(ws, message) {
        // Reuse existing terminal protocol handling
        sessionManager.handleMessage(ws.data.connectionId, message);
      },

      close(ws, code, reason) {
        sessionManager.handleDisconnect(ws.data.connectionId, reason);
      },
    },
  });
}

function extractSubdomain(host: string, baseSubdomain: string): string | null {
  // host: "dev.brad.gitspace.sh"
  // baseSubdomain: "brad"
  // returns: "dev"

  const pattern = new RegExp(`^(.+)\\.${baseSubdomain}\\.gitspace\\.sh$`);
  const match = host.match(pattern);
  return match ? match[1] : null;
}
```

---

## Revocation Flow

```typescript
// worker/src/handlers/subdomains.ts

export async function revokeSubdomain(
  subdomain: string,
  userId: string,
  env: Env
): Promise<void> {
  // 1. Get subdomain record
  const record = await env.DB.prepare(
    'SELECT * FROM subdomains WHERE subdomain = ? AND user_id = ?'
  ).bind(subdomain, userId).first();

  if (!record) {
    throw new Error('Subdomain not found');
  }

  // 2. Delete tunnel (IMMEDIATE - blocks new connections)
  await deleteTunnel(env, record.tunnel_id);

  // 3. Delete DNS records
  await deleteDNSRecords(env, subdomain);

  // 4. Update database
  await env.DB.prepare(
    'UPDATE subdomains SET status = ?, updated_at = ? WHERE id = ?'
  ).bind('deleted', Date.now(), record.id).run();

  // 5. Optionally: Release subdomain for reuse after cooldown
  // await scheduleSubdomainRelease(subdomain, 30 * 24 * 60 * 60 * 1000); // 30 days
}

// Admin revocation (abuse cases)
export async function adminRevokeUser(userId: string, env: Env): Promise<void> {
  // Get all user's subdomains
  const subdomains = await env.DB.prepare(
    'SELECT * FROM subdomains WHERE user_id = ? AND status = ?'
  ).bind(userId, 'active').all();

  // Revoke each subdomain
  for (const sub of subdomains.results) {
    await deleteTunnel(env, sub.tunnel_id);
    await deleteDNSRecords(env, sub.subdomain);
  }

  // Mark all as suspended
  await env.DB.prepare(
    'UPDATE subdomains SET status = ?, updated_at = ? WHERE user_id = ?'
  ).bind('suspended', Date.now(), userId).run();

  // Revoke all tokens
  await env.DB.prepare(
    'UPDATE tokens SET revoked_at = ? WHERE user_id = ?'
  ).bind(Date.now(), userId).run();
}
```

---

## Peer Relay Model

Secondary machines connect to primary machine's embedded relay:

```typescript
// src/commands/serve.ts

import { getSecret } from '../utils/secrets.js';

/**
 * Host config stored in ~/gitspace/host.json (non-sensitive data only)
 * Sensitive tunnel tokens are stored in keychain via Bun.secrets
 */
interface HostConfig {
  subdomain: string;          // Primary subdomain
  subdomains?: string[];      // Additional subdomains (if any)
  createdAt: number;
}

export async function serve(options: ServeOptions): Promise<void> {
  const hostConfig = await getHostConfig();  // Reads non-sensitive config from ~/gitspace/

  if (hostConfig?.subdomain) {
    // PRIMARY MODE: Has subdomain, runs cloudflared + relay
    // Tunnel token is read from keychain inside startPrimaryMode
    await startPrimaryMode(hostConfig.subdomain);
  } else if (options.relay) {
    // SECONDARY MODE: Connects to another machine's relay
    await startSecondaryMode(options.relay);
  } else {
    // LOCAL ONLY MODE: No remote access
    await startLocalMode();
  }
}

async function startPrimaryMode(subdomain: string): Promise<void> {
  // 1. Start cloudflared (reads tunnel token from keychain)
  await startCloudflared(subdomain);

  // 2. Start local HTTP/WS server
  const server = createLocalServer({
    port: 8080,
    subdomain,
    // ...
  });

  // 3. Start embedded relay (accepts connections from secondary machines)
  const relay = createEmbeddedRelay({
    // Reuses existing relay protocol
  });

  logger.success(`Primary mode: https://${subdomain}.gitspace.sh`);
}

async function startSecondaryMode(relayUrl: string): Promise<void> {
  // Connect to primary machine's relay (same as current relay connection)
  const ws = new WebSocket(`wss://${relayUrl}/ws`);

  // Register this machine
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'register_machine',
      machineId: identity.id,
      signingKey: identity.signingPublicKey,
      keyExchangeKey: identity.keyExchangePublicKey,
    }));
  };

  // Handle client connections (same as current)
  // ...

  logger.success(`Secondary mode: Connected to ${relayUrl}`);
}
```

---

## Security Considerations

### Token Security

**Storage Patterns:**

| Data Type | Location | Rationale |
|-----------|----------|-----------|
| gitspace.sh API token (`gst_xxx`) | System keychain via `Bun.secrets` | Sensitive, needs secure storage |
| Tunnel tokens | System keychain via `Bun.secrets` | Sensitive, grants tunnel access |
| Machine identity private keys | `~/gitspace/.identity/keypair.json` (encrypted) | Already password-protected |
| Relay config (URL, machine ID) | `~/gitspace/.identity/relay.json` | Non-sensitive metadata |
| API tokens in D1 | SHA-256 hash only | Never store plaintext |

**Device Registration Security:**
- Signature required: `sign("gitspace-device-auth:${timestamp}", privateKey)`
- Timestamp must be within 5 minutes (prevents replay attacks)
- Without signature, attacker could register with stolen public key

**Bun.secrets Integration (Global):**
```typescript
// src/utils/secrets.ts - Cross-platform secure secret storage

const SERVICE_NAME = 'com.gitspace-cli';

/**
 * Store a global secret (not project-scoped)
 * Uses system keychain: macOS Keychain, Linux libsecret, Windows Credential Manager
 */
export async function setSecret(key: string, value: string): Promise<void> {
  await Bun.secrets.set({
    service: SERVICE_NAME,
    name: key,
    value,
  });
}

/**
 * Retrieve a global secret
 */
export async function getSecret(key: string): Promise<string | null> {
  return Bun.secrets.get({
    service: SERVICE_NAME,
    name: key,
  });
}

/**
 * Delete a global secret
 */
export async function deleteSecret(key: string): Promise<boolean> {
  return Bun.secrets.delete({
    service: SERVICE_NAME,
    name: key,
  });
}

// Project-scoped secrets (existing API)
function buildProjectSecretName(projectName: string, key: string): string {
  return `${projectName}:${key}`;
}

export async function setProjectSecret(
  projectName: string,
  key: string,
  value: string
): Promise<void> {
  await Bun.secrets.set({
    service: SERVICE_NAME,
    name: buildProjectSecretName(projectName, key),
    value,
  });
}

export async function getProjectSecret(
  projectName: string,
  key: string
): Promise<string | null> {
  return Bun.secrets.get({
    service: SERVICE_NAME,
    name: buildProjectSecretName(projectName, key),
  });
}
```

**What goes where:**
```
~/gitspace/
├── .identity/
│   ├── keypair.json        # Password-encrypted Ed25519/X25519 keys
│   ├── machine.json        # Machine ID, label (not sensitive)
│   └── relay.json          # Relay URL, machine ID (not sensitive)
│                           # NOTE: No secrets in relay.json anymore!
└── cloudflared.yml         # Tunnel routing config (not sensitive)

System Keychain (via Bun.secrets):
├── GITSPACE_TOKEN          # gitspace.sh API token (sensitive!)
└── TUNNEL_TOKEN_{subdomain} # Per-subdomain tunnel token (sensitive!)
```

### Revocation Speed

| Action | Effect | Speed |
|--------|--------|-------|
| Delete tunnel | New connections blocked | Immediate |
| Rotate token | Old token invalid | Immediate |
| Revoke API token | API access blocked | Immediate |

### Abuse Prevention

- Rate limiting on subdomain creation
- Subdomain naming rules (no offensive terms)
- Reserved subdomains (api, www, admin, etc.)
- Cooldown period before subdomain reuse

---

## Cost Analysis

### Cloudflare Costs (You Pay)

| Item | Cost | Notes |
|------|------|-------|
| Domain (gitspace.sh) | ~$10/year | One-time |
| Total TLS | $10/month | For *.*.gitspace.sh wildcards |
| Workers | Free tier | 100k requests/day |
| D1 | Free tier | 5GB storage |
| KV | Free tier | 100k reads/day |

**Total: ~$130/year**

### User Costs

| Item | Cost |
|------|------|
| Everything | $0 |

Users run tunnels on their own machines, use their own bandwidth.

---

## Launch Checklist

```
□ Cloudflare Setup
  □ Add gitspace.sh domain
  □ Enable Total TLS ($10/mo)
  □ Create API token with permissions:
    □ Account > Cloudflare Tunnel > Edit
    □ Zone > DNS > Edit
    □ Zone > SSL and Certificates > Edit
  □ Note Account ID, Zone ID

□ GitHub OAuth App
  □ Create OAuth App at github.com/settings/applications/new
  □ Set homepage URL: https://gitspace.sh
  □ Set callback URL: https://api.gitspace.sh/auth/github/callback
  □ Enable Device Flow (checkbox in OAuth App settings)
  □ Note Client ID, Client Secret

□ Worker Deployment
  □ Create D1 database, run schema.sql
  □ Create KV namespace
  □ Set secrets (wrangler secret put)
  □ Deploy worker to api.gitspace.sh

□ Portal Deployment
  □ Deploy to gitspace.sh via Pages

□ CLI Updates
  □ gssh user auth login/logout/status
  □ gssh user host reserve/release/list
  □ cloudflared integration in gssh machine serve start --foreground
  □ Test full flow

□ Documentation
  □ Getting started guide
  □ FAQ
```

---

*Last updated: 2025-01*
