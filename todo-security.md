# Security Audit Findings

**Date:** 2026-01-07
**Last Updated:** 2026-01-08 (P1 auth + relay signature fixes)
**Scope:** Worker API, Relay Server, Crypto Implementation, CLI/Serve Daemon

---

## Priority Checklist (single source of truth)

### P0 - Before Launch
- [ ] Add backpressure handling - Prevent memory exhaustion (`src/relay/server.ts`)
- [ ] Add idle connection timeout - Clean up stale relay connections (`src/relay/server.ts`)
- [ ] Add rate limiting to auth endpoints - Cloudflare WAF rate limiting rule (infra) (`worker/src/handlers/auth.ts`, `worker/src/handlers/subdomains.ts`)
- [x] Fix path traversal - Validate pathname doesn't escape WEB_DIST_PATH (`src/relay/server.ts`)
- [x] Fix encryption key derivation - Use HKDF instead of zero-padding (legacy decrypt fallback) (`worker/src/services/cloudflare.ts`)
- [x] Add connection rate limiting - Per-IP limits on relay connections (`src/relay/server.ts`)
- [x] Fix command injection - Sanitize checkCommand in onboarding.ts (`src/utils/onboarding.ts`)
- [x] Session fixation vulnerability
- [x] X3DH handshake security
- [x] Client identity proof bypass
- [x] Relay machine takeover

### P1 - Soon After Launch
- [x] Device fingerprint stored but not validated during token usage (`worker/src/middleware/auth.ts:53`)
- [x] Validate device_name length/charset (`worker/src/handlers/auth.ts:146`)
- [x] Session cookie uses `SameSite=Lax` instead of `Strict` (`worker/src/handlers/auth.ts:108`)
- [x] Signature verification not enforced on client messages (`src/relay/server.ts`)
- [x] Client can claim any `clientIdentityId` without proof on data messages (`src/relay/server.ts:731`)
- [x] Fix file permissions - chmod 0o600 on config files after write (`src/core/config.ts`)
- [x] Fix tunnel token exposure - Use stdin/fd instead of env var (`src/commands/serve.ts`)
- [x] Fix Zip Slip - Validate extracted paths don't escape target dir + reject symlinks (`src/core/bundle.ts`)
- [x] OAuth state parameter not validated
- [x] Account limit race condition
- [x] Identity file permissions
- [x] Permission flags not enforced
- [x] Invite singleUse not enforced

### P2 - Follow-up
- [ ] Restrict CORS in production - Remove localhost origin (`worker/src/index.ts:22-30`)
- [ ] Challenge timeout of 30s may be too long (`src/relay/server.ts:102`)
- [ ] Health endpoint exposes metrics without auth (`src/relay/server.ts:165`)
- [ ] Add audit logging of critical operations
- [ ] Session enumeration possible without granular permission check (`src/lib/remote-session/session-handler.ts:246`)
- [ ] Unix socket permissions not explicitly set (`src/serve/daemon.ts:228`)
- [ ] Relay port/bind parameters not validated (`src/commands/relay.ts:49-51`)
- [x] Access list file permissions (`src/core/access.ts`)

### P3 - Backlog
- [ ] No signing key rotation mechanism (`src/core/identity.ts`)
- [ ] Missing X-Content-Type-Options header (`worker/src/index.ts`)
- [ ] Missing security headers in relay responses (`src/relay/server.ts`)
- [ ] Documentation says ChaCha20 but uses AES-GCM (`src/lib/tmux-lite/crypto/secretbox.ts` comments)
- [ ] Verbose error messages may leak paths (`src/commands/serve.ts`)

---

## Removed / Not Applicable After Verification

- Subdomain token endpoint does verify active status (`worker/src/handlers/subdomains.ts:262`)
- accountId is always set (fallbacks to machineId) (`src/relay/server.ts:436`)
- JWT clock skew entry references a file not present in this repo (`jwt.ts`)
- Custom timingSafeEqual entry references a file not present in this repo (`jwt.ts`)

---

## Crypto Assessment: STRONG

The crypto implementation passed security review:
- AES-256-GCM with proper nonce handling
- scrypt for password-based key derivation (N=32K, r=8, p=1)
- X25519 with low-order point validation (all 8 points checked)
- X3DH handshake with mutual authentication
- Ed25519 signatures with timestamp replay protection
- HKDF-SHA256 with domain separation for key derivation
- File permissions: 0o700 for directories, 0o600 for files

Note: This assessment applies to tmux-lite crypto. Worker tunnel token encryption now uses HKDF with a legacy decrypt fallback.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| **Critical** | 6 | 2 Open / 4 Resolved |
| **High** | 9 | 1 Open / 8 Resolved |
| **Medium** | 8 | 7 Open / 1 Resolved |
| **Low** | 5 | 5 Open |
| **Fixed** | 22 | Resolved |

**Priority Focus:** Idle connection timeout, WAF auth rate limiting, backpressure handling, CORS restriction, audit logging, session enumeration controls.
