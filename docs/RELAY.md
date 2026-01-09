# Relay Server Design

The relay is the bridge between your machine and remote clients. It routes E2E encrypted terminal sessions between machines and clients over WebSocket.

---

## The Big Picture

```
                              Cloudflare (optional)
                        (TLS termination, DDoS protection)
                                      │
                                      ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Your Mac       │◀═════▶│  Relay Server   │◀═════▶│  Browser/CLI    │
│                 │  wss  │                 │  wss  │                 │
│  gssh serve     │       │  Routes by:     │       │  Terminal view  │
│  (PTY sessions) │       │  - machine ID   │       │  (xterm.js)     │
│                 │       │  - connection   │       │                 │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

Your machine maintains a single persistent WebSocket to the relay. Terminal I/O flows over that connection as encrypted bytes. The relay is just a router - it cannot decrypt any content.

---

## Design Decisions

### Why One Connection from Machine?

**Single multiplexed WebSocket** rather than connection-per-session because:

1. **Simpler firewall/NAT traversal** - One outbound connection, no port opening
2. **Easier reconnection** - One reconnect restores everything
3. **Lower overhead** - WebSocket framing once, not per-session
4. **Single TLS handshake** - Less CPU on both ends

The machine-to-relay connection is the "trunk line." All client connections are multiplexed over it via `connectionId`.

### Why Relay Can't See Terminal Content?

The relay forwards encrypted bytes for terminal sessions. It never decrypts. This is critical for:

1. **Zero-knowledge** - We can't see your commands, secrets, or output
2. **Security** - Compromised relay can't read terminal traffic
3. **Trust** - Users can verify encryption client-side

See [PROTOCOL.md](./PROTOCOL.md) for the encryption protocol details.

---

## Connection Types

### 1. Machine Connection

When `gssh serve` starts, it opens a WebSocket to `ws://relay:port/ws?role=machine`:

```
→ Relay sends relay_identity with challenge nonce
→ Machine signs nonce with Ed25519 private key
→ Machine sends register_machine with signingKey/keyExchangeKey + challengeResponse
→ Relay verifies signature and that signingKey is authorized
→ Relay sends access_list with authorized clients
→ Machine is now registered and ready
```

The machine ID is derived from the machine's signing key. This ensures identity consistency across reconnects.

### 2. Client Connection

Browser or CLI connects to `ws://relay:port/ws?role=client`:

```
→ Sign list/connect messages with Ed25519 identity
→ Connect via invite OR directly (if pre-authorized)
→ Relay routes to the target machine
→ Perform X3DH handshake with machine
→ Exchange E2E encrypted terminal data
```

The relay verifies signatures, checks authorization, and creates a bidirectional pipe. It doesn't decrypt the content.

---

## Routing Architecture

The relay maintains four registries:

### Machine Registry
```typescript
machines: Map<machineId, {
  accountId: string,
  signingKey: string,      // Ed25519 public key
  keyExchangeKey: string,  // X25519 public key
  label: string,
  ws: WebSocket | null,    // null = offline
  lastSeen: Date
}>
```

### Invite Registry
```typescript
invites: Map<inviteId, {
  machineId: string,
  expiresAt: number,
  maxUses: number,
  usedCount: number
}>
```

### Machine Authorization Registry
Per-machine client access:
```typescript
authorizations: Map<machineId, Map<clientIdentityId, {
  signingKey: string,
  keyExchangeKey: string,
  accessType: 'full' | 'session-invite',
  sessionId?: string,
  label?: string,
  grantedAt: number
}>>
```

### Global Access Registry
Account-level access that applies to all machines:
```typescript
globalAccess: Map<accountId, Map<clientIdentityId, {
  signingKey: string,
  keyExchangeKey: string,
  accessType: 'full' | 'session-invite',
  label?: string,
  grantedAt: number,
  machineIds?: string[]  // If set, only applies to specific machines
}>>
```

When a machine connects, it receives the combined access list from both registries.

---

## Data Flow

### Client → Machine

```
Client sends:    { type: "data", data: "base64-encrypted" }
Relay wraps:     { type: "data", connectionId: "xyz", data: "base64-encrypted" }
Machine receives with connectionId to identify the client
```

### Machine → Client

```
Machine sends:   { type: "data", connectionId: "xyz", data: "base64-encrypted" }
Relay unwraps:   { type: "data", data: "base64-encrypted" }
Client receives without connectionId (it's their only connection)
```

The `connectionId` is assigned by the relay when a client connects and is used to multiplex multiple clients over the single machine WebSocket.

---

## Connection Health

### Machine Keepalive

WebSocket protocol ping/pong:
- Machine sends ping every 30 seconds
- Relay responds with pong
- If no traffic for 60 seconds, machine reconnects

### Client Keepalive

Same pattern. Relay pings clients, clients respond.

### Reconnection

When machine reconnects:
1. Re-authenticates with same account
2. Re-registers with same signing key (must match)
3. Relay updates routing tables
4. Connected clients receive notification or continue streaming

When machine goes offline:
1. Relay marks machine's `ws` as `null`
2. All connected clients receive `connection_failed`
3. Client connections are closed

---

## Auth Model

### Machine Authentication

1. Relay sends `relay_identity` with a random challenge nonce
2. Machine signs the nonce with its Ed25519 private key
3. Machine sends `register_machine` with signing keys + challengeResponse
4. Relay verifies the signature and checks the signing key is authorized

### Client Authentication

Clients sign relay messages with their Ed25519 identity. Then either:

1. **Via Invite** - `connect_with_invite` with invite ID
   - Relay validates invite exists and isn't expired/exhausted
   - Relay decrements use count
   - Routes to target machine

2. **Direct** - `connect_to_machine` with machine ID + client identity
   - Relay checks both per-machine and global authorization registries
   - Client must be pre-authorized

### Authorization Flow

1. Client connects with invite → routed to machine
2. Machine performs X3DH handshake, validates invite signature
3. Machine sends `authorize_client` to relay (unless single-use invite)
4. Client is now authorized for future direct connections

### Global Access Flow

1. Machine owner sends `add_global_access` via any connected machine
2. Relay adds to global access registry
3. Relay broadcasts `access_update` to all connected machines in the account
4. All machines update their local access lists immediately

---

## Relay CLI Commands

The relay server and its management are controlled via the `gssh relay` command group:

| Command | Description |
|---------|-------------|
| `gssh relay start` | Start the relay server |
| `gssh relay authorize <pubkey>` | Authorize a machine by its public key |
| `gssh relay revoke <pubkey>` | Revoke a machine's authorization |
| `gssh relay machines` | List authorized machines |
| `gssh relay trusted` | List trusted relays (client-side) |
| `gssh relay untrust <url>` | Remove relay trust (client-side) |

**Note:** There is no separate `gssh machine` command group. Machine authorization is managed through the relay commands above.

---

## Error States

| Situation | Response |
|-----------|----------|
| Invalid signature | `{ type: "error", code: "INVALID_SIGNATURE" }` |
| Machine offline | `{ type: "error", code: "OFFLINE" }` |
| Invite not found | `{ type: "error", code: "NOT_FOUND" }` |
| Invite expired | `{ type: "error", code: "INVALID" }` |
| Not authorized | `{ type: "error", code: "FORBIDDEN" }` |
| Machine re-registration conflict | `{ success: false, error: "..." }` |

---

## Health Check Endpoint

```
GET /health
```

Returns:
```json
{
  "machineCount": 5,
  "onlineMachineCount": 3,
  "inviteCount": 12,
  "authorizationCount": 8,
  "connectedClients": 7
}
```

---

## Implementation Notes

Using Bun APIs:
- `Bun.serve()` with `websocket` handler for all WS connections
- `fetch` handler for health check and static file serving
- WebSocket `data` field holds connection metadata
- All state in memory Maps (no database for MVP)

The server is essentially:
1. Parse incoming connection (machine or client?)
2. Route to appropriate handler
3. Maintain registries of connections
4. Forward messages between matched pairs

---

## Current Features

### Cloudflare Hosting (Implemented)

Users can expose their machine at `yourname.gitspace.sh`:
- `gssh auth login` - Authenticate with GitHub
- `gssh host reserve <name>` - Reserve a subdomain
- `gssh serve` - Connects to gitspace.sh relay + Cloudflare tunnel

See [GATEWAY-WORKER.md](./GATEWAY-WORKER.md) for the gateway architecture.

---

## Future Considerations

### Scaling

Single relay works for MVP. For scale:
- Consistent hash machines to specific relay pods
- Redis/Valkey for cross-pod routing info
- Load balancer with sticky sessions

### Port Tunnels (Not Yet Implemented)

Future feature to expose `localhost:3000` at a public URL:
- HTTP request proxying
- WebSocket tunneling for HMR
- Subdomain allocation per service

See [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) for the full vision.

---

*Last updated: 2025-01*
