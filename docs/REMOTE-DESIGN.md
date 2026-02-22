# GitSpace Remote Access Design

This document describes the architecture for GitSpace remote access - enabling users to securely access their terminal sessions from any device using end-to-end encryption.

## Overview

GitSpace enables developers to run persistent terminal sessions on their local machine and access them remotely from any browser or CLI client. The system uses **identity-based access control** with **X3DH key exchange** for end-to-end encryption, ensuring that even the relay service cannot read terminal content.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          GITSPACE REMOTE ACCESS                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  LOCAL MACHINE              RELAY                      REMOTE ACCESS        │
│  ┌─────────────────┐       ┌─────────────────┐        ┌─────────────────┐   │
│  │ gssh machine serve start --foreground      │       │ WebSocket relay │        │ Browser         │   │
│  │ └─ tmux-lite    │◀═════▶│ (blind router)  │◀══════▶│ CLI             │   │
│  │    server       │  E2E  │                 │  E2E   │ TUI             │   │
│  └─────────────────┘       └─────────────────┘        └─────────────────┘   │
│                                                                              │
│  Ed25519/X25519 keys       Routes encrypted           X3DH handshake       │
│  stored locally            bytes only                 per connection       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Security Model

### Identity-Based Access

Unlike password-based systems, GitSpace uses cryptographic identities for access control:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  IDENTITY-BASED ACCESS CONTROL                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Each machine/client has an IDENTITY:                                        │
│  ├── Ed25519 signing keypair (proves identity)                              │
│  ├── X25519 key exchange keypair (establishes encryption)                   │
│  └── Unique identifier (derived from signing public key)                    │
│                                                                              │
│  Access is granted by USER ROOT identity, not passwords:                    │
│  • Machine owner runs: gssh machine access add <gssh-user:...>              │
│  • Client can now connect and perform X3DH handshake                        │
│  • No shared secrets needed - cryptographic proof of identity               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Two-Layer Security

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Layer 1: RELAY AUTHENTICATION                                               │
│  ─────────────────────────────                                               │
│                                                                              │
│  • Pre-authorized machine keys + challenge-response                          │
│  • Signed client messages bind identity IDs                                  │
│  • Validates WHO can connect to relay                                        │
│  • Enables routing, machine registry, access lists                          │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Layer 2: E2E ENCRYPTION (X3DH)                                              │
│  ─────────────────────────────                                               │
│                                                                              │
│  • X3DH handshake per connection                                             │
│  • Client proves identity via Ed25519 signature                              │
│  • Machine verifies client is in access list                                 │
│  • Session keys derived via HKDF                                             │
│  • All terminal I/O encrypted with AES-256-GCM                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Access Types

| Access Type | Description | Capabilities |
|-------------|-------------|--------------|
| `full` | Permanent access grant | Browse all projects/workspaces, create/attach/kill sessions, manage access |

### What the Relay Can See

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RELAY VISIBILITY                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ✓ VISIBLE (metadata for routing):        ✗ HIDDEN (encrypted):            │
│  • Machine ID                              • Terminal content               │
│  • Client identity ID                      • Keystrokes                     │
│  • Connection timestamps                   • Commands and output            │
│  • Data volume (bytes)                     • File contents                  │
│  • Online/offline status                   • Session names                  │
│  • ACL + invite metadata                   • Workspace information          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Cryptographic Protocol

### Primitives

| Primitive | Algorithm | Use |
|-----------|-----------|-----|
| Identity Signing | Ed25519 | Prove identity, sign challenges |
| Key Exchange | X25519 | ECDH for shared secrets |
| Password KDF | Scrypt (N=2^15, r=8, p=1) | Encrypt keypair at rest |
| Session Key Derivation | HKDF-SHA256 | Derive session keys from X3DH |
| Symmetric Encryption | AES-256-GCM | Frame encryption |
| Nonce | 12 bytes random | Per-frame freshness |
| Relay Message Signing | Ed25519 | Machine challenge + client messages |

### X3DH Handshake

After a client connects through the relay, X3DH establishes session encryption:

```
┌───────────────────────────────────────────────────────────────────────────┐
│  X3DH KEY EXCHANGE                                                         │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  CLIENT                                  MACHINE                           │
│  ──────                                  ───────                           │
│                                                                            │
│  1. Generate ephemeral X25519 keypair                                      │
│                                                                            │
│  2. Send client_hello:                                                     │
│     ├── clientIdentityKey (X25519)      ───────────────────────────────▶  │
│     └── clientEphemeralKey (X25519)                                        │
│                                                                            │
│                                          3. Verify client in access list   │
│                                                                            │
│                                          4. Generate ephemeral keypair     │
│                                                                            │
│  5. Receive server_hello:               ◀───────────────────────────────   │
│     ├── serverIdentityKey (X25519)                                         │
│     ├── serverEphemeralKey (X25519)                                        │
│     └── serverSigningKey (Ed25519)                                         │
│                                                                            │
│  6. Compute shared secrets:              6. Compute shared secrets:        │
│     DH1 = ephemeral × serverIdentity        DH1 = identity × clientEphem  │
│     DH2 = ephemeral × serverEphemeral       DH2 = ephemeral × clientEphem │
│     DH3 = identity × serverEphemeral        DH3 = ephemeral × clientIdent │
│                                                                            │
│  7. Sign transcript                      ◀───────────────────────────────  │
│     Send client_auth:                                                      │
│     ├── Ed25519 signature                                                  │
│     ├── signingPublicKey                                                   │
│     └── authorization metadata (ACL-backed)                                │
│                                                                            │
│                                          8. Verify signature               │
│                                          9. Check ACL policy again         │
│                                                                            │
│  10. Receive server_auth:               ◀───────────────────────────────   │
│      ├── Ed25519 signature                                                 │
│      └── accessType (full)                                                 │
│                                                                            │
│  11. Both derive session keys via HKDF                                     │
│      ├── sendKey (client → machine)                                        │
│      ├── receiveKey (machine → client)                                     │
│      └── sessionId (for correlation)                                       │
│                                                                            │
│  ════════════════════ ENCRYPTED CHANNEL ESTABLISHED ═══════════════════   │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### Key Derivation

**Two algorithms are used for different purposes:**

1. **Scrypt** - For password-based encryption of the identity keypair file
2. **HKDF-SHA256** - For deriving session keys from X3DH shared secrets

#### Password-Based Key Derivation (Scrypt)

The identity keypair is encrypted at rest using scrypt:

```typescript
import { scrypt } from 'node:crypto';

// Scrypt parameters (strong defaults)
const N = 2 ** 15;  // CPU/memory cost
const r = 8;        // Block size
const p = 1;        // Parallelization

// Derive encryption key from password
const salt = randomBytes(16);
const key = scrypt(password, salt, 32, { N, r, p });

// Encrypt keypair with AES-256-GCM using derived key
```

#### Session Key Derivation (HKDF-SHA256)

After X3DH handshake, session keys are derived using HKDF:

```typescript
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

// After X3DH, both sides have shared secret material
const sharedSecret = concat(DH1, DH2, DH3);  // 96 bytes
const transcript = concat(clientHello, serverHello);

// Derive session keys using HKDF with domain separation
const masterSecret = hkdf(sha256, sharedSecret, transcript, 'spaces-v1-master', 32);
const sendKey = hkdf(sha256, masterSecret, 'send', 'spaces-v1-send', 32);
const receiveKey = hkdf(sha256, masterSecret, 'recv', 'spaces-v1-receive', 32);
const sessionId = hkdf(sha256, masterSecret, 'session', 'spaces-v1-session-id', 16);
```

### Encrypted Frame Format

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Encrypted Frame Structure                                                  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Bytes 0-3:    Stream ID (4 bytes, big-endian)                             │
│  Bytes 4-15:   Nonce (12 bytes, random)                                    │
│  Bytes 16+:    Ciphertext (AES-256-GCM)                                    │
│               ├── Encrypted payload                                        │
│               └── 16-byte authentication tag (appended)                    │
│                                                                             │
│  Minimum frame: 32 bytes (4 + 12 + 16)                                     │
│                                                                             │
│  Stream IDs:                                                                │
│  • 0: Master stream (full machine access)                                  │
│  • 1+: Reserved for future share streams                                   │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Machine Daemon (`gssh machine serve start --foreground`)

**Location:** User's local machine
**Role:** Session management, PTY handling, encryption endpoint

```
src/
├── commands/serve.ts           # CLI command, daemon entry
├── serve/
│   ├── daemon.ts               # PID/socket management, status server
│   ├── client-session-manager.ts # Handle client connections
│   └── pty-session.ts          # PTY session lifecycle
└── lib/tmux-lite/
    ├── server.ts               # Session manager with xterm-headless
    ├── handshake-handler.ts    # X3DH implementation
    ├── relay-client.ts         # WebSocket connection to relay
    └── crypto/                 # Encryption primitives
```

Key responsibilities:
- Maintain persistent connection to relay
- Handle X3DH handshakes with clients
- Manage PTY sessions via xterm-headless
- Encrypt all outbound terminal data
- Track access list and verify clients

### 2. Relay Server

**Location:** gitspace.sh cloud (or self-hosted)
**Role:** Authentication, routing, blind relay

```
src/relay/
├── server.ts                   # WebSocket routing server
├── protocol.ts                 # Message type definitions
├── registries.ts               # Machine/client/access registries
├── authorization.ts            # Relay authorization helpers
└── types.ts                    # Type definitions
```

Key responsibilities:
- Authenticate machines (Ed25519 challenge-response)
- Verify signed client messages
- Route encrypted bytes between parties
- Maintain machine registry (online/offline)
- Broadcast global access list updates

### 3. Web Client

**Location:** Browser
**Role:** User interface, decryption endpoint

```
web/
├── index.html                  # Vite entry document
└── main.tsx                    # Lightweight web entrypoint

src/
├── app.web.tsx                 # Main web application
├── hooks/
│   ├── useRelayConnection.web.ts
│   └── useTerminal.web.ts
├── components/
│   └── SessionTerminal.web.tsx
└── session/crypto/             # Client-side X3DH + encryption
```

Key responsibilities:
- Connect to relay and sign routing messages
- Perform X3DH handshake with machine
- Decrypt and render terminal output
- Encrypt and send user input

### 4. CLI/TUI Client

**Location:** User's device (terminal)
**Role:** Native terminal access

```
src/
├── commands/connect.ts         # CLI connect command
├── tui/
│   ├── app.tsx                 # TUI application
│   ├── hooks/useRemoteMachines.ts
│   └── hooks/useRemoteTerminal.ts
└── shared/
    ├── relay/                  # Shared relay directory client/hooks
    └── session/                # Shared session backends + engine
```

---

## Access Control

### Granting Access

```bash
# Grant relay membership
gssh relay access add gssh-user:BASE64_SIGNING_KEY --label "Brad's Phone"

# Grant machine full access
gssh machine access add gssh-user:BASE64_SIGNING_KEY --label "Brad's Phone"
```

### ACL Storage

Persistent grants are user-root keyed:

```typescript
interface RelayAccessGrant {
  ownerUserRootId: string;
  clientUserRootId: string;
  label?: string;
  grantedAt: number;
}

interface MachineAccessGrant {
  machineId: string;
  ownerUserRootId: string;
  clientUserRootId: string;
  role: 'full';
  label?: string;
  grantedAt: number;
}
```

Access is granted via owner-managed ACL entries and root-signed invite acceptance.

---

## Connection Flow

### Machine Connection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MACHINE → RELAY CONNECTION                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Connect to relay: wss://relay/ws?role=machine                           │
│                                                                              │
│  2. Relay sends relay_identity with challenge nonce                         │
│                                                                              │
│  3. Machine signs nonce with Ed25519 private key                            │
│                                                                              │
│  4. Machine sends register_machine with challengeResponse + keys            │
│                                                                              │
│  5. Relay verifies signature and signing key authorization                  │
│                                                                              │
│  6. Relay sends: { type: "registered", machineId }                          │
│                                                                              │
│  7. Relay sends access_list with all authorized clients                     │
│                                                                              │
│  8. Machine is now online and accepting connections                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Client Connection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLIENT → MACHINE CONNECTION                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Client connects: wss://relay/ws?role=client                              │
│                                                                              │
│  2. Client sends: { type: "list_machines", clientIdentityId, signature }    │
│                                                                              │
│  3. Relay returns machine_list with authorized machines                     │
│                                                                              │
│  4. Client sends: { type: "connect_to_machine", machineId, signature }      │
│                                                                              │
│  5. Relay sends machine: { type: "client_connected", connectionId, ... }    │
│                                                                              │
│  6. Relay sends client: { type: "connection_established", connectionId }    │
│                                                                              │
│  7. Client and machine perform X3DH handshake (routed through relay)        │
│                                                                              │
│  8. On success: encrypted terminal session established                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Daemon Management

The `gssh machine serve start --foreground` command can run as a daemon with status monitoring:

### Status Socket Protocol

```typescript
// Status query via Unix socket at ~/gitspace/.serve/serve.sock
interface StatusResponse {
  type: 'status';
  version: string;
  pid: number;
  uptime: number;          // seconds
  relay: {
    url: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  };
  clients: number;         // Connected client count
  hosting?: {
    subdomain: string;     // e.g., "brad.gitspace.sh"
    tunnelActive: boolean;
  };
}
```

### Commands

```bash
# Start daemon (foreground)
gssh machine serve start --relay wss://relay.example.com

# Start daemon (background)
gssh machine serve start --relay wss://relay.example.com

# Stop daemon
gssh machine serve stop

# Show status
gssh status
```

---

## Deployment Options

### Managed Service (gitspace.sh)

```bash
# Authenticate with GitHub
gssh user auth login

# Reserve a subdomain
gssh user host reserve myname

# Start serving (connects to gitspace.sh relay + Cloudflare tunnel)
gssh machine serve start
```

### Self-Hosted Relay

```bash
# Start relay server
gssh relay start --port 8080

# Create machine enrollment invite on relay
gssh invite relay-machine create --relay ws://localhost:8080/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --label "My Machine"

# Enroll machine using relay-machine invite token
gssh machine enroll --invite "ws://localhost:8080/ws#<TOKEN>" --label "My Machine"

# Connect machine
gssh machine serve start --relay ws://localhost:8080/ws
```

---

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Relay compromise | E2E encryption - relay sees only encrypted bytes |
| Network interception | TLS + E2E encryption with forward secrecy |
| Stolen client key | Revoke access: `gssh machine access remove <user-id|label>` |
| Machine key compromise | Regenerate identity: `gssh user identity init --force` |
| Replay attacks | Per-frame random nonces, session keys |
| Man-in-the-middle | X3DH with identity verification |

### Key Storage

| Location | What's Stored | How |
|----------|---------------|-----|
| Machine | Identity keypair | Encrypted file + system keychain |
| Web client | Session keys only | Memory (cleared on close) |
| Relay | Public keys only | Database |

### Best Practices

1. **Protect your identity directory** - Located at `~/gitspace/.identity/`
2. **Use labeled access entries** - Know who has access
3. **Audit access regularly** - Run `gssh machine access list`
4. **Revoke unused access** - Remove former collaborators
5. **Use short-lived invites for demos** - Grant and revoke quickly

---

**Last Updated:** 2025-01
**Status:** Implemented
