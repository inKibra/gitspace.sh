# Relay Server Design (Owner-Only)

The relay is the routing and policy service between owner clients and owner machines. It forwards encrypted terminal traffic and stores encrypted owner sync records.

---

## 1) Responsibilities

The relay does four things:

1. Authenticate machine registration using signed challenge-response.
2. Authenticate owner client requests using signed messages and certificate-derived owner root identity.
3. Route encrypted terminal data between connected owner client and machine.
4. Store category-based encrypted owner config records with revision metadata.

The relay does not decrypt terminal content or decrypted owner config values.

---

## 2) Runtime Topology

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Owner Machine  │◀═════▶│  Relay Server   │◀═════▶│  Owner Client   │
│ role=machine    │  wss  │ role router     │  wss  │ role=client     │
│ register_machine│       │ auth + sync DB  │       │ list/connect    │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

Machine connection is a single persistent WebSocket. Multiple client connections are multiplexed via `connectionId`.

---

## 3) Data Model

### Machine Registry

```ts
interface RegisteredMachine {
  machineId: string;
  ownerUserRootId: string;
  signingKey: string;     // Ed25519 public key
  keyExchangeKey: string; // X25519 public key
  label?: string;
  online: boolean;
  lastSeenAt: number;
}
```

### Enrollment Invite Registry

Only machine enrollment invites are supported:

```ts
interface RelayMachineInvite {
  inviteId: string;
  ownerUserRootId: string;
  inviteType: "relay-machine";
  relayUrl: string;
  tokenHash: string;
  machineSigningKey: string;
  machineKeyExchangeKey: string;
  expiresAt?: string;
  maxUses?: number;
  usedCount: number;
  revokedAt?: string;
}
```

### Owner Sync Registry

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
  ciphertext: string;
}
```

### Lock Registry (V1)

```ts
interface OwnerSyncLock {
  ownerUserRootId: string;
  scope: "global";
  lockId: string;
  holderWriterId: string;
  expiresAt: number;
}
```

---

## 4) Authorization Rules

### Machine Registration

- Machine must prove possession of Ed25519 private key via relay nonce signature.
- Machine must match an authorized enrollment path (`relay-machine` invite or pre-authorized owner machine).

### Client Operations

- Client messages are signed.
- Relay derives owner root identity from certificate/signing context.
- Relay allows list/connect/sync only for that owner root.

There is no runtime user-grant path.

---

## 5) Sync Semantics

### Required Operations

- `compare`: return relay revisions and drift indicators
- `pull`: return current encrypted records by category
- `push`: write encrypted records with expected revision guard
- `lock`: acquire owner global lock
- `unlock`: release owner global lock

### Conflict Policy

- Category payload merge is deterministic last-write timestamp per key.
- Push with stale expected revision is rejected.

### Record Guarantees

- Revision increments on successful push.
- `updatedAt`, `writerId`, and `checksum` are persisted with each write.

---

## 6) Relay Command Surface

Target command surface for relay operations:

| Command | Purpose |
|---|---|
| `gssh relay start` | Start relay server |
| `gssh relay machines list` | List registered machines |
| `gssh relay machines revoke <machine-id>` | Revoke machine registration |
| `gssh invite relay-machine create ...` | Issue machine enrollment invite |
| `gssh invite list --relay <url>` | List root invites |
| `gssh invite revoke <invite-id> --relay <url>` | Revoke invite |

---

## 7) Error Model

| Code | Meaning |
|---|---|
| `INVALID_SIGNATURE` | Signature validation failed |
| `FORBIDDEN` | Caller is not owner for requested operation |
| `NOT_FOUND` | Machine/invite/record not found |
| `OFFLINE` | Target machine is not online |
| `INVALID` | Invite invalid, expired, or exhausted |
| `CONFLICT` | Expected revision mismatch |
| `LOCKED` | Owner lock held by different writer |

---

## 8) Operational Notes

- Relay can be self-hosted or run as managed service.
- Health endpoint should expose machine counts and active connection counts.
- Sync metrics should include per-owner lock contention and revision conflict counts.

---

Last updated: 2026-02
