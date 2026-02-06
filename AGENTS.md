# Claude Code Development Guide

This document provides comprehensive information for AI assistants working on the GitSpace CLI project.

## Project Overview

**GitSpace** is a powerful CLI tool for managing GitHub repository workspaces using git worktrees, with secure remote terminal access via an E2E encrypted relay system. It features both a TUI (Terminal User Interface) and web interface for interactive management.

**Key Capabilities:**
- Git worktrees for parallel branch development
- Interactive TUI for workspace management
- **Remote terminal access** via E2E encrypted relay
- **Identity-based access control** with Ed25519/X25519 keys
- **X3DH handshake** for forward-secret session encryption
- Web terminal interface (React + xterm.js)
- Linear issue integration for workspace creation
- Convention-based custom scripts in `.gitspace/` (pre, setup, select, remove phases)

## Architecture

### Core Concepts

1. **Projects**: Top-level containers for a GitHub repository
   - Located at `~/gitspace/<project-name>/`
   - Contains: base repo clone, workspaces, config

2. **Workspaces**: Individual git worktrees for features/branches
   - Located at `~/gitspace/<project-name>/workspaces/<workspace-name>/`
   - Each workspace has its own branch
   - Scripts are sourced from `.gitspace/<phase>/` in the workspace (version-controlled)

3. **Sessions**: PTY terminal sessions managed by tmux-lite
   - Can be attached from multiple clients
   - State maintained by xterm-headless on server

4. **Identity**: Cryptographic keypair per machine/client
   - Ed25519 for signing (proving identity)
   - X25519 for key exchange (establishing encryption)
   - Stored in `~/gitspace/.identity/` directory:
     - `keypair.json` - Encrypted identity keypair
   - Access list: `~/gitspace/.access.json` - Authorized client public keys
   - Machine info: `~/gitspace/.machine.json` - Machine registration info
   - Relay config: `~/gitspace/.relay.json` - Relay configuration cache

5. **Relay**: WebSocket server for routing encrypted traffic
   - Connects machines to clients through NAT/firewalls
   - Cannot decrypt terminal content (E2E encryption)

### Directory Structure

```
src/
├── index.ts                    # Entry point (TUI or CLI dispatch)
├── commands/                   # CLI command implementations (17 files)
│   ├── access.ts               # Access control list (add/list/remove)
│   ├── add.ts                  # Add projects/workspaces
│   ├── auth.ts                 # GitHub OAuth for gitspace.sh
│   ├── connect.ts              # Connect to remote machine
│   ├── directory.ts            # Get project directory path
│   ├── host.ts                 # Subdomain hosting (reserve/release/list)
│   ├── identity.ts             # Identity management (init/show)
│   ├── linear.ts               # Linear integration (setup/show/clear)
│   ├── list.ts                 # List projects/workspaces
│   ├── machine.ts              # Remote machine management (invite/list)
│   ├── relay.ts                # Relay server (start/token)
│   ├── remove.ts               # Remove projects/workspaces
│   ├── serve.ts                # Machine daemon for remote access
│   ├── share.ts                # Create invite tokens
│   ├── status.ts               # Unified daemon status display
│   ├── switch.ts               # Switch projects/workspaces
│   └── tmux.ts                 # tmux-lite CLI commands
├── core/                       # Core business logic (8 files)
│   ├── access.ts               # Access list management
│   ├── bundle.ts               # Project template bundles
│   ├── config.ts               # Configuration management
│   ├── git.ts                  # Git operations (worktrees, branches)
│   ├── github.ts               # GitHub API (via gh CLI)
│   ├── identity.ts             # Machine identity management
│   ├── linear.ts               # Linear API integration
│   └── shell.ts                # Subshell spawning
├── lib/
│   ├── tmux-lite/              # Terminal multiplexer library
│   │   ├── cli.ts              # CLI interface for tmux-lite
│   │   ├── server.ts           # Session manager with xterm-headless
│   │   ├── protocol.ts         # Frame format (PTY/CONTROL)
│   │   ├── handshake-handler.ts # X3DH handshake management
│   │   ├── relay-client.ts     # WebSocket client for relay
│   │   └── crypto/             # Cryptography implementations
│   │       ├── identity.ts     # Ed25519/X25519 key generation
│   │       ├── keyexchange.ts  # X25519 ECDH
│   │       ├── secretbox.ts    # AES-256-GCM encryption
│   │       ├── frames.ts       # Encrypted frame format
│   │       ├── handshake.ts    # X3DH protocol steps
│   │       ├── invites.ts      # Signed invite tokens
│   │       └── access-control.ts # ACL checking
│   └── remote-session/         # Remote session handling
│       ├── session-handler.ts  # Handle remote client commands
│       └── workspace-scanner.ts # Scan workspace info
├── relay/                      # Relay server (8 files)
│   ├── index.ts                # Entry point
│   ├── server.ts               # WebSocket routing server
│   ├── protocol.ts             # Message types and validation
│   ├── registries.ts           # Machine/invite/auth/global access registries
│   ├── jwt.ts                  # JWT token creation/verification (HMAC + Ed25519)
│   ├── pipes.ts                # Pipe abstraction for data routing
│   └── types.ts                # WebSocketData, RelayConfig types
├── serve/                      # Machine daemon (4 files)
│   ├── client-session-manager.ts # Client connection handling
│   ├── daemon.ts               # Daemon lifecycle (PID, status socket)
│   ├── pty-session.ts          # PTY session management
│   └── types.ts                # ServeOptions, permissions
├── shared/                     # Cross-platform components
│   ├── components/             # Shared UI components (16 files)
│   │   ├── MachineList.tsx     # Logic + hooks
│   │   ├── MachineList.web.tsx # Web rendering
│   │   ├── MachineList.tui.tsx # TUI rendering
│   │   ├── SpacesBrowser.tsx   # Workspace browser logic
│   │   ├── SpacesBrowser.web.tsx
│   │   ├── SpacesBrowser.tui.tsx
│   │   ├── Inbox.tsx           # Notification system
│   │   ├── Inbox.web.tsx
│   │   ├── Inbox.tui.tsx
│   │   ├── Flow.tsx            # Modal dialog system
│   │   ├── Flow.web.tsx
│   │   ├── Flow.tui.tsx
│   │   ├── ProjectList.tsx
│   │   ├── ProjectList.web.tsx
│   │   └── ProjectList.tui.tsx
│   ├── providers/              # Machine access abstraction
│   │   ├── MachineProvider.ts  # Interface definition
│   │   ├── LocalMachineProvider.ts  # Direct tmux-lite access
│   │   └── RemoteMachineProvider.ts # Via relay
│   ├── hooks/
│   │   └── useNavigation.ts    # Navigation state management
│   └── types.ts                # Shared type definitions
├── tui/                        # Terminal UI (OpenTUI)
│   ├── index.ts                # TUI entry point
│   ├── app.tsx                 # Main TUI application
│   ├── state.ts                # State management
│   ├── adapters.ts             # Local/remote machine adapters
│   ├── components/
│   │   └── Terminal.tsx        # Embedded terminal
│   └── hooks/
│       ├── useAppState.ts
│       ├── useRemoteMachines.ts
│       └── useInboxTUI.ts
├── web/                        # Web application (Vite + React)
│   └── src/
│       ├── App.tsx             # Main web app
│       ├── components/
│       │   └── Terminal.tsx
│       ├── hooks/
│       │   ├── useRelayConnection.ts
│       │   └── useTerminal.ts
│       └── lib/
│           ├── crypto/         # Client-side crypto (same as server)
│           └── storage/        # LocalStorage identity
├── types/                      # TypeScript type definitions
│   ├── bundle.ts               # Bundle format
│   ├── config.ts               # Global/project config
│   ├── errors.ts               # Error types
│   ├── identity.ts             # Keypairs, access, invites, X3DH
│   ├── workspace.ts            # Workspace types
│   └── workspace-fuzzy.ts      # Fuzzy search types
└── utils/                      # Utility functions (13 files)
    ├── bun-socket-writer.ts    # Buffered socket writing
    ├── deps.ts                 # Dependency checking
    ├── fuzzy-match.ts          # Fuzzy matching
    ├── logger.ts               # Colored logging
    ├── markdown.ts             # Markdown rendering
    ├── onboarding.ts           # Bundle onboarding
    ├── prompts.ts              # User prompts
    ├── run-commands.ts         # Command execution
    ├── run-scripts.ts          # Script discovery/execution
    ├── sanitize.ts             # String sanitization
    ├── secrets.ts              # Bun.secrets integration
    ├── shell-escape.ts         # POSIX escaping
    └── workspace-state.ts      # gitspace.lock marker
```

## CLI Commands

### Workspace Management
| Command | Description |
|---------|-------------|
| `gssh` | Launch TUI (no args) |
| `gssh add project` | Add a new project from GitHub |
| `gssh add <name>` | Create workspace in current project |
| `gssh switch project [name]` | Switch to a project |
| `gssh switch [name]` | Switch to a workspace |
| `gssh list projects` | List all projects |
| `gssh list workspaces` | List workspaces in current project |
| `gssh remove workspace [name]` | Remove a workspace |
| `gssh remove project [name]` | Remove a project |
| `gssh directory` | Print current project directory |

### Identity & Access
| Command | Description |
|---------|-------------|
| `gssh identity init` | Create machine identity keypair |
| `gssh identity show` | Display identity fingerprint |
| `gssh access add <pubkey>` | Add authorized client |
| `gssh access list` | List authorized clients |
| `gssh access remove <key>` | Remove client access |
| `gssh share create` | Create invite token |

### Remote Access
| Command | Description |
|---------|-------------|
| `gssh serve` | Start machine daemon (foreground) |
| `gssh serve start` | Start machine daemon (background) |
| `gssh serve stop` | Stop machine daemon |
| `gssh connect <token>` | Connect to remote machine |
| `gssh status` | Show status of all daemons |

### Relay Server
| Command | Description |
|---------|-------------|
| `gssh relay start` | Start relay server |
| `gssh relay authorize <pubkey>` | Authorize a machine on relay |
| `gssh relay revoke <id>` | Revoke machine authorization |
| `gssh relay machines` | List authorized machines |
| `gssh relay trusted` | List trusted relays |
| `gssh relay untrust <url>` | Remove relay from trusted list |

### tmux-lite Daemon
| Command | Description |
|---------|-------------|
| `gssh tmux start` | Start tmux-lite server daemon |
| `gssh tmux stop` | Stop tmux-lite daemon |
| `gssh tmux status` | Show tmux-lite daemon status |
| `gssh tmux list` | List active terminal sessions |

### Machine Management
| Command | Description |
|---------|-------------|
| `gssh machine invite` | Create invite for remote machine to join relay |
| `gssh machine list` | List machines on relay (stub) |
| `gssh machine remove <id>` | Remove machine from relay (stub) |

### Authentication (gitspace.sh)
| Command | Description |
|---------|-------------|
| `gssh auth login` | Login via GitHub OAuth device flow |
| `gssh auth logout` | Clear local credentials |
| `gssh auth status` | Show authentication status |

### Hosting (gitspace.sh)
| Command | Description |
|---------|-------------|
| `gssh host reserve <name>` | Reserve subdomain on gitspace.sh |
| `gssh host release [name]` | Release a subdomain |
| `gssh host list` | List your subdomains |
| `gssh host set-primary <name>` | Set primary subdomain |
| `gssh host status` | Show hosting status |

### Linear Integration
| Command | Description |
|---------|-------------|
| `gssh linear setup` | Configure Linear integration (API key + teams) |
| `gssh linear setup --project <name>` | Configure Linear for a specific project |
| `gssh linear show` | Show user-level Linear configuration |
| `gssh linear show --project <name>` | Show project-specific Linear configuration |
| `gssh linear clear` | Clear user-level Linear configuration |
| `gssh linear clear --project <name>` | Clear project-specific Linear configuration |

### Bundle Management
| Command | Description |
|---------|-------------|
| `gssh bundle status` | Show bundle status for current project |
| `gssh bundle refresh` | Re-run bundle onboarding (keeps previous values as defaults) |
| `gssh bundle refresh --force` | Force refresh even if no changes detected |

## Remote Access Architecture

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Your Machine   │       │  Relay Server   │       │  Remote Client  │
│                 │       │                 │       │                 │
│  gssh serve     │◀═════▶│  Routing only   │◀═════▶│  gssh connect   │
│  (PTY sessions) │ WebSocket │ E2E encrypted │ WebSocket │ or browser    │
│                 │       │  (can't decrypt)│       │                 │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

### Connection Flow (gitspace.sh Hosting)

1. User logs in: `gssh auth login` (GitHub OAuth)
2. User reserves subdomain: `gssh host reserve <name>`
3. Machine runs `gssh serve start` (auto-starts local relay + cloudflared tunnel)
4. Client connects via web: `https://<name>.gitspace.sh`
5. X3DH handshake establishes session keys
6. All terminal I/O is E2E encrypted

### Connection Flow (Self-Hosted Relay)

1. Machine runs `gssh serve start --relay ws://relay:4480/ws`
2. Machine registers with relay (Ed25519 challenge-response auth)
3. Machine creates invite: `gssh share create`
4. Client connects with invite: `gssh connect <token>`
5. X3DH handshake establishes session keys
6. All terminal I/O is E2E encrypted

### Cryptographic Primitives

| Purpose | Algorithm |
|---------|-----------|
| Identity signing | Ed25519 |
| Key exchange | X25519 |
| Symmetric encryption | AES-256-GCM |
| Key derivation | HKDF-SHA256 |
| Relay authentication | Ed25519 challenge-response |

## TUI/Web Shared Component Pattern

Components are split into three files:
- `Component.tsx` - Logic/hooks (React-compatible)
- `Component.web.tsx` - Web rendering (React DOM)
- `Component.tui.tsx` - TUI rendering (OpenTUI)

This allows shared business logic with platform-specific rendering.

### MachineProvider Abstraction

```typescript
interface MachineProvider {
  getMachineInfo(): Promise<MachineInfo>;
  listProjects(): Promise<Project[]>;
  listWorkspaces(project: string): Promise<Workspace[]>;
  createSession(options): Promise<string>;
  attachSession(sessionId): Promise<SessionStream>;
  detachSession(sessionId): Promise<void>;
  getInbox(): Promise<InboxItem[]>;
}
```

- `LocalMachineProvider`: Direct filesystem + tmux-lite CLI
- `RemoteMachineProvider`: Via relay WebSocket

## Development Workflow

### Building and Testing

```bash
# Type check
bun run typecheck

# Build
bun run build

# Run TUI
bun src/index.ts

# Run relay (uses Ed25519 identity from keychain)
bun src/index.ts relay start

# Run serve with gitspace.sh hosting (requires auth login + host reserve)
bun src/index.ts serve start

# Run serve with self-hosted relay
bun src/index.ts serve start --relay ws://localhost:4480/ws
```

### Code Style

- **TypeScript**: ESM modules, strict mode
- **Error Handling**: Use typed errors from `types/errors.ts`
- **Logging**: Use `logger` from `utils/logger.ts`
- **User Prompts**: Use `utils/prompts.ts`
- **Crypto**: Use `lib/tmux-lite/crypto/` modules

## Key Files Reference

| Purpose | Location |
|---------|----------|
| Entry point | `src/index.ts` |
| Config management | `src/core/config.ts` |
| Identity/crypto | `src/core/identity.ts`, `src/lib/tmux-lite/crypto/` |
| Access control | `src/core/access.ts` |
| Relay server | `src/relay/server.ts` |
| Relay protocol | `src/relay/protocol.ts` |
| Relay registries | `src/relay/registries.ts` |
| JWT tokens | `src/relay/jwt.ts` (HMAC + Ed25519) |
| Machine daemon | `src/commands/serve.ts`, `src/serve/` |
| Daemon lifecycle | `src/serve/daemon.ts` |
| X3DH handshake | `src/lib/tmux-lite/handshake-handler.ts` |
| Session management | `src/lib/tmux-lite/server.ts` |
| Frame protocol | `src/lib/tmux-lite/protocol.ts` |
| Encrypted frames | `src/lib/tmux-lite/crypto/frames.ts` |
| Secrets/keychain | `src/utils/secrets.ts` |
| GitHub auth | `src/commands/auth.ts` |
| Hosting commands | `src/commands/host.ts` |

## External Dependencies

**Runtime:**
- `commander` - CLI framework
- `@inquirer/prompts` - User prompts
- `@opentui/core` - Terminal UI framework
- `@linear/sdk` - Linear API client
- `chalk` - Terminal colors
- `ws` - WebSocket (relay)
- `@noble/curves` - Ed25519/X25519 crypto
- `@noble/ciphers` - AES-GCM encryption
- `@noble/hashes` - HKDF, SHA256
- `@xterm/headless` - Terminal state tracking
- `ghostty-opentui` - TUI terminal embedding

**System Commands:**
- `gh` - GitHub CLI
- `git` - Git operations

## Documentation

| File | Description |
|------|-------------|
| `README.md` | User-facing documentation |
| `AGENTS.md` | This file - development guide |
| `docs/PROTOCOL.md` | Relay message protocol |
| `docs/RELAY.md` | Relay server architecture |
| `docs/GETTING-STARTED.md` | Remote access setup guide |
| `docs/CONNECTION.md` | Connection state management |
| `docs/REMOTE-DESIGN.md` | E2E encryption design (identity-based) |
| `docs/UNIFIED_ARCHITECTURE.md` | TUI/Web architecture plan |
| `docs/GATEWAY-WORKER.md` | Cloudflare Worker gateway spec |
| `docs/ROADMAP.md` | Feature roadmap and vision |
| `docs/INFRASTRUCTURE.md` | Future VM infrastructure (not implemented) |
| `docs/STACK-DESIGN.md` | Future stacked PR feature (not implemented) |

---

## Configuration

### Config Files

| File | Location | Purpose |
|------|----------|---------|
| Global config | `~/gitspace/.config.json` | Current project, defaults |
| Project config | `~/gitspace/{project}/.config.json` | Project-specific settings |
| Identity | `~/gitspace/.identity/` | Keypairs |
| Access list | `~/gitspace/.access.json` | Authorized client public keys |
| Machine info | `~/gitspace/.machine.json` | Machine registration |
| Relay config | `~/gitspace/.relay.json` | Relay configuration cache |
| Host config | `~/gitspace/host.json` | gitspace.sh subdomain config |
| Daemon state | `~/gitspace/.serve/` | PID files, status sockets |
| tmux-lite state | `/tmp/` | Session data (configurable via `TMUX_LITE_SESSION_DIR`) |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_PORT` | Relay server port | `4480` |
| `RELAY_BIND` | Relay bind address | `0.0.0.0` |
| `RELAY_PRIVATE_KEY` | Base64 Ed25519 private key | Uses keychain |
| `RELAY_LABEL` | Label for relay identity | None |
| `GITSPACE_API_URL` | gitspace.sh API URL | `https://api.gitspace.sh` |

### Default Values

| Setting | Default | Location |
|---------|---------|----------|
| Projects directory | `~/gitspace` | Global config |
| Base branch | `main` | Global/project config |
| Stale workspace days | `30` | Global config |
| Relay port | `4480` | CLI/env |

---

**Last Updated**: 2026-01
**Runtime**: Bun 1.3+
