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
6. Relay sends `registered` confirmation

### Client Routing
1. Client connects with `?role=client`
2. Client signs relay messages (see "Message Signing")
3. Relay verifies the signature and binds `clientIdentityId` to the signing key
4. Relay routes via owner+ACL authorization

---

## Message Types

All messages are JSON. The relay routes based on message type.

### Message Signing (Protocol v2)

The following client messages require an Ed25519 signature block:
- `list_machines`
- `connect_to_machine`
- `unlock_relay`

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

#### Machine Registration Challenge
Relay sends `relay_identity` with a challenge nonce. Machines must include the
nonce signature in `register_machine.challengeResponse`.

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

#### Root Invite Management (Client-signed)

Root-signed invites are managed by clients through relay commands:
- `create_root_invite`
- `list_root_invites`
- `revoke_root_invite`
- `accept_root_invite`

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
      "accessType": "view",
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

#### Client Connected
```json
{
  "type": "client_connected",
  "connectionId": "conn-123",
  "clientIdentityId": "client-xyz"
}
```

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
    "authorization": { "type": "access_list" }
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
│  5. Wait for client_connected notifications                                  │
│  6. Handle handshakes and route data                                         │
│  7. On disconnect: relay marks machine offline                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  CLIENT LIFECYCLE                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Connect to relay (ws://...?role=client)                                  │
│  2. Send connect_to_machine (signed)                                         │
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
| `unlock_request` | Machine | Handled by relay |
| `connect_*` | Client | Handled by relay |
| `list_machines` | Client | Handled by relay |
| `unlock_relay` | Client | Handled by relay |
| `data` | Machine | Target client (by connectionId) |
| `data` | Client | Connected machine |
| `handshake` | Client | Connected machine (wrapped in data) |
| `challenge` | Relay | Target machine |
| `unlock_grant` | Relay | Target machine |

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
