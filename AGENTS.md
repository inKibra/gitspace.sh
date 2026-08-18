# Claude Code Development Guide

This document provides comprehensive information for AI assistants working on the GitSpace project.

## Project Overview

**GitSpace** manages GitHub repository workspaces using git worktrees, with secure remote terminal access via an E2E encrypted relay system. There is no TUI. The interactive surface is the web app, and `gssh web` is the command that starts it.

People do not drive GitSpace from the terminal. They run a few setup commands once, start `gssh web`, and then work in the browser. The CLI reference below exists because agents and scripts need it, not because the terminal is the product.

**Key Capabilities:**
- Git worktrees for parallel branch development
- Web app for interactive workspace management
- **Remote terminal access** via E2E encrypted relay
- **Identity-based access control** with Ed25519/X25519 keys
- **X3DH handshake** for forward-secret session encryption
- Web terminal interface (React + ghostty-web)
- Linear issue integration for workspace creation
- Convention-based custom scripts in `.gitspace/scripts/` (pre, setup, select, remove phases)

## Getting Started

`gssh web` starts the local relay plus the machine serve daemon on this machine, registers a one-time browser enrollment with the relay, and opens the browser at that enrollment URL. Press Ctrl+C to stop the stack it started.

```bash
gssh user identity init   # user root identity (24-word mnemonic)
gssh web                  # start the local web stack and open the browser
```

`gssh web` fails with a named remedy when a prerequisite is missing:

| Missing | Error names |
|---------|-------------|
| Web UI assets | `bun run build:web` |
| User root identity | `gssh user identity init` or `gssh user identity recover` |
| Local device identity | `gssh user auth login` |

`gssh web` does not check gitspace.sh authentication. GitHub login only matters if you want a gitspace.sh subdomain, which is the `--relay` path (`gssh web --relay` requires `cloudflared` and a reserved subdomain).

`gssh web` options (verified from `gssh web --help`):

| Option | Meaning |
|--------|---------|
| `--port <port>` | Local relay/web port (default `4480`) |
| `--relay` | Start a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain |
| `-y, --yes` | Auto-confirm prompts |
| `--takeover` | Clear persisted owner/control state and stale relay trust pins before starting |
| `--password-stdin` | Read the device identity password from stdin |

## Architecture

### Core Concepts

1. **Projects**: Top-level containers for a GitHub repository
   - Located at `~/gitspace/<project-name>/`
   - Contains: base repo clone, workspaces, config
   - Can also be created from scratch with `gssh project create` (git init, no GitHub repo)

2. **Workspaces**: Individual git worktrees for features/branches
   - Located at `~/gitspace/<project-name>/workspaces/<workspace-name>/`
   - Each workspace has its own branch
   - Each workspace has a kanban phase: `plan`, `code`, `review`, `ship`
   - Scripts are sourced from `.gitspace/scripts/<phase>/` in the workspace (version-controlled)

3. **Sessions**: PTY terminal sessions managed by tmux-lite
   - Can be attached from multiple clients
   - State maintained by xterm-headless on server

4. **Identity**: Cryptographic keypair per machine/client
   - Ed25519 for signing (proving identity)
   - X25519 for key exchange (establishing encryption)
   - Stored in `~/gitspace/.identity/` directory:
     - `keypair.json` - Encrypted identity keypair
     - `machine.json` - Machine registration info
     - `relay.json` - Persisted relay enrollment
   - Relay control store: `~/gitspace/.relay/control/control.db`

5. **Relay**: WebSocket server for routing encrypted traffic
   - Connects machines to clients through NAT/firewalls
   - Cannot decrypt terminal content (E2E encryption)

### Directory Structure

```
src/
├── index.ts                    # Entry point (internal subprocess modes, then CLI dispatch)
├── cli/                        # Commander command tree
│   ├── index.ts                # Root program, top-level command registration
│   └── commands/               # One file per top-level command
│       ├── project.ts  workspace.ts  machine.ts  invite.ts
│       ├── client.ts   user.ts       cloud.ts    relay.ts
│       ├── artifacts.ts space.ts     status.ts   web.ts   gallery.ts
├── commands/                   # Command implementations the CLI tree calls into
├── core/                       # Business logic (config, git, github, identity,
│                               #   artifacts, goals, review, workspace lifecycle)
├── lib/
│   ├── tmux-lite/              # Terminal multiplexer library
│   │   ├── cli.ts              # CLI interface for tmux-lite
│   │   ├── server.ts           # Session manager with xterm-headless
│   │   ├── protocol.ts         # Frame format + runtime path resolution
│   │   ├── handshake-handler.ts # X3DH handshake management
│   │   ├── relay-client.ts     # WebSocket client for relay
│   │   ├── agents/             # Agent session runtime + worker
│   │   └── crypto/             # Cryptography implementations
│   │       ├── identity.ts     # Ed25519/X25519 key generation
│   │       ├── keyexchange.ts  # X25519 ECDH
│   │       ├── secretbox.ts    # AES-256-GCM via node:crypto
│   │       ├── frames.ts       # Encrypted frame format
│   │       ├── handshake.ts    # X3DH protocol steps
│   │       ├── root-invites.ts # Signed root invite tokens
│   │       ├── device-cert.ts  # Device certificates
│   │       └── access-control.ts # ACL checking
│   ├── remote-session/         # Remote session protocol + handler
│   ├── processes/              # Process runner
│   └── services/  events/  storage/  # Service endpoints, event log, identity store
├── relay/                      # Relay server
│   ├── index.ts                # Standalone entry point (env-configured)
│   ├── server.ts               # WebSocket routing server
│   ├── protocol.ts             # Message types and validation
│   ├── registries.ts           # Active machine tracking
│   ├── pipes.ts                # Pipe abstraction for data routing
│   ├── types.ts                # WebSocketData, RelayConfig, enrollment types
│   ├── auth/store.ts           # Relay auth store
│   └── control/                # Control plane store, cloud provider config
├── serve/                      # Machine daemon pieces
│   ├── client-session-manager.ts # Client connection handling
│   ├── pty-session.ts          # PTY session management
│   └── types.ts                # ServeOptions, permissions
├── app/                        # Web app shells (client, input, react, session, shared, workspaces)
├── components/                 # UI components (mostly *.web.tsx)
├── pages/                      # Route-level web pages
├── blocks/                     # Transcript block model + renderers
├── session/                    # Session engine, backends, adapters
├── relay-client/               # Browser/client relay + machine directory clients
├── machine/                    # Machine API, controllers, local/multi state
├── agents/                     # Agent session state and display helpers
├── hooks/  preferences/  notifications/  integrations/  sdk/  cloud/
├── types/                      # TypeScript type definitions
└── utils/                      # Utility functions
web/                            # Vite build for the web UI (bun run build:web)
```

## CLI Commands

Top-level commands: `project`, `workspace`, `machine`, `invite`, `client`, `user`, `cloud`, `relay`, `artifacts`, `status`, `web`, `gallery`. `space` is also real and works, but it is deliberately hidden from the root `--help` listing.

`gssh` with no arguments prints help.

### Web App

| Command | Description |
|---------|-------------|
| `gssh web` | Start the local relay + serve web stack and open the browser |
| `gssh web --relay` | Same, but start a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain |
| `gssh gallery [blocks\|transcript]` | Open the block render gallery (design surface for transcript blocks and tool calls) |

### Projects

| Command | Description |
|---------|-------------|
| `gssh project list` | List all projects (`--json`, `--verbose`) |
| `gssh project add` | Add a new project from GitHub (`--no-clone`, `--org`, `--linear-key`, `--bundle-url`, `--bundle-path`, `--skip-bundle`) |
| `gssh project create <name>` | Create a from-scratch project with git init (`--base-branch`, `--workspace`) |
| `gssh project remove [project-name]` | Remove a project (`--force`) |

### Workspaces

| Command | Description |
|---------|-------------|
| `gssh workspace list --project <name>` | List workspaces in a project (`--json`, `--verbose`) |
| `gssh workspace add [name] --project <name>` | Create a workspace (`--branch`, `--from`, `--status`, `--issue`, `--no-setup`) |
| `gssh workspace set-phase <name> --project <name> --phase <phase>` | Set kanban phase: plan, code, review, ship |
| `gssh workspace remove [name] --project <name>` | Remove a workspace (`--force`, `--keep-branch`) |
| `gssh workspace context --project <name> --workspace <name>` | Show resolved workspace context (`--json`) |
| `gssh workspace review` | Diff review system |
| `gssh workspace notes` | Manage local workspace notes and todos |
| `gssh workspace session list\|new\|attach` | Manage terminal sessions in a workspace |
| `gssh workspace service` | Manage workspace services |
| `gssh workspace events` | Query workspace event logs |
| `gssh workspace bundle` | Manage bundle configuration (see Bundle Management) |

### Workspace-Scoped Commands (`gssh space`)

Hidden from the root help listing, but real. Paths and context resolve against the current workspace.

| Command | Description |
|---------|-------------|
| `gssh space context` | Show resolved workspace context |
| `gssh space review` | Diff review system (`list`, `import`, `push`, `hunks`, `add-hunk`, `add-file`, `add-line`) |
| `gssh space goal` | Author goal doc, declare validation contract, judge requirements (`show`, `set`, `edit`, `doc`, `status`, `requirement`, `artifact`, `review`) |
| `gssh space chain` | Manage this space's linear goal chain |
| `gssh space stack` | Validate this space's git stack |
| `gssh space notes` | Manage local workspace notes and todos |
| `gssh space service` | Manage workspace services |
| `gssh space hosting` | Configure tmux-lite service hosting |
| `gssh space events` | Query workspace event logs |
| `gssh space bundle` | Manage workspace bundle configuration |
| `gssh space journal` | Phase-boundary journal: narrative from the agent, state snapshots from the system |
| `gssh space guide` | Review guide: analyzer worksheet + validated narrator submission |
| `gssh space artifacts` | Workspace artifacts (see Artifacts) |
| `gssh space workflow` | The workspace's single canonical workflow spec (`*.workflow.json` on the artifacts mount) |

### Identity & Access

| Command | Description |
|---------|-------------|
| `gssh user identity init` | Initialize a new identity (generates 24-word mnemonic) |
| `gssh user identity show` | Show identity information |
| `gssh user identity recover` | Recover identity from 24-word mnemonic |
| `gssh user identity export` | Export public key in `gssh-user:` format |
| `gssh user identity import <key>` | Import a peer public key (validates format) |
| `gssh user identity remove` | Remove identity from keychain (requires mnemonic to recover) |
| `gssh user identity backup` | Manage optional encrypted cloud backup of your user identity |
| `gssh invite relay-machine create` | Create a relay-machine invite |
| `gssh invite list` | List relay-machine invites you own (`--relay`, `--json`) |
| `gssh invite revoke <invite-id>` | Revoke a machine enrollment invite (`--relay`) |

### Remote Access (daemon path)

These are the daemon commands. For normal use, `gssh web` starts and supervises them for you.

| Command | Description |
|---------|-------------|
| `gssh machine serve start` | Start the serve daemon (auto-selects relay when `--relay` is omitted) |
| `gssh machine serve start --foreground` | Run the serve daemon in the foreground instead of daemonizing |
| `gssh machine serve stop` | Stop the serve daemon |
| `gssh machine serve status` | Show serve daemon status |
| `gssh client connect [target]` | Connect to a machine as the owner identity (`--relay`, `--relay-pubkey`, `--machine`) |
| `gssh client machines list` | List machines you can access (`--relay`, `--relay-pubkey`, `--json`) |
| `gssh status` | Show status of all gitspace daemons |

`gssh machine serve start` also accepts `--relay-pubkey`, `--bootstrap-token`, `--enrollment-token`, `--unlock-token`, `--workspace-id`, `--ignore-keychain-and-skip-secrets`, `--takeover`, `-y/--yes`, and `--password-stdin`.

### Relay Server

| Command | Description |
|---------|-------------|
| `gssh relay start` | Start relay server in background (`--port`, `--bind`, `--hostname`, `--mode auto\|hosted\|local`, `--label`, `--foreground`, `--takeover`, `-y`) |
| `gssh relay stop` | Stop the relay server |
| `gssh relay status` | Show relay server status (`--json`) |
| `gssh relay machines list` | List registered machines (`--json`) |
| `gssh relay machines revoke <machine-id>` | Remove a machine from the relay registry |
| `gssh invite relay-machine create --relay <url> --machine-signing-key <k> --machine-key-exchange-key <k>` | Create a machine enrollment invite (`--expires` default `24h`, `--max-uses` default `1`, `--label`) |

### tmux-lite Daemon

`gssh machine tmux` accepts a global `--sandbox <name>` to use an isolated runtime.

| Command | Description |
|---------|-------------|
| `gssh machine tmux start` | Start the tmux-lite server daemon |
| `gssh machine tmux stop` | Stop the tmux-lite server daemon |
| `gssh machine tmux status` | Show tmux-lite server status |
| `gssh machine tmux list` | List active tmux-lite sessions |
| `gssh machine tmux new [name]` | Create and attach to a new session |
| `gssh machine tmux attach <id>` | Attach to a session (by id or name) |
| `gssh machine tmux kill <id>` | Kill a session (by id or name) |
| `gssh machine tmux replay` | Inspect saved tmux-lite replays |
| `gssh machine tmux hosting` | Configure tmux-lite service hosting |

### Machine Enrollment

| Command | Description |
|---------|-------------|
| `gssh machine enroll --invite <token>` | Enroll this machine with a relay-machine invite (`--label`) |

### Cloud Workspaces

| Command | Description |
|---------|-------------|
| `gssh cloud setup` | Configure cloud provider credentials (Sprites token) |
| `gssh cloud status` | Show cloud control status for the running serve daemon |
| `gssh cloud list` | List cloud workspaces from the control relay store |
| `gssh cloud launch` | Launch a new cloud agent workspace |
| `gssh cloud stop <workspaceId>` | Hibernate a running cloud workspace |
| `gssh cloud resume <workspaceId>` | Wake a hibernated cloud workspace |
| `gssh cloud destroy <workspaceId>` | Permanently destroy a cloud workspace (irreversible) |
| `gssh cloud connect <workspaceId>` | Connect to a cloud workspace by workspace ID |

### Authentication (gitspace.sh)

Only needed for gitspace.sh hosting and for creating the local device identity. Not required by `gssh web` for a local-only stack beyond the device identity itself.

| Command | Description |
|---------|-------------|
| `gssh user auth login` | Login with GitHub |
| `gssh user auth logout` | Logout and clear credentials |
| `gssh user auth status` | Show login status |

### Hosting (gitspace.sh)

| Command | Description |
|---------|-------------|
| `gssh user host reserve <subdomain>` | Reserve a subdomain (e.g. brad.gitspace.sh) |
| `gssh user host release [subdomain]` | Release a subdomain |
| `gssh user host list` | List your subdomains |
| `gssh user host set-primary <subdomain>` | Set primary subdomain for hosted relay and tmux hosting |
| `gssh user host status` | Show hosting status |
| `gssh user host doctor` | Check hosted relay readiness and remediation steps |

### Notifications and Maintenance

| Command | Description |
|---------|-------------|
| `gssh user config notifications` | Configure notification settings |
| `gssh user notifications install` | Install shell hooks for notification integration |
| `gssh user notifications uninstall` | Remove shell hooks from shell config files |
| `gssh user notifications hook` | Print the shell hook snippet for manual installation |
| `gssh user notifications status` | Show notification settings and hook installation status |
| `gssh user migrate cleanup-legacy` | Delete stale keychain entries after migration to unified secrets |

### Linear Integration

| Command | Description |
|---------|-------------|
| `gssh user config linear setup` | Configure Linear integration |
| `gssh user config linear show` | Show Linear configuration |
| `gssh user config linear clear` | Clear Linear configuration |

Each of these accepts `--project <name>` to act on a project's configuration instead of the user-level one.

### Artifacts (per-project artifacts repo; see docs/ARTIFACTS-FS.md, docs/ARTIFACT-PROTOCOL.md)

`gssh artifacts` subcommands all accept `--project <name>` (defaults to the current project).

| Command | Description |
|---------|-------------|
| `gssh artifacts provision` | Provision a private GitHub artifacts repo (`<owner>/<repo>-artifacts`), push, mirror collaborators, upload large files to GitHub LFS |
| `gssh artifacts status` | Show the artifacts repo, its tier (GitHub/BYO/local), branches, and blob state |
| `gssh artifacts remote add <url>` | Attach a git remote for the artifacts repo and record it in `.gitspace/artifacts.json` |
| `gssh artifacts sync` | Fetch + fast-forward main, then push all artifact branches to the remote |
| `gssh artifacts rollup <workspace>` | Merge a workspace's artifacts branch into main (`--remove-branch`) |
| `gssh artifacts repair` | Convert raw large files in never-pushed commits to LFS pointers (`--workspace`) |
| `gssh space artifacts commit <paths...> -m <msg>` | Capture files already written in the artifacts mount: pointer split + provenance in one commit (`--cap <token>` verifies and enforces a write scope) |
| `gssh space artifacts promote <source> <destRelPath>` | Promote an uncommitted working file into the versioned artifacts tree (the typing act) (`-m`) |
| `gssh space artifacts scratch-path <rel>` | Print the absolute path a `local://<rel>` reference resolves to |
| `gssh space artifacts share <relPath>` | Mint a signed public link served through your relay, requires serve active (`--ttl` default `7d`, `--max-uses`, `--live`) |
| `gssh space artifacts share-list` | List minted share links (this machine) |
| `gssh space artifacts share-revoke <tokenId>` | Revoke a share link |
| `gssh space artifacts repair` | Convert raw large files in never-pushed commits to LFS pointers |

### Bundle Management

| Command | Description |
|---------|-------------|
| `gssh workspace bundle status --project <name> --workspace <name>` | Show bundle status |
| `gssh workspace bundle show --project <name> --workspace <name>` | Show current bundle values, secret set-status, and confirm status |
| `gssh workspace bundle edit --project <name> --workspace <name>` | Update bundle inputs, secrets, and confirm states |
| `gssh workspace bundle refresh --project <name> --workspace <name>` | Re-run bundle onboarding (keeps previous values as defaults) |
| `gssh workspace bundle refresh ... --force` | Force refresh even if no changes detected |
| `gssh workspace bundle refresh ... --no-base-fallback` | Only refresh a workspace-local `.gitspace/bundle.json` |

## Remote Access Architecture

```text
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│  Your Machine   │          │  Relay Server   │          │     Client      │
│                 │          │                 │          │                 │
│  serve daemon   │◀════════▶│  Routing only   │◀════════▶│ Browser web app │
│  (PTY sessions) │ WebSocket│  E2E encrypted  │ WebSocket│ or gssh client  │
│                 │          │ (can't decrypt) │          │     connect     │
└─────────────────┘          └─────────────────┘          └─────────────────┘
```

### Connection Flow (local web app)

1. `gssh user identity init` creates the user root identity
2. `gssh web` starts a local relay on port 4480 and starts the serve daemon against it
3. `gssh web` registers a one-time browser enrollment with the relay
4. `gssh web` opens `http://127.0.0.1:4480/?enroll=<token>`
5. X3DH handshake establishes session keys
6. All terminal I/O is E2E encrypted

### Connection Flow (gitspace.sh Hosting)

1. User logs in: `gssh user auth login` (GitHub OAuth)
2. User reserves subdomain: `gssh user host reserve <name>`
3. `gssh web --relay` starts a hosted relay with a cloudflared tunnel and starts serve against it
4. `gssh web --relay` opens `https://<name>.gitspace.sh/?enroll=<token>`
5. X3DH handshake establishes session keys
6. All terminal I/O is E2E encrypted

### Connection Flow (Self-Hosted Relay)

1. Machine runs `gssh machine serve start --relay ws://relay:4480/ws`
2. Machine registers with relay (Ed25519 challenge-response auth)
3. Owner creates a relay-machine invite (`gssh invite relay-machine create ...`); the collaborator machine enrolls with it (`gssh machine enroll --invite <token>`)
4. Client connects: `gssh client connect <machine-id>`
5. X3DH handshake establishes session keys
6. All terminal I/O is E2E encrypted

### Agent Session Panes

An agent pane is opened with `agent-open` and closed with `agent-release` over the local socket, or with `open_agent_session` and `release_agent_session` over the relay. Opening takes a viewer lease on the daemon; releasing drops it. Agent sessions have no attached terminal; the web client renders a native block transcript. The machine daemon and tmux-lite daemon run as one process, with agent SDK sessions in per-session worker child processes.

### Cryptographic Primitives

| Purpose | Algorithm |
|---------|-----------|
| Identity signing | Ed25519 |
| Key exchange | X25519 |
| Symmetric encryption | AES-256-GCM |
| Key derivation | HKDF-SHA256 |
| Relay authentication | Ed25519 challenge-response |

## Shared Component Pattern

Some components in `src/components/` are split into two files:
- `Component.tsx` - Logic/hooks
- `Component.web.tsx` - Web rendering (React DOM)

The components with both files are `Events`, `Flow`, `Inbox`, `KanbanBoard`, and `WorkspaceDetailPane`. Most components are web-only and exist just as `*.web.tsx`; a few, such as `MachineList` and `SpacesBrowser`, are logic-only `.tsx` files with no web counterpart.

Remote machine access in the UI uses the shared relay/session modules: `src/relay-client/*` and `src/session/*`.

## Development Workflow

### Building and Testing

```bash
# Tests — ALWAYS use this for any result you intend to trust.
# Runs each test file in its own process. Bun's `mock.module` is process-global
# and `mock.restore()` does not undo it, so a shared process leaks mocks between
# files: bare `bun test` reported 125 failures and hung, while the same tree run
# one file per process reported 5. `bun test <one.test.ts>` is fine for a single
# file; anything wider needs this.
bun run test

# Single-process run — fast iteration ONLY, results are not trustworthy.
bun run test:fast

# Type check
bun run typecheck

# Lint
bun run lint

# Build the web UI (required before `gssh web` can serve it)
bun run build:web

# Build the CLI binary
bun run build

# Run the product: local relay + serve + browser
bun src/index.ts web

# Run relay on its own (uses Ed25519 identity from keychain)
bun src/index.ts relay start

# Run the serve daemon against a specific relay
bun src/index.ts machine serve start --relay ws://localhost:4480/ws
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
| CLI command tree | `src/cli/index.ts`, `src/cli/commands/` |
| Web stack launcher | `src/commands/web.ts` |
| Config management | `src/core/config.ts`, `src/core/paths.ts` |
| Identity/crypto | `src/core/identity.ts`, `src/core/user-identity.ts`, `src/lib/tmux-lite/crypto/` |
| Access control | `src/relay/auth/store.ts` |
| Relay control store | `src/relay/control/store.ts` |
| Relay server | `src/relay/server.ts` |
| Relay protocol | `src/relay/protocol.ts` |
| Relay registries | `src/relay/registries.ts` |
| Machine daemon | `src/commands/serve.ts`, `src/serve/` |
| X3DH handshake | `src/lib/tmux-lite/handshake-handler.ts` |
| Session management | `src/lib/tmux-lite/server.ts` |
| Frame protocol | `src/lib/tmux-lite/protocol.ts` |
| Encrypted frames | `src/lib/tmux-lite/crypto/frames.ts` |
| Remote session protocol | `src/lib/remote-session/protocol.ts`, `src/lib/remote-session/session-handler.ts` |
| Secrets/keychain | `src/utils/secrets.ts` |
| GitHub auth | `src/commands/auth.ts` |
| Hosting commands | `src/commands/host.ts` |

## External Dependencies

**Runtime (root `package.json`):**
- `commander` - CLI framework
- `@inquirer/prompts` - User prompts
- `@linear/sdk` - Linear API client
- `chalk` - Terminal colors
- `ws` - WebSocket (relay)
- `@noble/curves` - Ed25519/X25519 crypto
- `@noble/hashes` - HKDF, SHA256
- `@scure/bip39` - 24-word identity mnemonics
- `@xterm/headless` - Terminal state tracking
- `simple-git` - Git operations
- `hono` - HTTP routing
- `react`, `react-dom`, `dockview` - Web UI
- `@fly/sprites` - Cloud workspace provider

Symmetric encryption on the machine side uses AES-256-GCM from `node:crypto`. The browser build (`web/package.json`) uses `@noble/ciphers` for the same purpose, along with `ghostty-web` for the terminal.

**System Commands:**
- `git` - the only dependency checked by `src/utils/deps.ts`
- `gh` - GitHub CLI, optional, used for GitHub repo discovery and auth checks
- `cloudflared` - only required for hosted relays (`gssh web --relay`)

## Documentation

| File | Description |
|------|-------------|
| `README.md` | User-facing documentation |
| `AGENTS.md` | This file - development guide |
| `docs/QUICKSTART.md` | Quick start |
| `docs/PROTOCOL.md` | Relay message protocol |
| `docs/RELAY.md` | Relay server architecture |
| `docs/GETTING-STARTED.md` | Remote access setup guide |
| `docs/CONNECTION.md` | Connection state management |
| `docs/REMOTE-DESIGN.md` | E2E encryption design (identity-based) |
| `docs/UNIFIED_ARCHITECTURE.md` | Unified daemon and agent session architecture |
| `docs/DAEMON-UNIFICATION.md` | Daemon unification notes |
| `docs/ARTIFACTS-FS.md`, `docs/ARTIFACT-PROTOCOL.md` | Artifacts filesystem and protocol |
| `docs/REVIEW-GUIDE.md` | Review guide |
| `docs/GATEWAY-WORKER.md` | Cloudflare Worker gateway spec |
| `docs/ROADMAP.md` | Feature roadmap and vision |
| `docs/INFRASTRUCTURE.md` | Future VM infrastructure (not implemented) |

---

## Configuration

### Config Files

| File | Location | Purpose |
|------|----------|---------|
| Global config | `~/gitspace/.config.json` | Current project, defaults |
| Project config | `~/gitspace/{project}/.config.json` | Project-specific settings |
| Identity keypair | `~/gitspace/.identity/keypair.json` | Encrypted device keypair |
| Machine info | `~/gitspace/.identity/machine.json` | Machine registration |
| Relay enrollment | `~/gitspace/.identity/relay.json` | Persisted relay enrollment |
| Relay control store | `~/gitspace/.relay/control/control.db` | Control plane state, ACL, invites |
| Relay runtime | `~/gitspace/.relay/runtime/` | `relay-state.json`, `relay.log`, one-time enrollment files |
| Host config | `~/gitspace/host.json` | gitspace.sh subdomain config |
| Artifact shares | `~/gitspace/.serve/artifact-shares.json` | Minted artifact share links |
| tmux-lite runtime | `/tmp/tmux-lite.sock`, `/tmp/tmux-lite.pid`, `/tmp` | Socket, pid file, session data |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GITSPACE_WORKSPACE_ROOT` / `GITSPACE_HOME` | Projects/workspaces root | `~/gitspace` |
| `GITSPACE_IDENTITY_DIR` | Identity directory override | `<workspace root>/.identity` |
| `GITSPACE_CONFIG_ROOT` | Global config directory override | workspace root |
| `GITSPACE_API_URL` | gitspace.sh API URL | `https://api.gitspace.sh` |
| `RELAY_PORT` | Relay server port | `4480` |
| `RELAY_BIND` | Relay bind address | `0.0.0.0` |
| `RELAY_PRIVATE_KEY` | Base64 Ed25519 private key | Uses keychain |
| `RELAY_LABEL` | Label for relay identity | None |
| `TMUX_LITE_SOCKET` | tmux-lite router socket | `/tmp/tmux-lite.sock` |
| `TMUX_LITE_PID_FILE` | tmux-lite pid file | `/tmp/tmux-lite.pid` |
| `TMUX_LITE_SESSION_DIR` | tmux-lite session data dir | `/tmp` |
| `TMUX_LITE_REPLAY_DIR` | tmux-lite replay dir | `<session dir>/tmux-lite-replays` |

### Default Values

| Setting | Default | Location |
|---------|---------|----------|
| Projects directory | `~/gitspace` | Global config |
| Default base branch | `main` | `DEFAULT_GLOBAL_CONFIG.defaultBaseBranch` |
| Stale workspace days | `30` | `DEFAULT_GLOBAL_CONFIG.staleDays` |
| Relay/web port | `4480` | CLI/env |
| Workspace kanban phase | `code` | `gssh workspace add --status` |

---

**Last Updated**: 2026-08
**Runtime**: Bun 1.3+
