# GitSpace Remote Access Design (Owner-Only)

Status: locked target architecture for the owner-only relay sync cutover.

This document defines the runtime and data model for remote terminal access after the owner-only cutover.

---

## 1) Overview

GitSpace runs terminal sessions on a machine and allows remote access through a relay. Terminal bytes stay end-to-end encrypted. The relay can route traffic and enforce policy, but it cannot decrypt session content.

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Owner Machine  │◀═════▶│  Relay Server   │◀═════▶│  Owner Client   │
│                 │  wss  │                 │  wss  │ (CLI or Web)    │
│ machine serve   │       │ Routing + auth  │       │ connect/list    │
│ tmux-lite       │       │ Sync storage    │       │ X3DH endpoint   │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## 2) Non-Negotiable Rules

1. Authorization is owner-only.
2. Invite scope is machine enrollment only (`relay-machine`).
3. No multi-user grant flow is active in CLI, relay, or handshake runtime.
4. Project lifecycle is git-first (direct remote URL), with no hard dependency on `gh`.
5. Relay sync state is organized into four categories:
   - `fundamental`
   - `integrations`
   - `project/workspace`
   - `preferences`

---

## 3) Identity and Trust Model

### Principals

- `owner user root`: canonical user identity (`gssh-user:...`, user-root derived)
- `machine`: Ed25519/X25519 identity pair bound to owner root
- `relay`: routing and policy process, challenge-signing identity

### Key Material

- Ed25519: identity signatures and signed relay messages
- X25519: X3DH key exchange
- AES-256-GCM: encrypted frame transport
- HKDF-SHA256: per-session key derivation

### Authorization Rule

For direct machine access, the relay and machine only accept the owner user root identity.

---

## 4) Relay Sync Model (Source of Truth)

Relay stores encrypted owner state records by category. Only the owner can decrypt payloads.

### Category Contract

| Category | Purpose |
|---|---|
| `fundamental` | auth session material, git credential state |
| `integrations` | GitHub, Linear, Sprites integration settings |
| `project/workspace` | project config, workspace config, bundle state, workspace secrets |
| `preferences` | CLI and web preferences/personalization |

### Required Record Metadata

Every synced record includes:

- `revision` (monotonic per category)
- `updatedAt` (unix ms)
- `writerId` (owner device identity)
- `checksum` (integrity fingerprint for payload)

### Record Shape

```ts
type SyncCategory =
  | "fundamental"
  | "integrations"
  | "project/workspace"
  | "preferences";

interface OwnerSyncRecord {
  ownerUserRootId: string;
  category: SyncCategory;
  revision: number;
  updatedAt: number;
  writerId: string;
  checksum: string;
  ciphertext: string; // owner-decrypt-only envelope
}
```

### Conflict Policy

- Deterministic merge is required.
- V1 policy: last-write timestamp per key within a category payload.

### Locking and Revision Guard

- V1 lock scope is global owner lock.
- `push` requires expected revision.
- stale revision writes are rejected with retry-safe conflict response.

---

## 5) Runtime Flows

### A) Machine Enrollment

1. Owner issues `relay-machine` invite.
2. Machine enrolls using invite token.
3. Relay binds machine identity to owner root.

### B) Machine Registration

1. Machine opens `ws://.../ws?role=machine`.
2. Relay sends challenge (`relay_identity`).
3. Machine signs challenge and sends `register_machine`.
4. Relay verifies signature and machine ownership binding.
5. Relay marks machine online.

### C) Owner Client Connect

1. Client opens `ws://.../ws?role=client`.
2. Client signs `list_machines` / `connect_to_machine`.
3. Relay verifies signature and derives owner root from certificate.
4. Relay allows only owner-owned machines.
5. Client and machine complete X3DH handshake.
6. Encrypted terminal frames flow over relay.

### D) Config Sync

1. Client runs `compare` against relay revisions.
2. Client `pull`s newer categories and hydrates local cache.
3. On local writes, client `push`es with expected revision.
4. Relay enforces lock and revision checks.
5. Conflicts resolve by deterministic last-write timestamp per key.

---

## 6) Project Lifecycle (Git-First)

- Project add accepts direct git remote URL.
- Remote validity and branch defaults are resolved via `git` operations.
- GitHub integration remains optional under `integrations` category.
- Core project add/list/connect flows must work without `gh` authentication.

---

## 7) Migration Expectations

- Existing local config/secrets/preferences are imported once into owner sync categories.
- Migration is idempotent and marks completion.
- Legacy access-grant artifacts do not block startup.

---

## 8) Security Model Summary

### Relay Visibility

Relay can see routing metadata only:

- machine identifiers
- connection identifiers
- signed envelope metadata
- sync record metadata (`revision`, `updatedAt`, `writerId`, `checksum`)

Relay cannot see:

- terminal content
- decrypted sync payloads
- local secret values

### Threat Table

| Threat | Mitigation |
|---|---|
| Relay compromise | E2E transport encryption and owner-decrypt-only config envelopes |
| Network interception | TLS + X3DH forward secrecy |
| Replay/signature reuse | timestamped signed relay messages + nonce checks |
| Stale concurrent writes | lock + expected revision guard |

---

## 9) Completion Gate

The cutover is only complete when all are true:

1. Owner can bootstrap on a new device and decrypt synced state without manual local setup.
2. No multi-user command or relay path remains active.
3. Project add works from direct git remote URL (CLI and web path) without `gh`.
4. Existing users migrate forward without data loss.

---

Last updated: 2026-02
