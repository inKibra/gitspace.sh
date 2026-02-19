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

### Trust Through Invites

Access is granted through **signed invite tokens**. When you create an invite:

1. Your machine signs the invite with its private key
2. The invite contains your machine's public keys and the relay URL
3. Anyone with the invite can request access
4. Your machine validates the invite signature and grants permissions

This is a "trust on first use" model - the invite bootstraps the initial connection, then your machine maintains an access list of authorized clients.

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
│  │ gssh serve          │        │ gssh relay      │       │ gssh        │  │
│  │                     │        │                 │       │ connect     │  │
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

For hosted setup, the owner is the machine/operator that configures GitSpace and runs `gssh serve start`.
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
gssh identity init --label "My Control Host"
gssh identity show
```

`gssh serve` requires an existing identity.

### Step 4: Authenticate with gitspace.sh

```bash
gssh auth login
```

### Step 5: Reserve your subdomain

```bash
gssh host reserve <yourname>
gssh host status
```

### Step 6: Start serving

```bash
gssh serve start
gssh serve status
gssh status
gssh cloud status
```

Then open `https://<yourname>.gitspace.sh`.

### Step 7: Create an invite

To let someone connect, create a signed invite:

```bash
# Create an invite (expires in 24 hours by default)
gssh share create

# Create an invite with custom expiration
gssh share create --expires 7d

# Output: Invite token that can be shared
```

The invite is a self-contained, signed token that includes:
- Your machine's public identity
- The relay URL
- Access type (full or session-invite)
- Expiration time

**Note:** When you create an invite, it's automatically registered with the relay server. This allows clients to connect via the invite ID without needing to present the full token to the relay.

### Step 8: Connect from another device

On the remote device:

```bash
# Create a client identity (first time only)
gssh identity init --label "Work Laptop"

# Connect using the invite
gssh connect <invite-url-or-token>
```

The connection flow:
1. Client connects to relay and signs connect_with_invite
2. Client presents invite ID to relay
3. Relay routes client to your machine
4. X3DH handshake establishes encryption
5. PTY session starts
6. You're in!

### Self-hosted relay alternative

If you are not using gitspace.sh hosting, run your own relay and point serve at it:

```bash
# Relay host
gssh relay start --port 4480

# Machine host
gssh identity init --label "My Machine"
gssh serve start --relay ws://<relay-host>:4480/ws
```

---

## Access Management

### Viewing Authorized Clients

After a client connects via invite, they're added to your access list:

```bash
# List all authorized clients
gssh access list

# Output:
# ID                      Label           Access Type    Added
# gssh_pk_abc123...       Work Laptop     full           2024-01-15
# gssh_pk_def456...       Phone           full           2024-01-10
```

### Adding Access Directly

You can add a client's public key directly without an invite:

```bash
# Add a client by their public key
gssh access add gssh_pk_abc123... --label "Brad's Phone"
```

### Revoking Access

Remove a client from your access list:

```bash
# Remove by public key
gssh access remove gssh_pk_abc123...
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

### Initial Connection (via Invite)

```
Client                     Relay                      Machine
   │                         │                           │
   │──connect_with_invite───▶│                           │
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

### Direct Connection (Pre-authorized)

Once a client is in your access list, they can connect directly:

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
gssh identity init --label "Desktop"
gssh serve --relay wss://relay.example.com/ws

# On machine 2
gssh identity init --label "Server"
gssh serve --relay wss://relay.example.com/ws
```

Authorize each machine on the relay host:

```bash
gssh relay authorize gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY --label "Desktop"
gssh relay authorize gssh-pub:SIGNING_KEY:KEYEXCHANGE_KEY --label "Server"
```

Clients can list machines they're authorized for:

```bash
gssh connect --list
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

The client's identity is not in the machine's access list. Either:
- Use an invite to connect first
- Have the machine owner add your public key: `gssh access add <public-key> --label "Name"`

### "Machine offline"

The machine isn't connected to the relay. Ensure:
- `gssh serve` is running on the machine
- The machine can reach the relay URL

### "Invite not found"

The invite may have:
- Expired (check `--expires` when creating)
- Been revoked by the machine owner
- Not been registered with the relay (ensure `gssh serve` was running when invite was created)

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

Access is never implicit. Every client must either:
- Present a valid invite signed by the machine
- Be explicitly added to the access list

### 4. Minimal Metadata

The relay learns only what it needs for routing:
- Which machine IDs exist
- Which invites are registered
- Which clients are authorized

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
