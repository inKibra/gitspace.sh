# Gateway Worker Specification

> **Status: SPECIFICATION ONLY - NOT YET IMPLEMENTED**
> **Historical Document** - retained for context only; not the active runtime contract.
>
> This document describes the planned Gateway Worker for subdomain routing and
> authentication. The current implementation only includes the API Worker
> (`api.gitspace.sh`) for user/subdomain management. The Gateway Worker
> described here is Phase 2 of the platform architecture.

## Overview

A Cloudflare Worker that sits in front of all user subdomains (`*.{user}.gitspace.sh`), providing:
- Authentication via gitspace.sh GitHub OAuth
- Authorization for shared services
- Routing to appropriate Cloudflare Tunnels

## Why Not Cloudflare Access?

Cloudflare Access:
- Uses its own identity providers (separate OAuth flows)
- Policies configured per-app in dashboard, not programmatically
- Can't query our D1 database for owner identity and enrollment state
- Can't validate our signed tokens

We need:
- Single identity across all gitspace.sh subdomains
- Programmatic access control via our API
- Custom authorization logic (owner identity, machine enrollment, port sharing)
- Portable session (one login works everywhere)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                               │
│                                                                      │
│   Request: app.username.gitspace.sh                                  │
│                    │                                                 │
│                    ▼                                                 │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │                   Gateway Worker                            │    │
│   │                                                             │    │
│   │  1. Parse: owner=username, service=app                      │    │
│   │  2. Validate session cookie (JWT signed by gitspace.sh)     │    │
│   │  3. Check authorization (D1 query)                          │    │
│   │  4. Route to tunnel                                         │    │
│   │                                                             │    │
│   └────────────────────────────────────────────────────────────┘    │
│                    │                                                 │
│                    ▼                                                 │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │              Cloudflare Tunnel → User's Machine               │  │
│   └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## URL Structure

```
{service}.{owner}.gitspace.sh

Examples:
  username.gitspace.sh           → relay (default, terminal access)
  app.username.gitspace.sh       → localhost:3000
  api.username.gitspace.sh       → localhost:8080
  preview.username.gitspace.sh   → localhost:5173
```

## Data Model

```sql
-- Services (ports exposed under a subdomain)
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  subdomain_id TEXT REFERENCES subdomains(id),
  name TEXT NOT NULL,              -- 'app', 'api', '' (root = relay)
  local_port INTEGER NOT NULL,     -- 3000, 8080, 4480 (relay)
  visibility TEXT DEFAULT 'owner', -- 'public', 'owner', 'shared'
  created_at INTEGER,
  updated_at INTEGER,

  UNIQUE(subdomain_id, name)
);

-- Service access grants (for visibility='shared')
CREATE TABLE service_access (
  id TEXT PRIMARY KEY,
  service_id TEXT REFERENCES services(id),
  user_id TEXT REFERENCES users(id),   -- GitHub-authenticated user
  invite_token_hash TEXT,               -- Alternative: invite-based access
  expires_at INTEGER,
  created_at INTEGER
);
```

## Authentication

### Session Token (JWT)

Issued by gitspace.sh after GitHub OAuth:

```typescript
interface SessionToken {
  sub: string;            // gitspace.sh user ID
  github_id: string;      // GitHub user ID
  github_username: string;
  iat: number;
  exp: number;
}
```

Cookie settings:
```
__gitspace_session=<jwt>
Domain=.gitspace.sh    // Works for all subdomains
HttpOnly=true
Secure=true
SameSite=Lax
```

### Auth Flow

**First visit (no session):**
1. User visits `app.username.gitspace.sh`
2. Gateway Worker: no valid session cookie
3. Redirect → `gitspace.sh/login?redirect=https://app.username.gitspace.sh`
4. User authenticates with GitHub
5. gitspace.sh sets session cookie on `.gitspace.sh`
6. Redirect back to original URL
7. Gateway Worker validates session, checks authorization

**Return visit (has session):**
1. User visits `app.username.gitspace.sh`
2. Gateway Worker: session cookie present
3. Validate JWT signature and expiry
4. Query D1: does this user have access?
5. Forward to tunnel

**First access (requires login + grant):**
1. User visits `app.username.gitspace.sh`
2. Gateway Worker redirects to login if no valid session
3. After login, Gateway Worker checks access grants
4. Authorized users are forwarded to tunnel

## Authorization Logic

```typescript
async function checkAccess(
  user: SessionUser | null,
  service: Service,
): Promise<boolean> {
  // Public services: anyone
  if (service.visibility === 'public') {
    return true;
  }

  // Must be logged in from here
  if (!user) {
    return false;
  }

  // Owner: always has access to their own services
  const subdomain = await getSubdomain(service.subdomain_id);
  if (subdomain.user_id === user.id) {
    return true;
  }

  // Shared: check access grants
  if (service.visibility === 'shared') {
    const grant = await getAccessGrant(service.id, user.id);
    return grant !== null && (grant.expires_at === null || grant.expires_at > Date.now());
  }

  return false;
}
```

## Gateway Worker Implementation

```typescript
// worker-gateway/src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;

    // Parse subdomain: app.username.gitspace.sh
    const parsed = parseHost(host);
    if (!parsed) {
      return new Response('Invalid hostname', { status: 400 });
    }

    const { owner, serviceName } = parsed;

    // Lookup service in D1
    const service = await env.DB.prepare(`
      SELECT s.*, sub.user_id as owner_user_id, sub.tunnel_id
      FROM services s
      JOIN subdomains sub ON s.subdomain_id = sub.id
      WHERE sub.subdomain = ? AND s.name = ?
    `).bind(owner, serviceName || '').first();

    if (!service) {
      return new Response('Service not found', { status: 404 });
    }

    // Get session from cookie
    const sessionToken = getSessionCookie(request);
    const user = sessionToken ? await validateSession(sessionToken, env) : null;

    // Check authorization
    const hasAccess = await checkAccess(user, service);

    if (!hasAccess) {
      // No session? Redirect to login
      if (!user) {
        const loginUrl = new URL('https://gitspace.sh/login');
        loginUrl.searchParams.set('redirect', request.url);
        return Response.redirect(loginUrl.toString(), 302);
      }

      // Has session but not authorized
      return new Response('Access denied', { status: 403 });
    }

    // Forward to tunnel
    // The tunnel is already configured with ingress rules
    // We just need to pass through the request
    return fetch(request);
  }
}
```

## CLI Commands

```bash
# Create a machine enrollment invite token
gssh invite relay-machine create --relay <url> --machine-signing-key <base64> --machine-key-exchange-key <base64>

# List active root-signed invites
gssh invite list --relay <url>

# Revoke an invite
gssh invite revoke <invite-id> --relay <url>
```

## Tunnel Configuration

When a user shares a port, the tunnel ingress is updated:

```yaml
ingress:
  - hostname: username.gitspace.sh
    service: http://localhost:4480      # relay
  - hostname: "*.username.gitspace.sh"
    service: http://localhost:4480      # default to relay
  - hostname: app.username.gitspace.sh
    service: http://localhost:3000      # specific service
  - service: http_status:404
```

The Gateway Worker handles auth BEFORE the request reaches the tunnel.

## Migration Path

### Phase 1 (Current)
- Relay-level auth only (signed messages + challenge-response)
- No Gateway Worker

### Phase 2 (This Spec)
- Deploy Gateway Worker
- Session cookies via gitspace.sh OAuth
- Owner-only access (prove you own the GitHub account)

### Phase 3 (Future)
- Invite system for sharing with others
- Service-level access grants
- Port sharing CLI commands

## Security Considerations

1. **Session tokens** - Signed by gitspace.sh, validated at edge
2. **Invite tokens** - Ed25519 signed by service owner, time-limited
3. **Cookie scope** - `.gitspace.sh` allows SSO across all subdomains
4. **HTTPS only** - All traffic through Cloudflare, TLS enforced
5. **No secrets in Worker** - Only public keys for signature validation

## Open Questions

1. **Wildcard routing** - How to handle `*.username.gitspace.sh` efficiently?
2. **WebSocket support** - Gateway Worker must handle WS upgrade
3. **Rate limiting** - Per-user or per-service limits?
4. **Audit logging** - Track access for security/debugging?
