# GitSpace Remote Access - Getting Started

> **Note:** The CLI command is `gssh`. By default GitSpace stores projects/workspaces in `~/gitspace/`, while identity/runtime state may be redirected in sandboxed environments.

This guide covers setting up secure remote terminal access to your machine. The system is designed around a simple philosophy: **one owner identity controls the relay, the machines, and the clients, and nothing connects without proving it holds that identity.**

There are two ways a machine comes to hold that proof. On a machine you own, `gssh user identity init` or `gssh user identity recover` binds it directly. A machine that is not already bound is bootstrapped with `gssh machine enroll --invite`: the invite is a root-signed token that authorizes the machine to register, and enrollment is what produces its owner-bound certificate. The invite is a bootstrap into the same trust relationship, not a second, parallel way in.

You do not drive GitSpace from the terminal. The CLI is for setup and for running the daemons. The thing you actually work in is the web app, which the relay serves in your browser. On the machine you are sitting at, `gssh web` starts everything and opens it.

---

## Philosophy

### You Own Your Identity

Every machine and client has a cryptographic identity - a pair of keys for signing (Ed25519) and key exchange (X25519). These identities are generated locally and never leave your devices. When you share access, you're sharing *permission* to connect, not the keys themselves.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  IDENTITY = WHO YOU ARE                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Machine Identity:                     Client Identity:                     │
│  ├── Signing Key (Ed25519)             ├── Signing Key (Ed25519)            │
│  ├── Key Exchange Key (X25519)         ├── Key Exchange Key (X25519)        │
│  └── Unique ID (derived from keys)     └── Unique ID (derived from keys)    │
│                                                                             │
│  Generated once, stored locally, used to prove who you are                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Relay is Just a Router

The relay server connects machines and clients but **cannot read your terminal content**. It's a blind router that:

- Authenticates machines via challenge-response and verifies signed client messages
- Routes encrypted messages between parties
- Tracks which owner user root identity each registered machine belongs to, and only routes a client whose device certificate resolves to that same owner
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
│                           SYSTEM ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  YOUR MACHINE                    RELAY SERVER              REMOTE CLIENT    │
│  ┌─────────────────────┐        ┌─────────────────┐       ┌─────────────┐   │
│  │ gssh web            │        │ gssh relay start│       │ browser     │   │
│  │ (relay + serve)     │        │                 │       │ or gssh     │   │
│  │                     │        │                 │       │ client      │   │
│  │                     │        │                 │       │             │   │
│  │ ┌─────────────────┐ │        │ ┌─────────────┐ │       │             │   │
│  │ │ Identity        │ │        │ │ Machine     │ │       │ ┌─────────┐ │   │
│  │ │ (Ed25519+X25519)│ │        │ │ Registry    │ │       │ │Identity │ │   │
│  │ └─────────────────┘ │        │ └─────────────┘ │       │ └─────────┘ │   │
│  │                     │        │                 │       │             │   │
│  │ ┌─────────────────┐ │  SIG   │ ┌─────────────┐ │  SIG  │ ┌─────────┐ │   │
│  │ │ Access List     │◀┼───────▶│ │ Invite      │◀┼──────▶│ │ Invite  │ │   │
│  │ │ (who can access)│ │        │ │ Registry    │ │       │ │ Token   │ │   │
│  │ └─────────────────┘ │        │ └─────────────┘ │       │ └─────────┘ │   │
│  │                     │        │                 │       │             │   │
│  │ ┌─────────────────┐ │  E2E   │ ┌─────────────┐ │  E2E  │ ┌─────────┐ │   │
│  │ │ PTY Sessions    │◀┼───────▶│ │ Data        │◀┼──────▶│ │Terminal │ │   │
│  │ │ (real shells)   │ │        │ │ Routing     │ │       │ │ I/O     │ │   │
│  │ └─────────────────┘ │        │ └─────────────┘ │       │ └─────────┘ │   │
│  │                     │        │                 │       │             │   │
│  └─────────────────────┘        └─────────────────┘       └─────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Owner model

Everything is bound to one owner user root identity. The relay is bound to it, machines are bound to it, and clients prove they hold it through a device certificate. Any device that recovers the same 24-word mnemonic is the same owner.

### Step 1: Install GitSpace CLI

```bash
npm install -g gitspace
gssh --version
```

The only required system dependency is `git`. The GitHub CLI (`gh`) is used for GitHub repository discovery, so authenticate it if you want to add projects from GitHub:

```bash
gh auth login
```

### Step 2: Create your identity

```bash
gssh user identity init
gssh user identity show
```

`gssh user identity init` generates a 24-word mnemonic. Write it down. It is how you become the same owner on another device (`gssh user identity recover`).

### Step 3: Start the web app on this machine

```bash
gssh web
```

`gssh web` is the normal way to use GitSpace on the machine you are sitting at. It:

1. Starts a local relay on `127.0.0.1` (default port 4480), or reuses one already running for the same owner identity
2. Starts machine serve and waits for it to connect to that relay
3. Registers a one-time browser enrollment with the relay
4. Opens `http://127.0.0.1:4480/?enroll=<token>` in your browser

It runs in the foreground. Ctrl+C stops whatever it started.

`gssh web` requires a user root identity and a local device identity. If either is missing it stops and tells you to run `gssh user identity init` (or `gssh user identity recover`) and `gssh user auth login`. It does not check gitspace.sh login otherwise. GitHub login only matters if you later want a gitspace.sh subdomain.

Options:

| Flag | Effect |
|------|--------|
| `--port <port>` | Local relay/web port (default `4480`) |
| `--relay` | Start a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain |
| `-y, --yes` | Auto-confirm prompts |
| `--takeover` | Clear persisted owner/control state and stale relay trust pins before starting |
| `--password-stdin` | Read the device identity password from stdin and pass it to machine serve |

### Step 4 (optional): Reach it from other devices over gitspace.sh

If you want the same web app from a phone or another laptop, put it behind your gitspace.sh subdomain:

```bash
gssh user auth login
gssh user host reserve <yourname>
gssh user host status
```

Then start the hosted stack:

```bash
gssh web --relay
```

`gssh web --relay` requires `cloudflared` to be installed and at least one reserved subdomain. It refuses to run if a relay is already running, because it needs to start its own relay with the enrollment payload configured. The browser URL it opens is `https://<yourname>.gitspace.sh/?enroll=<token>`.

### Step 5 (optional): Connect from another owner device

On the other device, recover the same owner identity, then connect:

```bash
gssh user identity recover
gssh client connect <machine-id>
```

`gssh client connect` takes `--relay <url>`, `--relay-pubkey <pubkey>`, and `--machine <id>`. This is a terminal client, not the web app. For normal work, open the web app instead.

The connection flow:
1. Client connects to relay and signs `connect_to_machine`
2. Relay verifies owner identity from the device certificate
3. Relay routes client to your machine
4. X3DH handshake establishes encryption
5. PTY session starts

### Running the daemons directly

`gssh web` supervises the relay and serve for you. Run them separately when you want them to keep running after you close the terminal, for example on a machine you leave online:

```bash
gssh relay start
gssh machine serve start
gssh status
gssh relay status
gssh machine serve status
```

Add `--foreground` to either `relay start` or `machine serve start` to keep it attached to the terminal instead of daemonizing.

### Self-hosted relay alternative

If you are not using gitspace.sh hosting, run your own relay on another host and point serve at it:

```bash
# Relay host
gssh relay start --port 4480

# Machine host (same owner identity as the relay host)
gssh user identity recover
gssh machine serve start --relay ws://<relay-host>:4480/ws
```

Both hosts hold the same owner root identity, so the machine registers with a device certificate signed by that owner and the relay authorizes it without an invite. Relay-machine invites are for the case where the machine is not already bound to the relay's owner.

---

## Access Management

Runtime access is owner-only. A machine that holds the owner root identity registers with its device certificate and needs nothing else. A relay-machine invite is how you enroll a machine that is not already bound to the relay owner; creating one takes that machine's Ed25519 signing and X25519 key exchange public keys.

```bash
# Create machine enrollment invite
gssh invite relay-machine create --relay ws://<relay-host>:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB>

# List invites you own, and revoke one
gssh invite list --relay ws://<relay-host>:4480/ws
gssh invite revoke <invite-id> --relay ws://<relay-host>:4480/ws

# Inspect enrolled machines
gssh relay machines list

# Revoke a machine from relay registry
gssh relay machines revoke <machine-id>
```

Invites default to `--expires 24h` and `--max-uses 1`.

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
│  TRUST BOUNDARIES                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  YOU TRUST:                           YOU DON'T NEED TO TRUST:              │
│  ├── Your own machine                 ├── The relay operator                │
│  ├── Clients you've authorized        ├── Network infrastructure            │
│  └── Devices holding your identity    └── Anyone without an invite          │
│                                                                             │
│  If the relay is compromised:                                               │
│  ✓ Your terminal content is still safe (E2E encrypted)                      │
│  ✓ Your identity keys are still safe (never sent to relay)                  │
│  ✗ Metadata is exposed (who connected when)                                 │
│  ✗ Relay could deny service                                                 │
│                                                                             │
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
gssh relay start --port 8080 --bind 0.0.0.0 --label "Team relay"
```

`--hostname <host>` restricts the relay to serving requests for a single domain.

Relay startup modes control whether GitSpace should also attach managed hosting:

- `gssh relay start --mode local` keeps the relay local only.
- `gssh relay start --mode hosted` requires gitspace.sh hosting and still keeps loopback access.
- `gssh relay start --mode auto` keeps local access and adds hosted tunneling when available.

### Multiple Machines

Each machine has its own device keypair, but all of them belong to the same owner root identity. Create the root identity once, then recover it on every other machine:

```bash
# On machine 1 (the first one)
gssh user identity init
gssh machine serve start --relay wss://relay.example.com/ws

# On machine 2 (same owner, recovered from the mnemonic)
gssh user identity recover
gssh machine serve start --relay wss://relay.example.com/ws
```

Because both machines carry a device certificate from the same owner, the relay authorizes each of them at registration. Enrollment invites are not part of this path. If you do have an invite token for a machine, enroll it with:

```bash
gssh machine enroll --invite "wss://relay.example.com/ws#<token>" --label "Desktop"
```

Clients can list machines they can access:

```bash
gssh client machines list --relay wss://relay.example.com/ws
# Machines:
#
# MACHINE ID          LABEL                   STATUS
# ────────────────────────────────────────────────────
# abc123...           Desktop                 online
# def456...           Server                  offline
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GITSPACE_WORKSPACE_ROOT` | Override the default workspace/project root (`~/gitspace`) |
| `GITSPACE_HOME` | Legacy alias for workspace root override |
| `GITSPACE_IDENTITY_DIR` | Override the identity storage directory |
| `GITSPACE_CONFIG_ROOT` | Override the config storage directory |

---

## Troubleshooting

### "Client not authorized"

The connecting client identity does not match the owner user root identity for this relay/machine. Either:
- Recover the same owner identity on the client device: `gssh user identity recover`
- Verify the client is using the expected local identity: `gssh user identity show`

### "Machine offline"

The machine isn't connected to the relay. Ensure:
- `gssh web` or `gssh machine serve start` is running on the machine
- `gssh machine serve status` reports the relay you expect
- The machine can reach the relay URL

### "Invite not found"

The invite may have:
- Expired (`--expires` defaults to `24h`)
- Been used up (`--max-uses` defaults to `1`)
- Been revoked with `gssh invite revoke <invite-id>`

Check with `gssh invite list --relay <url>`.

### `gssh web` refuses to start

- "Web UI assets not found": build them with `bun run build:web`.
- "A relay is already running": `gssh web --relay` starts its own relay, so stop the running one with `gssh relay stop` first.
- "A hosted relay is running": stop it with `gssh relay stop`, or use `gssh web --relay` instead of plain `gssh web`.
- "The running relay has no owner identity bound": stop it with `gssh relay stop` so `gssh web` can restart it with your identity.
- "The running relay is bound to a different user root identity": stop the relay, or recover the original identity.
- "Relay is already running on port N": rerun as `gssh web --port N` to reuse it, or stop the relay.
- "The machine daemon is already serving on ...": `gssh web` reuses a daemon only when it is already serving the relay being selected. When the running daemon is bound to a different relay URL it cannot be reused, so stop it with `gssh machine serve stop` and rerun. If it is serving the same relay, no action is needed.
- "cloudflared is required": only for `gssh web --relay`. Install cloudflared.
- "No gitspace.sh subdomain configured": run `gssh user auth login` then `gssh user host reserve <name>`.

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

- **Web app**: The interactive surface. `gssh web` starts it locally and opens the browser
- **Persistent sessions**: Sessions continue running when you disconnect
- **Multiple clients**: Multiple clients can connect to the same machine
- **Terminal client**: `gssh client connect` reaches a remote machine over a relay with `--relay`
- **Cloudflare hosting**: Expose your machine via `yourname.gitspace.sh` with `gssh web --relay`

---

**Last Updated:** 2026-08
