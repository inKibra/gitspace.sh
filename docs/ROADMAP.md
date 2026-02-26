# GitSpace Roadmap

> **Living Document** - Captures the vision and implementation plan for GitSpace

---

## Vision

GitSpace is a unified development environment that combines:
- **Git worktrees** for parallel branch development
- **VM isolation** via Lima for secure, reproducible environments
- **Process management** via wide event observability
- **Remote access** via E2E encrypted relay
- **Instant hosting** via Cloudflare tunnels on `*.gitspace.sh`
- **Code intelligence** via ast-grep + AI for structural understanding

---

## Single Entry Point: `gssh`

The `gssh` command is the universal entry point:

```bash
# Local development (default)
gssh
# → Starts relay daemon in background (if not running)
# → Launches TUI
# → Shows local workspaces

# Connect to remote machine
gssh client connect --machine <machine-id> --relay <url>
gssh client connect --machine brads-macbook --relay ws://localhost:4480/ws

# Connect from another owner device
gssh client connect <machine-id>
```

### Startup Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         gssh (entry point)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   1. Check: Is relay daemon running?                                    │
│      └── No → Start `gssh machine serve start --foreground` in background                          │
│                                                                          │
│   2. Check: --remote flag?                                              │
│      └── Yes → Connect TUI to remote machine                            │
│      └── No  → Connect TUI to local machine                             │
│                                                                          │
│   3. Launch TUI                                                         │
│      └── Browse workspaces                                              │
│      └── Select workspace → ensure Lima VM running → attach session     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Feature Roadmap

### 1. Cloudflare Tunnel (Status: Partially Implemented)

Instant hosting on `*.gitspace.sh` subdomains.

**Implemented Commands:**
```bash
gssh user auth login             # GitHub OAuth authentication
gssh user auth logout            # Clear credentials
gssh user auth status            # Show auth status
gssh user host reserve <name>    # Reserve myapp.gitspace.sh
gssh user host release [name]    # Release subdomain
gssh user host list              # List your subdomains
gssh user host set-primary <n>   # Set primary subdomain
gssh user host status            # Show tunnel status
```

**Not Yet Implemented:**
- Service routing (e.g., `app.username.gitspace.sh` → `localhost:3000`)
- Per-service access control
- Gateway worker for auth at edge

**Architecture:**
```
Developer Mac                    Cloudflare                    Users
─────────────                    ──────────                    ─────

gssh machine serve start --foreground ────────────────────► Tunnel  ◄─────────────────── Browser
     │           (cloudflared)
     │
     ▼
localhost:4480 ◄─────────────── username.gitspace.sh (relay WebSocket)
```

**Implementation Files:**
- `src/commands/auth.ts` - GitHub OAuth device flow
- `src/commands/host.ts` - Subdomain management CLI
- `worker/` - Cloudflare Worker API (D1 database)
- Token stored in keychain via `src/utils/secrets.ts`

---

### 2. Lima VMs (Status: Not Implemented)

VM-per-workspace isolation using Lima. Works on all Apple Silicon (M1/M2/M3+).

**Why Lima:**
- Firecracker requires KVM (Linux-only)
- To run Firecracker on Mac, need nested virtualization
- Nested virt only works on M3+ with macOS 15+
- Lima VMs work on ALL Apple Silicon
- 5-10s boot time is acceptable for workspace-level isolation

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────────────┐
│                              MAC HOST                                    │
│                                                                          │
│   gssh (TUI)                                                            │
│       │                                                                  │
│       ▼                                                                  │
│   gssh machine serve start --foreground (daemon)                                                   │
│       │                                                                  │
│       ├── LimaManager (VM lifecycle)                                    │
│       │       │                                                          │
│       │       ├── Lima VM: feature-auth                                 │
│       │       │   └── tmux-lite-server                                  │
│       │       │   └── services (api, worker, db)                        │
│       │       │                                                          │
│       │       └── Lima VM: bugfix-login                                 │
│       │           └── tmux-lite-server                                  │
│       │           └── services                                          │
│       │                                                                  │
│       └── Relay connection (ONE machine identity)                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Design Decisions:**
- **VM per workspace**, not per service
- **Invisible to relay** - Mac appears as one machine with multiple workspaces
- **Session routing** - `gssh machine serve start --foreground` routes sessions to correct Lima VM
- **Dockerfile → rootfs** - Define VM environment via familiar Dockerfile

**Config:**
```json
{
  "vm": {
    "enabled": true,
    "cpus": 4,
    "memory": 4096,
    "dockerfile": "./Dockerfile.dev"
  }
}
```

**Implementation:**
- `src/core/lima/manager.ts` - VM lifecycle (start/stop/status)
- `src/core/lima/config.ts` - Generate Lima YAML from workspace config
- `src/core/lima/connection.ts` - Connect to tmux-lite inside VM
- `src/session/backends/lima-session-backend.ts` - Session backend implementation

**Session Lifecycle:**
1. User selects workspace in TUI
2. Check: Lima VM running for this workspace?
   - No → Boot Lima VM (~5-10s)
   - Yes → Continue
3. Check: Session exists?
   - No → Create session in VM's tmux-lite
   - Yes → Attach to existing session
4. User works in session
5. VM stays running until idle timeout

---

### 3. Process Runner + Wide Events (Status: Not Implemented)

Service management with observability via wide events.

**Concepts:**
- **Services** - Defined in config, managed by GitSpace
- **Wide Events** - Rich structured events (not metrics/logs/traces separately)
- **Event Correlation** - eventId chains become single wide events

**Commands:**
```bash
gssh run                    # Start all services
gssh run api worker         # Start specific services
gssh run --logs             # With log tailing

gssh events                 # TUI explorer
gssh events tail            # Live tail
gssh events "slow requests" # AI-powered query
gssh events --filter "http.status>=500" --group-by path
```

**Config:**
```json
{
  "services": [
    {
      "name": "api",
      "command": "bun run dev",
      "readyWhen": { "port": 3000 },
      "dependsOn": [],
      "events": { "source": "stdout", "format": "jsonl" }
    },
    {
      "name": "worker",
      "command": "bun run worker",
      "dependsOn": ["api"]
    }
  ],
  "events": {
    "enabled": true,
    "store": "sqlite",
    "flushTimeout": 5000
  }
}
```

**Event Format (apps emit):**
```json
{"eventId": "req-123", "eventKey": "http.start", "method": "GET", "path": "/users"}
{"eventId": "req-123", "eventKey": "db.query", "table": "users", "duration_ms": 45}
{"eventId": "req-123", "eventKey": "http.end", "status": 200, "finalEvent": true}
```

**Wide Event (after correlation):**
```json
{
  "eventId": "req-123",
  "http.method": "GET",
  "http.path": "/users",
  "http.status": 200,
  "db.query_count": 1,
  "db.total_duration_ms": 45
}
```

**Implementation:**
- `src/core/services/supervisor.ts` - Process manager
- `src/core/services/dependency.ts` - Dependency resolution
- `src/core/services/health.ts` - Ready checks
- `src/core/events/collector.ts` - Event ingestion
- `src/core/events/correlator.ts` - eventId → wide event
- `src/core/events/store/` - memory, sqlite, duckdb backends
- `src/core/events/query.ts` - Filter/group/aggregate
- `src/commands/run.ts` - CLI
- `src/commands/events.ts` - CLI

---

### 4. Code Intelligence (Status: Not Implemented)

ast-grep + AI for structural code understanding, inspired by Lumen.

**Concept:**
- Use **ast-grep** for structural code search (not text grep)
- **AI generates patterns** from natural language queries
- **Correlate with runtime** - connect slow events back to code
- **AI synthesizes** findings into actionable insights

**Commands:**
```bash
gssh query "how does auth work?"
gssh query "what calls validateUser?"
gssh query "why is checkout slow?"      # Uses runtime events + code
gssh query --impact "change User type"  # Impact analysis
```

**Architecture:**
```
User: "why is checkout slow?"
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Pattern Generator (AI → ast-grep rules)                         │
│     "Find all functions with 'checkout' in name"                   │
│     "Find all db queries in checkout flow"                         │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Structural Scan (ast-grep)                                      │
│     → 5 checkout-related functions                                  │
│     → 12 db queries in call graph                                  │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Runtime Correlation (wide events)                               │
│     → checkout requests have p95 = 850ms                           │
│     → db.query in OrderRepository taking 500ms                     │
└─────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. AI Synthesis                                                    │
│     "N+1 query in OrderRepository.findByUser() at src/repos/       │
│      order.ts:45. Called in loop by CartService.getItems()."       │
└─────────────────────────────────────────────────────────────────────┘
```

**Implementation:**
- `src/core/insight/index.ts` - Orchestrator
- `src/core/insight/pattern-gen.ts` - NL → ast-grep patterns
- `src/core/insight/scanner.ts` - Execute patterns
- `src/core/insight/graph.ts` - Dependency/call graphs
- `src/core/insight/ai-synth.ts` - AI synthesis
- `src/lib/ast-grep/runner.ts` - Shell out to sg CLI
- `src/commands/query.ts` - CLI

---

## Config Schema (Full)

```json
{
  "name": "my-app",
  "repository": "myorg/my-app",
  "baseBranch": "main",
  "createdAt": "2024-12-30T00:00:00.000Z",
  "lastAccessed": "2024-12-30T00:00:00.000Z",

  "vm": {
    "enabled": true,
    "cpus": 4,
    "memory": 4096,
    "disk": 50,
    "dockerfile": "./Dockerfile.dev"
  },

  "services": [
    {
      "name": "api",
      "command": "bun run dev",
      "cwd": "./api",
      "env": { "PORT": "3000" },
      "dependsOn": ["db"],
      "readyWhen": {
        "port": 3000,
        "timeout": 30000
      },
      "events": {
        "source": "stdout",
        "format": "jsonl"
      }
    },
    {
      "name": "db",
      "command": "postgres",
      "readyWhen": { "port": 5432 }
    }
  ],

  "events": {
    "enabled": true,
    "store": "sqlite",
    "flushTimeout": 5000,
    "maxEvents": 100000
  },

  "host": {
    "subdomain": "myapp",
    "routes": [
      { "path": "/api", "service": "api" },
      { "path": "/", "port": 8080 }
    ],
    "terminal": true,
    "access": {
      "mode": "private",
      "allowedKeys": []
    }
  },

  "bundleSecretKeys": ["GITSPACE_TOKEN"]
}
```

---

## CLI Reference (Current + Planned)

### Implemented

```bash
# Entry point
gssh                        # Start TUI
gssh client machines list --relay <url>  # List accessible machines on relay

# Identity
gssh user identity init          # Create user root identity
gssh user identity show          # Show fingerprint

# Invites
gssh invite relay-machine create --relay <url> --machine-signing-key <k> --machine-key-exchange-key <k> # Create machine enrollment invite
gssh invite list --relay <url>             # List machine enrollment invites
gssh invite revoke <invite-id> --relay <url> # Revoke machine enrollment invite

# Authentication (gitspace.sh)
gssh user auth login             # GitHub OAuth
gssh user auth logout            # Clear credentials
gssh user auth status            # Show auth status

# Hosting (gitspace.sh)
gssh user host reserve <name>    # Reserve subdomain
gssh user host release [name]    # Release subdomain
gssh user host list              # List subdomains
gssh user host set-primary <n>   # Set primary
gssh user host status            # Show status

# Remote access (owner-only)
gssh machine serve start --foreground                  # Start daemon (foreground)
gssh machine serve start            # Start daemon (background)
gssh machine serve stop             # Stop daemon
gssh user identity recover                # Recover same owner identity on another device
gssh client connect <target>             # Connect to target machine
gssh client machines list --relay <url>  # List accessible machines on relay
gssh status                 # Show daemon status

# Machine management
gssh machine enroll --invite <token>  # Enroll machine with relay-machine invite token

# Projects/workspaces
gssh project add            # Add project from GitHub
gssh workspace add <name> --project <project-name>  # Create workspace
gssh project list          # List projects
gssh workspace list --project <project-name>        # List workspaces
gssh workspace remove <name> --project <project-name>       # Remove workspace
gssh project remove         # Remove project

# Relay (internal)
gssh relay start            # Start relay server
gssh invite relay-machine create --relay <url> --machine-signing-key <k> --machine-key-exchange-key <k> # Create machine enrollment invite
gssh relay machines list    # List registered machines
gssh relay machines revoke <machine-id> # Revoke machine registration
```

### Planned (Not Implemented)

```bash
# Services (requires Lima VMs)
gssh run                    # Start all services
gssh run <service...>       # Start specific services
gssh stop                   # Stop all services
gssh logs <service>         # Tail logs

# Events
gssh events                 # TUI explorer
gssh events tail            # Live tail
gssh events query "..."     # AI-powered query

# Code intelligence
gssh query "..."            # Ask about code + runtime
```

---

## File Structure (New)

```
src/
├── commands/
│   ├── host.ts               # gssh user host *
│   ├── run.ts                # gssh run
│   ├── events.ts             # gssh events
│   └── query.ts              # gssh query
├── core/
│   ├── lima/
│   │   ├── manager.ts        # VM lifecycle
│   │   ├── config.ts         # Generate Lima YAML
│   │   └── connection.ts     # Connect to VM
│   ├── host/
│   │   ├── tunnel.ts         # cloudflared integration
│   │   └── dns.ts            # Cloudflare API
│   ├── services/
│   │   ├── supervisor.ts     # Process manager
│   │   ├── dependency.ts     # Dependency resolution
│   │   └── health.ts         # Ready checks
│   ├── events/
│   │   ├── collector.ts      # Event ingestion
│   │   ├── correlator.ts     # eventId chaining
│   │   ├── store/
│   │   │   ├── memory.ts
│   │   │   ├── sqlite.ts
│   │   │   └── duckdb.ts
│   │   └── query.ts          # Query interface
│   └── insight/
│       ├── index.ts          # Orchestrator
│       ├── pattern-gen.ts    # NL → ast-grep
│       ├── scanner.ts        # Pattern execution
│       ├── graph.ts          # Dependency graphs
│       └── ai-synth.ts       # AI synthesis
├── shared/
│   └── providers/
│       └── LimaMachineProvider.ts
└── lib/
    ├── ast-grep/
    │   ├── runner.ts         # sg CLI wrapper
    │   └── patterns.ts       # Common patterns
    └── events/
        └── emitter.ts        # SDK for apps
```

---

## Platform Support

| Platform | VM Isolation | Firecracker | Notes |
|----------|--------------|-------------|-------|
| Mac M1 | Lima VM | ❌ | No nested virt |
| Mac M2 | Lima VM | ❌ | No nested virt |
| Mac M3+ (macOS 15+) | Lima VM | ✅ (optional) | Nested virt works |
| Linux | Firecracker | ✅ | Native KVM |
| Cloud | Firecracker | ✅ | Via Flintlock/Nomad |

---

## Implementation Progress

| Feature | Status | Notes |
|---------|--------|-------|
| E2E Encrypted Remote Access | **Complete** | X3DH handshake, relay routing |
| Web Terminal Client | **Complete** | xterm.js, React |
| TUI Remote Access | **Complete** | `--relay` flag for TUI |
| Cloudflare Hosting | **Partial** | Auth, subdomains; missing service routing |
| Lima VMs | Not Started | Isolation layer for workspaces |
| Process Runner | Not Started | Depends on Lima |
| Event Collection | Not Started | Depends on Process Runner |
| Code Intelligence | Not Started | ast-grep + AI |

### Next Steps

1. **Complete Cloudflare Hosting** - Service routing, gateway worker at edge
2. **Lima VMs** - Workspace isolation on Mac
3. **Process Runner** - Service management inside VMs

---

*Last updated: 2025-01*
