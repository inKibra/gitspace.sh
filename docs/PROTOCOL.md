# Relay Protocol Reference

This document describes the WebSocket protocol between machines, clients, and the relay server.

---

## Connection URLs

```
Machine: ws://relay:port/ws?role=machine
Client:  ws://relay:port/ws?role=client
```

---

## Authentication

### Machine Registration
1. Machine connects with `?role=machine`
2. Relay sends `relay_identity` with a random challenge nonce
3. Machine signs the nonce with its Ed25519 private key
4. Machine sends `register_machine` including `challengeResponse`
5. Relay verifies the signature and checks the signing key is authorized
6. Relay sends `registered` confirmation and `access_list`

### Client Routing
1. Client connects with `?role=client`
2. Client signs relay messages (see "Message Signing")
3. Relay verifies the signature and binds `clientIdentityId` to the signing key
4. Relay routes via invite or direct authorization

---

## Message Types

All messages are JSON. The relay routes based on message type.

### Message Signing (Protocol v2)

The following client messages require an Ed25519 signature block:
- `list_machines`
- `connect_with_invite`
- `connect_to_machine`

Signature format:
```json
{
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```

### Machine → Relay

#### Challenge Response (Deprecated)
Relay sends `relay_identity` with a challenge nonce; machines should include the
signature in `register_machine.challengeResponse`. The standalone
`challenge_response` message is deprecated.
```json
{
  "type": "challenge_response",
  "signature": "base64-ed25519-signature-of-nonce"
}
```
Response: `{ "type": "registered", "machineId": "abc123" }`

#### Register Machine
```json
{
  "type": "register_machine",
  "machineId": "abc123",
  "signingKey": "base64-ed25519-public",
  "keyExchangeKey": "base64-x25519-public",
  "challengeResponse": "base64-ed25519-signature-of-nonce",
  "label": "My MacBook"
}
```
Response: `{ "type": "registered", "machineId": "abc123" }`

After successful registration, relay sends the global access list:
```json
{
  "type": "access_list",
  "entries": [
    {
      "clientIdentityId": "client-xyz",
      "signingKey": "base64-ed25519-public",
      "keyExchangeKey": "base64-x25519-public",
      "label": "Brad's Phone",
      "accessType": "full",
      "grantedAt": 1704067200000
    }
  ]
}
```

#### Register Invite
```json
{
  "type": "register_invite",
  "inviteId": "hash-of-token",
  "machineId": "abc123",
  "expiresAt": 1704067200000,
  "maxUses": 5
}
```
Response: `{ "type": "registered", "machineId": "abc123" }`

#### Authorize Client
```json
{
  "type": "authorize_client",
  "machineId": "abc123",
  "clientIdentityId": "client-xyz",
  "signingKey": "base64-ed25519-public",
  "keyExchangeKey": "base64-x25519-public",
  "permissions": { "read": true, "write": true, "manage": false }
}
```
Response: `{ "type": "client_authorized", "clientIdentityId": "client-xyz" }`

#### Revoke Client
```json
{
  "type": "revoke_client",
  "machineId": "abc123",
  "clientIdentityId": "client-xyz"
}
```
Response: `{ "type": "client_revoked", "clientIdentityId": "client-xyz" }`

#### Add Global Access
Grant a client access to all machines on this account:
```json
{
  "type": "add_global_access",
  "clientIdentityId": "client-xyz",
  "signingKey": "base64-ed25519-public",
  "keyExchangeKey": "base64-x25519-public",
  "label": "Brad's Phone",
  "accessType": "full",
  "machineIds": ["abc123", "def456"]
}
```
`accessType`: `"full"` or `"session-invite"`
`machineIds`: Optional - if set, only applies to specific machines
Response: `{ "type": "client_authorized", "clientIdentityId": "client-xyz" }`

#### Remove Global Access
```json
{
  "type": "remove_global_access",
  "clientIdentityId": "client-xyz"
}
```
Response: `{ "type": "client_revoked", "clientIdentityId": "client-xyz" }`

#### Send Data to Client
```json
{
  "type": "data",
  "connectionId": "conn-123",
  "data": "base64-encrypted-payload"
}
```

---

### Client → Relay

#### Connect with Invite
```json
{
  "type": "connect_with_invite",
  "inviteId": "hash-of-token",
  "clientIdentityId": "client-xyz",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```
Response: `{ "type": "connection_established", "machineId": "abc123", "connectionId": "conn-123" }`

#### Connect to Machine (Direct)
```json
{
  "type": "connect_to_machine",
  "machineId": "abc123",
  "clientIdentityId": "client-xyz",
  "signature": {
    "sig": "base64-ed25519-signature",
    "pub": "base64-ed25519-public",
    "ts": 1704067200000
  }
}
```
Response: `{ "type": "connection_established", "machineId": "abc123", "connectionId": "conn-123" }`

#### List Machines
```json
{
  "type": "list_machines",
  "clientIdentityId": "client-xyz",
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
  "type": "machine_list",
  "machines": [
    {
      "machineId": "abc123",
      "label": "My MacBook",
      "online": true,
      "isAuthorized": true,
      "accessType": "full",
      "lastConnectedAt": 1704067200000
    },
    {
      "machineId": "def456",
      "label": "Server",
      "online": false,
      "isAuthorized": true,
      "accessType": "session-invite",
      "sessionId": "session-123",
      "lastConnectedAt": 1704060000000
    }
  ]
}
```
Note: Only machines the client is authorized for are returned.

#### Send Data to Machine
```json
{
  "type": "data",
  "data": "base64-encrypted-payload"
}
```

---

### Relay → Machine

#### Relay Identity
Sent immediately after a machine connects. Includes relay signing key and a challenge nonce.
```json
{
  "type": "relay_identity",
  "publicKey": "base64-ed25519-public",
  "fingerprint": "Kx4f:2nB9:mP3q:vR8s",
  "label": "Relay",
  "challenge": "base64-random-32-bytes"
}
```
The machine must respond by sending `register_machine` with `challengeResponse`.

#### Access List
Sent after successful registration with all authorized clients:
```json
{
  "type": "access_list",
  "entries": [
    {
      "clientIdentityId": "client-xyz",
      "signingKey": "base64-ed25519-public",
      "keyExchangeKey": "base64-x25519-public",
      "label": "Brad's Phone",
      "accessType": "full",
      "sessionId": null,
      "grantedAt": 1704067200000
    }
  ]
}
```

#### Access Update
Incremental update when global access changes:
```json
{
  "type": "access_update",
  "added": [
    {
      "clientIdentityId": "new-client",
      "signingKey": "base64-ed25519-public",
      "keyExchangeKey": "base64-x25519-public",
      "label": "New Device",
      "accessType": "full",
      "grantedAt": 1704067200000
    }
  ],
  "removed": ["old-client-id"]
}
```

#### Client Connected
```json
{
  "type": "client_connected",
  "connectionId": "conn-123",
  "clientIdentityId": "client-xyz",
  "viaInvite": "invite-id"
}
```
`viaInvite` is optional - only present when connecting via invite.

#### Client Disconnected
```json
{
  "type": "client_disconnected",
  "connectionId": "conn-123",
  "reason": "Client closed connection"
}
```

#### Data from Client
```json
{
  "type": "data",
  "connectionId": "conn-123",
  "data": "base64-encrypted-payload"
}
```

---

### Relay → Client

#### Connection Established
```json
{
  "type": "connection_established",
  "machineId": "abc123",
  "connectionId": "conn-123"
}
```

#### Connection Failed
```json
{
  "type": "error",
  "code": "OFFLINE",
  "message": "Machine is offline"
}
```

#### Data from Machine
```json
{
  "type": "data",
  "data": "base64-encrypted-payload"
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| `FORBIDDEN` | Role doesn't allow this action |
| `NOT_FOUND` | Machine/invite/client not found |
| `INVALID` | Invite expired or exhausted |
| `OFFLINE` | Machine is not connected |

---

## Handshake Protocol (X3DH)

After `connection_established`, client and machine perform X3DH handshake:

### Phase 1: Client Hello
```json
{
  "type": "handshake",
  "phase": "client_hello",
  "data": {
    "clientIdentityKey": "base64-x25519-public",
    "clientEphemeralKey": "base64-x25519-public",
    "targetMachineId": "abc123"
  }
}
```

### Phase 2: Server Hello
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

### Phase 3: Client Auth
```json
{
  "type": "handshake",
  "phase": "client_auth",
  "data": {
    "signature": "base64-ed25519-signature",
    "signingKey": "base64-ed25519-public",
    "inviteToken": "base64url-invite"  // if connecting via invite
  }
}
```

### Phase 4: Server Auth
```json
{
  "type": "handshake",
  "phase": "server_auth",
  "data": {
    "signature": "base64-ed25519-signature",
    "permissions": { "read": true, "write": true, "manage": false }
  }
}
```

After server_auth, both sides derive session keys and switch to encrypted communication.

---

## Encrypted Frame Format

After handshake, all data is encrypted frames:

```
┌──────────────────────────────────────────────────────────────┐
│  Encrypted Frame Structure                                    │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Bytes 0-3:    Stream ID (4 bytes, big-endian)               │
│  Bytes 4-15:   Nonce (12 bytes, random)                      │
│  Bytes 16+:    Ciphertext (AES-256-GCM)                      │
│               ├── Encrypted payload                          │
│               └── 16-byte auth tag (appended)                │
│                                                               │
│  Minimum frame length: 32 bytes (4 + 12 + 16)                │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

Stream IDs:
- `0`: Master stream (full machine access)
- `1+`: Share streams (session-specific access)

---

## Session Frame Types

Within an encrypted session, two frame types are used:

### PTY Frames (Type 0x00)
```
┌────────────────────────────────────────────────────────────┐
│  Frame Type    │  Length (4 bytes BE)  │  Payload          │
│  0x00          │  N                    │  Raw terminal I/O │
└────────────────────────────────────────────────────────────┘
```

### Control Frames (Type 0x01)
```
┌────────────────────────────────────────────────────────────┐
│  Frame Type    │  Length (4 bytes BE)  │  JSON Payload     │
│  0x01          │  N                    │  Control message  │
└────────────────────────────────────────────────────────────┘
```

Control message example (resize):
```json
{
  "type": "resize",
  "cols": 120,
  "rows": 40
}
```

---

## Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MACHINE LIFECYCLE                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Connect to relay (ws://...?role=machine)                                 │
│  2. Receive relay_identity with challenge                                    │
│  3. Send register_machine (challengeResponse + keys)                         │
│  4. Receive "registered" confirmation                                        │
│  5. Optionally register invites                                              │
│  6. Wait for client_connected notifications                                  │
│  7. Handle handshakes and route data                                         │
│  8. On disconnect: relay marks machine offline                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  CLIENT LIFECYCLE                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Connect to relay (ws://...?role=client)                                  │
│  2. Send connect_with_invite OR connect_to_machine (signed)                  │
│  3. Receive connection_established (or error)                                │
│  4. Perform X3DH handshake                                                   │
│  5. Exchange encrypted terminal data                                         │
│  6. On disconnect: relay notifies machine                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Keepalive

The relay sends periodic WebSocket ping frames. Machines and clients should:
- Respond to ping frames with pong (handled automatically by most WebSocket libraries)
- Consider connection dead after 30 seconds without pong response
- Reconnect automatically on connection loss

---

## Routing Rules

The relay routes messages based on:

| Message Type | From | Routed To |
|--------------|------|-----------|
| `register_*` | Machine | Handled by relay |
| `authorize_client` | Machine | Handled by relay |
| `revoke_client` | Machine | Handled by relay |
| `add_global_access` | Machine | Handled by relay → broadcasts to all machines |
| `remove_global_access` | Machine | Handled by relay → broadcasts to all machines |
| `challenge_response` | Machine | Handled by relay |
| `connect_*` | Client | Handled by relay |
| `list_machines` | Client | Handled by relay |
| `data` | Machine | Target client (by connectionId) |
| `data` | Client | Connected machine |
| `handshake` | Client | Connected machine (wrapped in data) |
| `challenge` | Relay | Target machine |
| `access_list` | Relay | Target machine |
| `access_update` | Relay | All connected machines |

---

## Cryptographic Primitives

| Purpose | Algorithm | Details |
|---------|-----------|---------|
| Identity signing | Ed25519 | 32-byte public key, 64-byte secret key |
| Key exchange | X25519 | 32-byte keys |
| Symmetric encryption | AES-256-GCM | 12-byte nonce, 16-byte auth tag |
| Key derivation | HKDF-SHA256 | Domain-separated for send/receive keys |
| Relay challenge signing | Ed25519 | Machine signs relay nonce |
| Client message signing | Ed25519 | Signed list/connect messages |

---

---

## Inbox & Notification Protocol

The tmux-lite server tracks terminal events and maintains an inbox for notifications.

### Supported OSC Sequences

| Sequence | Source | Description |
|----------|--------|-------------|
| `OSC 777;exit:<code>` | Custom | Process exit with code |
| `OSC 9` | iTerm2/Growl | Notification message |
| `OSC 99` | Kitty | Notification |
| `OSC 777;notify` | rxvt | Notification |
| `OSC 133 D` | Semantic shell | Command done |
| `BEL` (0x07) | Terminal | Bell (debounced 500ms) |

### Inbox Item Types

```typescript
type InboxItemType = 'bell' | 'title_change' | 'idle' | 'exit';

interface InboxItem {
  id: string;
  sessionId: string;
  sessionName: string;
  type: InboxItemType;
  timestamp: number;
  read: boolean;
  context?: string;       // Additional context
  processTitle?: string;  // Current process title
  exitCode?: number;      // For 'exit' type
}
```

### Control Messages

```json
{ "type": "get_inbox" }
{ "type": "clear_inbox" }
{ "type": "mark_inbox_read", "itemId": "..." }
```

---

*Protocol version: 2*
*Last updated: 2025-01*
