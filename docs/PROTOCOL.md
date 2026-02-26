# Relay Protocol Reference (Owner-Only)

Protocol version: 3 (target owner-only cutover)

This document defines the WebSocket protocol between machine, owner client, and relay.

---

## 1) Connection URLs

```
Machine: ws://relay:port/ws?role=machine
Client:  ws://relay:port/ws?role=client
```

---

## 2) Authentication and Authorization

### Machine Registration

1. Machine connects with `?role=machine`.
2. Relay sends `relay_identity` with challenge nonce.
3. Machine signs challenge with Ed25519 private key.
4. Machine sends `register_machine` with challenge response and keys.
5. Relay verifies signature and machine ownership binding.
6. Relay responds with `registered`.

### Owner Client Routing

1. Client connects with `?role=client`.
2. Client signs routing and sync messages.
3. Relay verifies signature and derives owner root identity.
4. Relay permits only owner-owned resources.

---

## 3) Signature Block

Required on security-sensitive client messages.

```json
{
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Signed message types:

- `list_machines`
- `connect_to_machine`
- `create_root_invite`
- `list_root_invites`
- `revoke_root_invite`
- `owner_sync_compare`
- `owner_sync_pull`
- `owner_sync_push`
- `owner_sync_lock`
- `owner_sync_unlock`

---

## 4) Message Types

All messages are JSON.

### 4.1 Machine -> Relay

#### `register_machine`

```json
{
  "type": "register_machine",
  "machineId": "macbook-01",
  "signingKey": "base64-ed25519-public",
  "keyExchangeKey": "base64-x25519-public",
  "challengeResponse": "base64-ed25519-signature",
  "label": "My MacBook"
}
```

Relay response:

```json
{ "type": "registered", "machineId": "macbook-01" }
```

#### `data`

```json
{
  "type": "data",
  "connectionId": "conn-123",
  "data": "base64-encrypted-payload"
}
```

---

### 4.2 Client -> Relay

#### `list_machines`

```json
{
  "type": "list_machines",
  "clientIdentityId": "owner-device-01",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Relay response:

```json
{
  "type": "machine_list",
  "machines": [
    {
      "machineId": "macbook-01",
      "label": "My MacBook",
      "online": true,
      "isOwner": true,
      "lastConnectedAt": 1704067200000
    }
  ]
}
```

#### `connect_to_machine`

```json
{
  "type": "connect_to_machine",
  "machineId": "macbook-01",
  "clientIdentityId": "owner-device-01",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Relay response:

```json
{
  "type": "connection_established",
  "machineId": "macbook-01",
  "connectionId": "conn-123"
}
```

#### `data`

```json
{
  "type": "data",
  "data": "base64-encrypted-payload"
}
```

---

### 4.3 Invite Management (Enrollment Only)

Only `relay-machine` invites are valid.

#### `create_root_invite`

```json
{
  "type": "create_root_invite",
  "inviteType": "relay-machine",
  "relayUrl": "wss://relay.example.com/ws",
  "machineSigningKey": "base64-ed25519-public",
  "machineKeyExchangeKey": "base64-x25519-public",
  "expiresInMs": 86400000,
  "maxUses": 1,
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Relay response:

```json
{
  "type": "root_invite_created",
  "inviteId": "inv-123",
  "inviteToken": "wss://relay.example.com/ws#<TOKEN>",
  "inviteType": "relay-machine"
}
```

#### `list_root_invites`

```json
{
  "type": "list_root_invites",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

#### `revoke_root_invite`

```json
{
  "type": "revoke_root_invite",
  "inviteId": "inv-123",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

---

### 4.4 Owner Sync Protocol

#### Shared Types

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

#### `owner_sync_compare`

```json
{
  "type": "owner_sync_compare",
  "clientIdentityId": "owner-device-01",
  "deviceCertificate": "{...serialized device cert...}",
  "localRevisions": {
    "fundamental": 5,
    "integrations": 2,
    "project/workspace": 19,
    "preferences": 4
  },
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Response:

```json
{
  "type": "owner_sync_compare_result",
  "serverRevisions": {
    "fundamental": 6,
    "integrations": 2,
    "project/workspace": 20,
    "preferences": 4
  },
  "changedCategories": ["fundamental", "project/workspace"]
}
```

#### `owner_sync_pull`

```json
{
  "type": "owner_sync_pull",
  "clientIdentityId": "owner-device-01",
  "deviceCertificate": "{...serialized device cert...}",
  "categories": ["fundamental", "project/workspace"],
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Response:

```json
{
  "type": "owner_sync_pull_result",
  "records": [
    {
      "ownerUserRootId": "user-root-1",
      "category": "fundamental",
      "revision": 6,
      "updatedAt": 1704067200123,
      "writerId": "owner-device-01",
      "checksum": "sha256:abc123",
      "ciphertext": "base64-sealed-payload"
    }
  ]
}
```

#### `owner_sync_lock`

```json
{
  "type": "owner_sync_lock",
  "clientIdentityId": "owner-device-01",
  "deviceCertificate": "{...serialized device cert...}",
  "scope": "global",
  "writerId": "owner-device-01",
  "ttlMs": 15000,
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Response:

```json
{
  "type": "owner_sync_lock_granted",
  "scope": "global",
  "lockId": "lock-123",
  "expiresAt": 1704067215000
}
```

#### `owner_sync_push`

```json
{
  "type": "owner_sync_push",
  "clientIdentityId": "owner-device-01",
  "deviceCertificate": "{...serialized device cert...}",
  "lockId": "lock-123",
  "record": {
    "category": "preferences",
    "expectedRevision": 4,
    "updatedAt": 1704067204000,
    "writerId": "owner-device-01",
    "checksum": "sha256:def456",
    "ciphertext": "base64-sealed-payload"
  },
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Response:

```json
{
  "type": "owner_sync_push_result",
  "category": "preferences",
  "revision": 5,
  "updatedAt": 1704067204000
}
```

#### `owner_sync_unlock`

```json
{
  "type": "owner_sync_unlock",
  "clientIdentityId": "owner-device-01",
  "deviceCertificate": "{...serialized device cert...}",
  "lockId": "lock-123",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

Response:

```json
{ "type": "owner_sync_unlock_result", "released": true }
```

---

### 4.5 Relay -> Machine Notifications

#### `relay_identity`

```json
{
  "type": "relay_identity",
  "publicKey": "base64-ed25519-public",
  "fingerprint": "Kx4f:2nB9:mP3q:vR8s",
  "label": "Relay",
  "challenge": "base64-random-32-bytes"
}
```

#### `client_connected`

```json
{
  "type": "client_connected",
  "connectionId": "conn-123",
  "clientIdentityId": "owner-device-01"
}
```

#### `client_disconnected`

```json
{
  "type": "client_disconnected",
  "connectionId": "conn-123",
  "reason": "Client closed connection"
}
```

---

## 5) X3DH Handshake

After `connection_established`, client and machine exchange handshake messages through relay-routed data.

### `client_hello`

```json
{
  "type": "handshake",
  "phase": "client_hello",
  "data": {
    "clientIdentityKey": "base64-x25519-public",
    "clientEphemeralKey": "base64-x25519-public",
    "targetMachineId": "macbook-01"
  }
}
```

### `server_hello`

```json
{
  "type": "handshake",
  "phase": "server_hello",
  "data": {
    "serverIdentityKey": "base64-x25519-public",
    "serverEphemeralKey": "base64-x25519-public",
    "serverSigningKey": "base64-ed25519-public"
  }
}
```

### `client_auth`

```json
{
  "type": "handshake",
  "phase": "client_auth",
  "data": {
    "signature": "base64-ed25519-signature",
    "signingKey": "base64-ed25519-public"
  }
}
```

### `server_auth`

```json
{
  "type": "handshake",
  "phase": "server_auth",
  "data": {
    "signature": "base64-ed25519-signature",
    "permissions": {
      "read": true,
      "write": true,
      "manage": true
    }
  }
}
```

---

## 6) Encrypted Frame Format

After handshake, terminal traffic uses encrypted frames:

```
Bytes 0-3:   stream ID (uint32 BE)
Bytes 4-15:  nonce (12 bytes)
Bytes 16+:   AES-256-GCM ciphertext + 16-byte auth tag
```

Stream IDs:

- `0`: master terminal stream
- `1+`: reserved

---

## 7) Error Codes

| Code | Meaning |
|---|---|
| `FORBIDDEN` | Caller is not owner for operation |
| `NOT_FOUND` | Machine/invite/record not found |
| `INVALID` | Invite invalid, expired, exhausted, or malformed |
| `INVALID_SIGNATURE` | Signature verification failed |
| `OFFLINE` | Machine is not connected |
| `CONFLICT` | Expected revision mismatch |
| `LOCKED` | Write denied by lock ownership |

---

## 8) Cryptographic Primitives

| Purpose | Algorithm | Details |
|---|---|---|
| Identity signing | Ed25519 | 32-byte public, 64-byte secret |
| Key exchange | X25519 | 32-byte keys |
| Symmetric encryption | AES-256-GCM | 12-byte nonce, 16-byte tag |
| Key derivation | HKDF-SHA256 | domain-separated send/recv keys |
| Relay challenge signing | Ed25519 | machine signs relay nonce |

---

Last updated: 2026-02
