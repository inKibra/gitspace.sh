# GitSpace Remote Access - Getting Started

> **Note:** The CLI command is `gssh` and data is stored in `~/gitspace/`.

This guide covers setting up secure remote terminal access to your machine. The system is designed around a simple philosophy: **your machine owns its identity, grants access through invites, and maintains full control over who can connect.**

---

## Philosophy

### You Own Your Identity

Every machine and client has a cryptographic identity - a pair of keys for signing (Ed25519) and key exchange (X25519). These identities are generated locally and never leave your devices. When you share access, you're sharing *permission* to connect, not the keys themselves.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  IDENTITY = WHO YOU ARE                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Machine Identity:                     Client Identity:                     │
│  ├── Signing Key (Ed25519)             ├── Signing Key (Ed25519)           │
│  ├── Key Exchange Key (X25519)         ├── Key Exchange Key (X25519)       │
│  └── Unique ID (derived from keys)     └── Unique ID (derived from keys)   │
│                                                                              │
│  Generated once, stored locally, used to prove who you are                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Relay is Just a Router

The relay server connects machines and clients but **cannot read your terminal content**. It's a blind router that:

- Authenticates machines via challenge-response and verifies signed client messages
- Routes encrypted messages between parties
- Tracks which clients are authorized for which machines
- Never sees your keystrokes, commands, or output

```
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│    Client    │◀────────▶│    Relay     │◀────────▶│   Machine    │
│              │   E2E    │  (routing)   │   E2E    │              │
│  Decrypts    │ encrypted│  Can't read  │ encrypted│  Encrypts    │
│  locally     │          │  anything    │          │  locally     │
└──────────────┘          └──────────────┘          └──────────────┘
```

### Trust Through Identity + Enrollment

Runtime access is owner-only and based on the owner user root identity:

1. The relay is bound to one owner user root identity
2. Clients and machines present device certificates tied to that owner identity
3. Relay-machine invites are used only to enroll machines onto a relay
4. Client connection authorization succeeds only when the owner identity matches

### End-to-End Encryption

All terminal data is encrypted using keys derived from an X3DH (Extended Triple Diffie-Hellman) handshake:

1. Client and machine exchange public keys
2. Both derive identical session keys
3. All subsequent data is encrypted with these keys
4. Even if the relay is compromised, your data is safe

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SYSTEM ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  YOUR MACHINE                    RELAY SERVER              REMOTE CLIENT    │
│  ┌─────────────────────┐        ┌─────────────────┐       ┌─────────────┐  │
│  │ gssh machine serve start --foreground          │        │ gssh relay start │      │ gssh client connect │  │
│  │                     │        │                 │       │             │  │
│  │ ┌─────────────────┐ │        │ ┌─────────────┐ │       │             │  │
│  │ │ Identity        │ │        │ │ Machine     │ │       │ ┌─────────┐ │  │
│  │ │ (Ed25519+X25519)│ │        │ │ Registry    │ │       │ │Identity │ │  │
│  │ └─────────────────┘ │        │ └─────────────┘ │       │ └─────────┘ │  │
│  │                     │        │                 │       │             │  │
│  │ ┌─────────────────┐ │  SIG   │ ┌─────────────┐ │  SIG  │ ┌─────────┐ │  │
│  │ │ Access List     │◀┼───────▶│ │ Invite      │◀┼──────▶│ │ Invite  │ │  │
│  │ │ (who can access)│ │        │ │ Registry    │ │       │ │ Token   │ │  │
│  │ └─────────────────┘ │        │ └─────────────┘ │       │ └─────────┘ │  │
│  │                     │        │                 │       │             │  │
│  │ ┌─────────────────┐ │  E2E   │ ┌─────────────┐ │  E2E  │ ┌─────────┐ │  │
│  │ │ PTY Sessions    │◀┼───────▶│ │ Data        │◀┼──────▶│ │Terminal │ │  │
│  │ │ (real shells)   │ │        │ │ Routing     │ │       │ │ I/O     │ │  │
│  │ └─────────────────┘ │        │ └─────────────┘ │       │ └─────────┘ │  │
│  │                     │        │                 │       │             │  │
│  └─────────────────────┘        └─────────────────┘       └─────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Owner model

For hosted setup, the owner is the machine/operator that configures GitSpace and runs `gssh machine serve start`.
That host is your control node for identity, access, and relay-connected machines.

### Step 1: Install GitSpace CLI

```bash
npm install -g gitspace
gssh --version
```

### Step 2: Authenticate GitHub CLI (recommended)

```bash
gh auth login
```

### Step 3: Set up machine identity

```bash
gssh user identity init
gssh user identity show
```

`gssh machine serve start --foreground` requires an existing identity.

### Step 4: Authenticate with gitspace.sh

```bash
gssh user auth login
```

### Step 5: Reserve your subdomain

```bash
gssh user host reserve <yourname>
gssh user host status
```

### Step 6: Start serving

```bash
gssh machine serve start
gssh machine serve status
gssh status
gssh cloud status
```

Then open `https://<yourname>.gitspace.sh`.

### Step 7: Prepare another owner device

On the remote device:

```bash
# Recover the same owner identity from your mnemonic
gssh user identity recover

# Connect as owner
gssh client connect <machine-id>
```

### Step 8: Connect from another device

The connection flow:
1. Client connects to relay and signs `connect_to_machine`
2. Relay verifies owner identity from the device certificate
3. Relay routes client to your machine
4. X3DH handshake establishes encryption
5. PTY session starts
6. You're in!

### Self-hosted relay alternative

If you are not using gitspace.sh hosting, run your own relay and point serve at it:

```bash
# Relay host
gssh relay start --port 4480

# Create relay-machine invite token
gssh invite relay-machine create --relay ws://<relay-host>:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --label "My Machine"

# Machine host
gssh user identity init
gssh machine enroll --invite "ws://<relay-host>:4480/ws#<TOKEN>" --label "My Machine"
gssh machine serve start --relay ws://<relay-host>:4480/ws
```

---

## Access Management

Runtime access is owner-only. To bring a machine online, use machine enrollment invites:

```bash
# Create machine enrollment invite
gssh invite relay-machine create --relay ws://<relay-host>:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB>

# Inspect enrolled machines
gssh relay machines list

# Revoke a machine from relay registry
gssh relay machines revoke <machine-id>
```

---

## Security Model

### What's Protected

| Data | Protection |
|------|------------|
| Terminal content | E2E encrypted (X3DH + secretbox) |
| Keystrokes | E2E encrypted |
| Commands | E2E encrypted |
| Output | E2E encrypted |
| Machine ID | Visible to relay (for routing) |
| Connection times | Visible to relay (metadata) |
| Data volume | Visible to relay (metadata) |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TRUST BOUNDARIES                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  YOU TRUST:                           YOU DON'T NEED TO TRUST:              │
│  ├── Your own machine                 ├── The relay operator                │
│  ├── Clients you've authorized        ├── Network infrastructure            │
│  └── Devices holding your identity    └── Anyone without an invite          │
│                                                                              │
│  If the relay is compromised:                                               │
│  ✓ Your terminal content is still safe (E2E encrypted)                     │
│  ✓ Your identity keys are still safe (never sent to relay)                 │
│  ✗ Metadata is exposed (who connected when)                                │
│  ✗ Relay could deny service                                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Cryptographic Primitives

| Purpose | Algorithm | Why |
|---------|-----------|-----|
| Identity signing | Ed25519 | Fast, secure signatures |
| Key exchange | X25519 | ECDH for shared secrets |
| Symmetric encryption | AES-256-GCM | AEAD with authentication |
| Key derivation | HKDF-SHA256 | Derive multiple keys from shared secret |
| Relay challenge signing | Ed25519 | Machine registration proof |
| Client message signing | Ed25519 | Signed routing messages |

---

## Connection Flow Details

### Initial Connection (Owner-authorized)

```
Client                     Relay                      Machine
   │                         │                           │
   │──connect_to_machine─────▶│                           │
   │                         │──client_connected────────▶│
   │◀──connection_established│                           │
   │                         │                           │
   │──handshake: client_hello────────────────────────────▶│
   │◀──handshake: server_hello────────────────────────────│
   │──handshake: client_auth─────────────────────────────▶│
   │◀──handshake: server_auth─────────────────────────────│
   │                         │                           │
   │           [Session keys derived on both sides]      │
   │                         │                           │
   │◀═══════════════════════E2E═══════════════════════════│
   │          [Encrypted terminal I/O begins]            │
```

### Direct Connection (Same owner identity)

Any device recovered with the same owner mnemonic can connect directly:

```
Client                     Relay                      Machine
   │                         │                           │
   │──connect_to_machine────▶│                           │
   │                         │──[checks authorization]   │
   │                         │──client_connected────────▶│
   │◀──connection_established│                           │
   │                         │                           │
   │          [X3DH handshake, same as above]            │
```

---

## Advanced Configuration

### Custom Relay

Run your own relay for complete control:

```bash
# Production relay with TLS (behind nginx/caddy)
gssh relay start --port 8080
```

### Multiple Machines

Each machine needs its own identity:

```bash
# On machine 1
gssh user identity init
gssh machine serve start --relay wss://relay.example.com/ws

# On machine 2
gssh user identity init
gssh machine serve start --relay wss://relay.example.com/ws
```

Create relay-machine enrollment invites for each machine:

```bash
gssh invite relay-machine create --relay wss://relay.example.com/ws --machine-signing-key <DESKTOP_SIGNING_KEY> --machine-key-exchange-key <DESKTOP_X25519_KEY> --label "Desktop"
gssh invite relay-machine create --relay wss://relay.example.com/ws --machine-signing-key <SERVER_SIGNING_KEY> --machine-key-exchange-key <SERVER_X25519_KEY> --label "Server"
```

Then enroll each machine with the token returned by the relay:

```bash
gssh machine enroll --invite "wss://relay.example.com/ws#<token>" --label "Desktop"
gssh machine enroll --invite "wss://relay.example.com/ws#<token>" --label "Server"
```

Clients can list machines they can access:

```bash
gssh client machines list --relay wss://relay.example.com/ws
# Output:
# Machine ID        Label      Status
# abc123...         Desktop    online
# def456...         Server     offline
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SPACES_RELAY_URL` | Default relay URL |
| `SPACES_IDENTITY_PATH` | Custom identity file location |

---

## Troubleshooting

### "Client not authorized"

The connecting client identity does not match the owner user root identity for this relay/machine. Either:
- Recover the same owner identity on the client device: `gssh user identity recover`
- Verify the client is using the expected local identity: `gssh user identity show`

### "Machine offline"

The machine isn't connected to the relay. Ensure:
- `gssh machine serve start --foreground` is running on the machine
- The machine can reach the relay URL

### "Invite not found"

The invite may have:
- Expired (check `--expires` when creating)
- Been revoked by the machine owner
- Not been registered with the relay (ensure `gssh machine serve start --foreground` was running when invite was created)

### "Handshake timeout"

The X3DH handshake didn't complete. Check:
- Both machine and client have valid identities
- Network connectivity between all parties
- No firewall blocking WebSocket connections

---

## Design Principles

### 1. Zero Trust Relay

The relay never needs to be trusted with sensitive data. It's a utility, like a phone switch - it connects calls but doesn't listen in.

### 2. Self-Sovereign Identity

Your cryptographic identity is generated and stored locally. No central authority issues or controls identities. You prove who you are through cryptographic signatures.

### 3. Explicit Authorization

Access is never implicit. Every client must present a device certificate derived from the owner user root identity.

### 4. Minimal Metadata

The relay learns only what it needs for routing:
- Which machine IDs exist
- Which machine enrollment invites are registered
- Which owner identity a relay is bound to

It never learns the content of your sessions.

### 5. Forward Secrecy Ready

Each connection uses a fresh X3DH handshake, deriving new session keys. Compromising one session doesn't compromise past or future sessions.

---

## What's Implemented

- **Web client**: Access your terminal from any browser at `gitspace.sh`
- **Persistent sessions**: Sessions continue running when you disconnect
- **Multiple clients**: Multiple clients can connect to the same machine
- **TUI remote access**: Connect to remote machines from the TUI with `--relay`
- **Cloudflare hosting**: Expose your machine via `yourname.gitspace.sh`

## What's Planned

- **Port tunneling**: Expose `localhost:3000` to the internet securely
- **Session sharing**: Let multiple clients view/interact with the same PTY
- **Lima VMs**: Isolated development environments per workspace

---

**Last Updated:** 2025-01
