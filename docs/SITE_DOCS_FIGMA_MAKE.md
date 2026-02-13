You are Figma Make editing the gitspace.sh documentation site:

You do NOT have access to our codebase. Use ONLY the factual specification below (it is copied from the repo and must be treated as truth). Update the site copy to match it exactly.

Hard constraints:
- Preserve the existing design system, spacing, typography, and components.
- Preserve existing navigation/anchors as much as possible. If the docs are a single page, keep it single-page but add a TOC at the top with anchor links.
- Replace any incorrect commands/flags/URLs with the exact ones below.
- Do not invent commands, flags, defaults, URLs, or security guarantees.
- Security claims must match "Security notes / current limitations" below (do not overpromise).

============================================================
A) PRODUCT FACTS (from the repo)
============================================================

Product name: GitSpace CLI
Binary: `gssh`

What it is:
- A CLI tool for managing GitHub repository workspaces using git worktrees, with an interactive TUI.
- Optional Linear integration for workspace creation.
- Supports repo config bundles for onboarding + convention-based scripts.
- Secure remote terminal access via E2E encrypted relay.

Key features (safe to claim):
- Interactive TUI for managing projects and workspaces
- Git worktrees for parallel branch development
- Linear integration (optional)
- Custom scripts (pre/setup/select/remove phases)
- Repo config bundles (in-repo or provided)
- Secure secrets for bundles stored via OS keychain (Bun.secrets)
- E2E encrypted remote terminal access
- Identity-based access control (not passwords)
- gitspace.sh instant hosting with custom subdomains

Remote access:
- GitSpace supports remote terminal access via a "relay" server.
- The relay routes traffic but cannot read terminal content (end-to-end encryption).
- Remote access uses identity-based cryptography with:
  - Ed25519 signing keys (identity)
  - X25519 key exchange keys
  - X3DH-style handshake
  - HKDF-SHA256 key derivation
  - AES-256-GCM encrypted frames after handshake
  - Ed25519-signed relay messages for client routing
  - Challenge-response machine registration (Ed25519)

============================================================
B) EXACT CLI COMMANDS + FLAGS + DEFAULTS (must match)
============================================================

Prereqs (list these on docs site):
- gh (GitHub CLI)
- git
- jq

Optional prereqs:
- cloudflared (for `gssh host` commands)
- Linear API key (for Linear integration)

Install (any package manager):
- `npm install -g gitspace`
- `bun install -g gitspace`
- `pnpm install -g gitspace`
- `yarn global add gitspace`
- Verify: `gssh --version`

---

### Workspace Management Commands

Local usage (examples you can show):
- `gssh` (launch TUI)
- `gssh add project`
- `gssh add [workspace-name]`
- `gssh switch [workspace-name]` (alias: `gssh sw`)
- `gssh switch project [project-name]`
- `gssh list projects` (alias: `gssh ls projects`)
- `gssh list workspaces` (alias: `gssh ls workspaces`; default `gssh list` lists workspaces)
- `gssh remove workspace [workspace-name]` (alias: `gssh rm workspace`)
- `gssh remove project [project-name]` (alias: `gssh rm project`)
- `gssh directory` (alias: `gssh dir`)

Options for `gssh add project`:
- `--bundle-url <url>` - Load bundle from remote URL (zip archive)
- `--bundle-path <path>` - Load bundle from local directory
- `--skip-bundle` - Skip bundle detection and onboarding
- `--no-clone` - Create project structure without cloning
- `--org <org>` - Filter repos to specific organization
- `--linear-key <key>` - Provide Linear API key via flag

Options for `gssh add [workspace-name]`:
- `--branch <name>` - Specify different branch name from workspace name
- `--from <branch>` - Create from specific branch instead of base
- `--no-setup` - Skip setup commands

Options for `gssh remove workspace`:
- `--force` - Skip confirmation prompts
- `--keep-branch` - Don't delete git branch when removing

---

### Identity Commands

- `gssh identity init [--label <name>] [--force]`
- `gssh identity show [--fingerprint] [--json]`

Identity is encrypted at rest and requires an unlock password when used for remote connections.

---

### Remote Access / Relay Commands

Start relay server:
- `gssh relay start [--port 4480] [--bind 0.0.0.0] [--hostname <host>] [--label <label>]`
- Default port: 4480

Relay management:
- `gssh relay authorize <pubkey>` - Authorize a machine by public key
- `gssh relay revoke <pubkey>` - Revoke a machine's authorization
- `gssh relay machines` - List authorized machines
- `gssh relay trusted` - List trusted relays (client-side)
- `gssh relay untrust <url>` - Remove relay trust (client-side)

---

### Serve Daemon Commands

- `gssh serve [--relay <url>] [--relay-pubkey <pubkey>]` - Start daemon (foreground)
- `gssh serve start [--relay <url>] [--relay-pubkey <pubkey>] [--password-stdin] [--foreground]` - Start daemon (background)
- `gssh serve stop` - Stop background daemon
- `gssh status` - Show all daemon statuses

Default relay URL for serving if not specified: `wss://relay.gitspace.sh`

When starting `gssh serve`, the user will be prompted:
- "Enter password to unlock identity:"

---

### Invite / Sharing Commands

Create share invite token:
- `gssh share create [--expires <duration>] [--session <id>] [--relay <url>]`
- Defaults:
  - `--expires` default: `24h`
  - `--relay` default: `wss://relay.gitspace.sh`
- Output includes a share URL of the form:
  - `https://gitspace.sh/join#<TOKEN>`

---

### Connect Commands

Connect via invite:
- `gssh connect <invite-token-or-url>`
- Accepts raw token OR a URL like `https://gitspace.sh/join#<TOKEN>`
- Options:
  - `--relay <url>` override relay URL (from token)

---

### Access Control List (ACL) Commands

- `gssh access add <pubkey> [--label <name>]`
- `gssh access list [--json]` (alias: `gssh access ls`)
- `gssh access remove <pubkey|label> [--force]` (alias: `gssh access rm`)

Public key format shown to users:
- `gssh-pub:<BASE64_SIGNING_PUBLIC_KEY>:<BASE64_KEY_EXCHANGE_PUBLIC_KEY>`

---

### tmux-lite Daemon Commands

- `gssh tmux start` - Start tmux-lite server daemon
- `gssh tmux stop` - Stop tmux-lite daemon
- `gssh tmux status` - Show tmux-lite daemon status
- `gssh tmux list` - List active terminal sessions
- `gssh tmux attach <id>` - Attach to session
- `gssh tmux new` - Create new session
- `gssh tmux kill <id>` - Kill session

---

### gitspace.sh Authentication Commands

- `gssh auth login` - Login via GitHub OAuth device flow
- `gssh auth logout` - Clear local credentials
- `gssh auth status` - Show authentication status

---

### gitspace.sh Hosting Commands

- `gssh host reserve <name>` - Reserve subdomain on gitspace.sh
- `gssh host release [name]` - Release a subdomain
- `gssh host list` - List your subdomains
- `gssh host set-primary <name>` - Set primary subdomain
- `gssh host status` - Show hosting status

============================================================
C) REMOTE ACCESS: CANONICAL USER FLOWS
============================================================

### Flow 1: gitspace.sh (Managed Service) - RECOMMENDED

This is the easiest way to get remote access:

```bash
# 1. Create identity (first time only)
gssh identity init --label "My MacBook"

# 2. Authenticate with GitHub
gssh auth login

# 3. Reserve your subdomain
gssh host reserve yourname
# You get: yourname.gitspace.sh and *.yourname.gitspace.sh

# 4. Start serving
gssh serve
# Automatically connects to gitspace.sh relay + Cloudflare tunnel

# 5. Access from browser
# Open: https://yourname.gitspace.sh
```

### Flow 2: Self-Hosted Relay

For complete control, run your own relay:

```bash
# Terminal 1: Start relay server
gssh relay start --port 4480 --bind 0.0.0.0
```

Relay listens at: `ws://<bind-or-hostname>:4480/ws`

```bash
# Terminal 2: Create identity on the machine
gssh identity init --label "My MacBook"
gssh identity show
```

```bash
# Terminal 3: Authorize machine on relay host
gssh relay authorize gssh-pub:<keys> --label "My MacBook"
```

```bash
# Terminal 4: Start serving
gssh serve --relay ws://localhost:4480/ws
# This will prompt for the identity password
```

```bash
# Terminal 5: Create an invite (while serve is running)
gssh share create
# Output: https://gitspace.sh/join#<TOKEN>
```

```bash
# On client device: Connect
gssh identity init --label "Work Laptop"  # First time only
gssh connect https://gitspace.sh/join#<TOKEN>
```

### Flow 3: Direct Connection (Pre-Authorized)

Once authorized, connect without an invite:

```bash
gssh --relay ws://localhost:4480/ws
# Lists available machines, select one to connect
```

============================================================
D) CUSTOM SCRIPTS & BUNDLES
============================================================

### Custom Scripts

GitSpace uses convention-based scripts stored per workspace in `.gitspace/scripts/`:

```
~/gitspace/<project>/workspaces/<workspace>/.gitspace/
└── scripts/
    ├── pre/      # Run before setup (once, in terminal)
    ├── setup/    # Run on workspace creation (once)
    ├── select/   # Run every time workspace is opened
    └── remove/   # Run before workspace deletion
```

Script execution rules:
- Scripts must be executable (`chmod +x`)
- Scripts run alphabetically (use `01-`, `02-` prefixes)
- Working directory: The workspace directory
- Arguments: `$1` = workspace name, `$2` = repository name
- Environment: Bundle values available by key name (for example `REGION`, `PULUMI_ACCESS_TOKEN`)

Example script (`.gitspace/scripts/select/01-status.sh`):
```bash
#!/bin/bash
WORKSPACE_NAME=$1
REPOSITORY=$2

echo "Switching to workspace: $WORKSPACE_NAME"
git fetch origin
git status
```

### Repo Config Bundles

Bundles allow repository owners to share onboarding configurations. Place in `.gitspace/` in your repo:

```
.gitspace/
├── bundle.json           # Bundle manifest with onboarding steps
└── scripts/
    ├── pre/              # Scripts to run before setup
    ├── setup/            # Scripts to run on first workspace creation
    ├── select/           # Scripts to run every time workspace is opened
    └── remove/           # Scripts to run before workspace deletion
```

Bundle manifest example (`bundle.json`):
```json
{
  "version": "1.0",
  "name": "my-app-bundle",
  "description": "Setup bundle for my-app",
  "onboarding": [
    {
      "id": "welcome",
      "type": "info",
      "title": "Welcome",
      "description": "Let's get you set up!"
    },
    {
      "id": "node",
      "type": "confirm",
      "title": "Node.js",
      "description": "Node.js 18+ is required",
      "checkCommand": "node",
      "installUrl": "https://nodejs.org"
    },
    {
      "id": "api-key",
      "type": "secret",
      "title": "API Key",
      "description": "Enter your API key",
      "configKey": "apiKey"
    },
    {
      "id": "team-name",
      "type": "input",
      "title": "Team Name",
      "description": "Enter your team name",
      "configKey": "teamName",
      "defaultValue": "engineering"
    }
  ]
}
```

Onboarding step types:

| Type | Purpose | Storage |
|------|---------|---------|
| `info` | Display information | N/A |
| `confirm` | Verify installation (can check command in PATH) | N/A |
| `secret` | Collect sensitive values (masked input) | OS Keychain |
| `input` | Collect plain text values | Project config |

Using bundle values in scripts:
```bash
#!/bin/bash
# Values available as environment variables:
# <KEY>               - Value by bundle config key name
# SPACE_VALUE_<KEY>   - Legacy alias for regular values
# SPACE_SECRET_<KEY>  - Legacy alias for secret values

if [ -n "$TEAMNAME" ]; then
  echo "Welcome, $TEAMNAME team!"
fi

if [ -n "$APIKEY" ]; then
  echo "API Key configured"
fi
```

Bundle sources:
- **In-repo** (automatic): `.gitspace/` directory in the cloned repository
- **Local path**: `gssh add project --bundle-path /path/to/bundle/`
- **Remote URL**: `gssh add project --bundle-url https://example.com/bundle.zip`

============================================================
E) CONFIGURATION REFERENCE
============================================================

### Global Configuration

Location: `~/gitspace/.config.json`

```json
{
  "currentProject": "my-app",
  "projectsDir": "/Users/username/spaces",
  "defaultBaseBranch": "main",
  "staleDays": 30
}
```

### Project Configuration

Location: `~/gitspace/<project>/.config.json`

```json
{
  "name": "my-app",
  "repository": "myorg/my-app",
  "baseBranch": "main",
  "linearApiKey": "lin_api_...",
  "linearTeamKey": "ENG",
  "bundleValues": {
    "teamName": "engineering"
  },
  "bundleSecretKeys": ["apiKey"],
  "appliedBundle": {
    "name": "my-app-bundle",
    "version": "1.0",
    "source": "/path/to/bundle",
    "appliedAt": "2025-01-01T00:00:00Z"
  }
}
```

### Identity Storage

Location: `~/gitspace/.identity/`

| File | Purpose |
|------|---------|
| `keypair.json` | Encrypted Ed25519/X25519 keys (password-protected) |
| `access-list.json` | Authorized client public keys |
| `machine.json` | Machine ID and label |
| `relay.json` | Relay configuration cache |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_PORT` | Relay server port | `4480` |
| `RELAY_BIND` | Relay bind address | `0.0.0.0` |
| `SPACES_CURRENT_PROJECT` | Override current project | From config |
| `GITSPACE_API_URL` | gitspace.sh API URL | `https://api.gitspace.sh` |

### Directory Structure

```
~/gitspace/
├── .config.json                 # Global configuration
├── .identity/                   # Identity files (see above)
├── <project-name>/
│   ├── .config.json             # Project configuration
│   ├── base/                    # Base repository clone
│   ├── workspaces/              # Git worktrees
│   │   └── <workspace-name>/
│   │       ├── gitspace.lock       # Setup completion marker
│   │       ├── .prompt/         # Linear issue details (if applicable)
│   │       │   └── issue.md
│   │       └── .gitspace/
│   │           ├── bundle.json
│   │           └── scripts/     # Custom scripts (per worktree)
│   │               ├── pre/
│   │               ├── setup/
│   │               ├── select/
│   │               └── remove/
```

============================================================
F) SECURITY MODEL
============================================================

### Cryptographic Primitives

| Purpose | Algorithm | Notes |
|---------|-----------|-------|
| Identity signing | Ed25519 | Fast, secure signatures |
| Key exchange | X25519 | ECDH for shared secrets |
| Key derivation | HKDF-SHA256 | Domain-separated key derivation |
| Symmetric encryption | AES-256-GCM | Authenticated encryption |
| Password KDF | Scrypt (N=2^15, r=8, p=1) | Encrypts identity at rest |

### What's Protected

| Data | Protection Level |
|------|------------------|
| Terminal keystrokes | E2E encrypted (AES-256-GCM) |
| Terminal output | E2E encrypted (AES-256-GCM) |
| Commands | E2E encrypted (AES-256-GCM) |
| Session content | E2E encrypted (AES-256-GCM) |
| Identity keys | Password-encrypted (Scrypt + AES-GCM) |
| Bundle secrets | OS Keychain (macOS Keychain, Linux libsecret) |

### What Relay Can See (Metadata Only)

| Data | Visible to Relay |
|------|------------------|
| Machine ID | Yes (required for routing) |
| Client identity ID | Yes (required for routing) |
| Connection timestamps | Yes (metadata) |
| Data volume (bytes) | Yes (metadata) |
| Online/offline status | Yes |
| Terminal content | NO (encrypted) |
| Keystrokes | NO (encrypted) |
| Commands and output | NO (encrypted) |

### Trust Boundaries

```
YOU TRUST:                           YOU DON'T NEED TO TRUST:
├── Your own machine                 ├── The relay operator
├── Clients you've authorized        ├── Network infrastructure
└── Devices holding your identity    └── Anyone without an invite

IF THE RELAY IS COMPROMISED:
✓ Terminal content is still safe (E2E encrypted)
✓ Identity keys are still safe (never sent to relay)
✗ Metadata is exposed (who connected when)
✗ Relay could deny service
```

### Access Types

| Type | Description | Capabilities |
|------|-------------|--------------|
| `full` | Permanent access grant | Browse all projects/workspaces, create/attach/kill sessions, manage access |
| `session-invite` | One-time session access | View specific session only, no browsing, read-only |

### Current Limitations

> **Important**: Include this callout on the site. These are known limitations.

1. **Client proof-of-possession**: The handshake doesn't fully enforce that the client possesses the private key corresponding to their claimed public key. If an attacker learns an authorized public key, ACL identity spoofing is theoretically possible.

2. **Permission enforcement**: Permission flags (`read`/`write`/`manage`) are not fully enforced server-side after the handshake completes. "View-only" access should be treated as intended behavior rather than a strict security guarantee.

These limitations are being addressed in future releases.

============================================================
G) TROUBLESHOOTING
============================================================

### Installation Issues

**"command not found: spaces"**
- Ensure Bun's global bin is in your PATH
- Try: `export PATH="$HOME/.bun/bin:$PATH"`
- Add to your shell profile (`~/.zshrc`, `~/.bashrc`)

**"GitHub CLI not authenticated"**
```bash
gh auth login
# Follow prompts to authenticate
```

### Identity Issues

**"No identity found"**
```bash
gssh identity init --label "My Device"
```

**"Failed to unlock identity"**
- You're entering the wrong password
- If forgotten, recreate: `gssh identity init --force`
- Warning: This invalidates existing invites and access grants

**"Identity already exists"**
- Use `--force` to overwrite: `gssh identity init --force`

### Connection Issues

**"Machine offline"**
- Ensure `gssh serve` is running on the target machine
- Check the machine can reach the relay URL
- Verify the machine is authorized on the relay

**"Client not authorized"**
- You need an invite to connect first
- Or have the machine owner add your public key:
  ```bash
  gssh access add <your-public-key> --label "Name"
  ```

**"Invite not found" or "Invite expired"**
- The invite may have expired (default: 24h)
- Already been used (single-use invites)
- Not been registered (ensure `gssh serve` was running when created)
- Create a new invite: `gssh share create --expires 7d`

**"Handshake timeout"**
- Check network connectivity
- Verify firewall allows WebSocket connections
- Both parties must have valid identities
- Try connecting again (transient network issue)

**"Connection refused" to relay**
- Verify relay URL is correct (`ws://` vs `wss://`)
- Check relay server is running
- Verify port is open/reachable

### Workspace Issues

**"Workspace already exists"**
- Choose a different name
- Or remove existing: `gssh remove workspace <name>`

**"Failed to create worktree"**
- Check branch doesn't already exist
- Ensure you have git write permissions
- Try: `git fetch origin` first

**"Setup scripts failed"**
- Check script is executable: `chmod +x .gitspace/scripts/setup/*.sh`
- Run manually to see error: `./.gitspace/scripts/setup/01-script.sh`
- Check environment variables are set

### Bundle/Secrets Issues

**"Bundle key variables are empty"**
1. Ensure you completed onboarding secret steps
2. Check OS keychain is accessible:
   - macOS: Keychain Access should be running
   - Linux: `libsecret` must be installed
3. Re-run onboarding if needed

### Hosting Issues (gitspace.sh)

**"Subdomain not available"**
- Name may be taken or reserved
- Try a different name
- Check your subdomains: `gssh host list`

**"Tunnel failed to connect"**
- Ensure `cloudflared` is installed
- Check internet connectivity
- Verify subdomain is reserved: `gssh host status`

**"Authentication failed" (gitspace.sh)**
- Token may be expired
- Re-authenticate: `gssh auth login`

============================================================
H) GLOSSARY
============================================================

| Term | Definition |
|------|------------|
| **Machine** | A device running `gssh serve` that accepts remote connections |
| **Client** | A device running `gssh connect` or browser accessing terminal |
| **Relay** | WebSocket server that routes encrypted traffic (default: `wss://relay.gitspace.sh`) |
| **Relay Identity** | Ed25519 keypair used by the relay to sign messages and challenges |
| **Authorized Machine** | Machine public key approved to register with a relay |
| **Identity** | Ed25519 signing + X25519 key exchange keypairs, encrypted at rest |
| **Invite** | Signed token that bootstraps trust and enables first connection |
| **ACL (Access Control List)** | Machine-managed list of authorized client identities |
| **X3DH** | Extended Triple Diffie-Hellman handshake for session key establishment |
| **PTY** | Pseudo-terminal, the interface between your shell and the terminal |
| **Worktree** | Git feature allowing multiple working directories for one repository |
| **Bundle** | Repository configuration package for team onboarding |
| **Session** | A terminal session managed by tmux-lite on the server |
| **Stream** | Encrypted channel within a connection (Stream 0 = master) |
| **TUI** | Terminal User Interface, the interactive `gssh` interface |
| **tmux-lite** | Built-in terminal multiplexer for managing sessions |
| **Subdomain** | Your custom URL on gitspace.sh (e.g., `yourname.gitspace.sh`) |

============================================================
I) WHAT TO WRITE ON THE SITE
============================================================

Update TWO pages: Home and Docs. Keep layout, replace text/code with the following.

-------------------------
HOME PAGE (replace copy)
-------------------------

Headline:
GitSpace: Git worktrees + secure remote access for parallel development

Subheadline:
Manage multiple features in one repo without stashing. Create isolated workspaces (git worktrees), switch instantly, and access your terminal remotely through end-to-end encrypted connections.

Primary CTA:
Get Started -> link to /docs

Feature bullets:
- **Interactive TUI**: Manage projects and workspaces visually
- **Git worktrees**: Multiple branches checked out at once
- **Repo onboarding bundles**: Team setup steps + custom scripts
- **Secure remote access**: E2E encrypted terminal from anywhere
- **gitspace.sh hosting**: Instant subdomains like `yourname.gitspace.sh`
- **Identity-based auth**: Cryptographic keys, not passwords

Short code example:
```bash
# Install
npm install -g gitspace

# Launch the TUI
spaces

# Or via CLI
gssh add project      # Add a GitHub repo
gssh add my-feature   # Create a workspace
gssh switch my-feature

# Remote access (optional)
gssh auth login           # Login to gitspace.sh
gssh host reserve myname  # Get myname.gitspace.sh
gssh serve                # Start serving
```

-------------------------
DOCS PAGE (with TOC)
-------------------------

Title: Documentation

Table of Contents (anchor links):
- Overview
- Quick Start
- Installation
- Local Workflow
  - TUI Interface
  - CLI Commands
  - Custom Scripts
  - Repo Config Bundles
- Remote Access
  - gitspace.sh (Managed)
  - Self-Hosted Relay
  - Identity Management
  - Access Control
- Configuration
- Troubleshooting
- Security
- Glossary

---

SECTION: Overview

GitSpace is a CLI tool for managing GitHub repository workspaces using git worktrees, with optional secure remote terminal access.

**Local Development:**
- Work on multiple branches simultaneously without stashing
- Interactive TUI for visual workspace management
- Convention-based scripts for automation
- Team onboarding via repo config bundles

**Remote Access:**
- E2E encrypted terminal access from any browser or CLI
- Zero-trust relay: routes traffic but cannot decrypt content
- Identity-based auth using Ed25519/X25519 cryptographic keys
- Instant hosting via gitspace.sh subdomains

---

SECTION: Quick Start

### 5-Minute Setup with gitspace.sh

```bash
# 1. Install
npm install -g gitspace

# 2. Create identity
gssh identity init

# 3. Login to gitspace.sh
gssh auth login

# 4. Reserve your subdomain
gssh host reserve yourname

# 5. Start serving
gssh serve

# 6. Access from browser: https://yourname.gitspace.sh
```

### Local-Only Quick Start

```bash
# Install
npm install -g gitspace

# Authenticate GitHub
gh auth login

# Launch TUI
spaces

# Or via CLI:
gssh add project    # Add a GitHub repo
gssh add my-feature # Create a workspace
```

---

SECTION: Installation

### Prerequisites

Required:
- [Bun](https://bun.sh) - JavaScript runtime
- [Git](https://git-scm.com/) - Version control
- [GitHub CLI](https://cli.github.com/) - `gh auth login` before using GitSpace
- [jq](https://stedolan.github.io/jq/) - JSON processing

Optional:
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) - For `gssh host` commands

### Install GitSpace

```bash
npm install -g gitspace
gssh --version
```

### Authenticate GitHub CLI

```bash
gh auth login
```

---

SECTION: Local Workflow - TUI Interface

Launch the TUI with no arguments:

```bash
spaces
```

The TUI provides a two-panel interface:
- **Left panel**: Your projects
- **Right panel**: Workspaces in the selected project

**Key Bindings:**
| Key | Action |
|-----|--------|
| `Enter` | Select project / Open workspace |
| `Tab` | Switch between panels |
| `n` | New project / workspace |
| `d` | Delete selected item |
| `?` | Show help |
| `q` | Quit |

---

SECTION: Local Workflow - CLI Commands

### Projects

```bash
gssh add project              # Add from GitHub (interactive)
gssh add project --org myorg  # Filter by organization
gssh switch project myapp     # Switch to a project
gssh list projects            # List all projects
gssh remove project myapp     # Remove a project
```

### Workspaces

```bash
gssh add my-feature           # Create workspace
gssh add --from develop       # Create from specific branch
gssh switch my-feature        # Switch to workspace
gssh switch                   # Interactive selection
gssh list                     # List workspaces
gssh remove workspace my-feature
```

### Other

```bash
gssh directory   # Print current project path
gssh status      # Show daemon statuses
```

---

SECTION: Local Workflow - Custom Scripts

GitSpace uses convention-based scripts stored per workspace in `.gitspace/scripts/`:

```
~/gitspace/<project>/workspaces/<workspace>/.gitspace/
└── scripts/
    ├── pre/      # Run before setup (once)
    ├── setup/    # Run on workspace creation (once)
    ├── select/   # Run every time workspace is opened
    └── remove/   # Run before workspace deletion
```

**Rules:**
- Scripts must be executable (`chmod +x`)
- Run alphabetically (use `01-`, `02-` prefixes)
- Working directory: the workspace
- Arguments: `$1` = workspace name, `$2` = repository

**Example:**
```bash
#!/bin/bash
# .gitspace/scripts/select/01-status.sh
echo "Switching to: $1"
git fetch origin
git status
```

---

SECTION: Local Workflow - Repo Config Bundles

Bundles allow teams to share onboarding configurations. Place in `.gitspace/`:

```
.gitspace/
├── bundle.json           # Manifest
└── scripts/
    ├── pre/              # Pre-setup scripts
    ├── setup/            # Setup scripts
    ├── select/           # Select scripts
    └── remove/           # Remove scripts
```

**Manifest example:**
```json
{
  "version": "1.0",
  "name": "my-app-bundle",
  "onboarding": [
    { "id": "node", "type": "confirm", "title": "Node.js", "checkCommand": "node" },
    { "id": "api-key", "type": "secret", "title": "API Key", "configKey": "apiKey" }
  ]
}
```

**Step types:**
| Type | Purpose | Storage |
|------|---------|---------|
| `info` | Display information | N/A |
| `confirm` | Verify installation | N/A |
| `secret` | Sensitive values | OS Keychain |
| `input` | Plain text | Config file |

**Using values in scripts:**
```bash
echo "Team: $TEAMNAME"
echo "Has API key: $APIKEY"
```

---

SECTION: Remote Access - gitspace.sh (Managed)

The easiest way to get remote access:

```bash
# 1. Create identity
gssh identity init

# 2. Login with GitHub
gssh auth login

# 3. Reserve subdomain
gssh host reserve yourname

# 4. Start serving
gssh serve

# 5. Access: https://yourname.gitspace.sh
```

**Manage subdomains:**
```bash
gssh host list              # List your subdomains
gssh host set-primary name  # Set primary
gssh host release name      # Release subdomain
gssh host status            # Show status
```

---

SECTION: Remote Access - Self-Hosted Relay

For complete control:

**1. Start relay:**
```bash
gssh relay start --port 4480
```

**2. Authorize machine:**
```bash
gssh identity init --label "My Mac"
gssh identity show

# On the relay host
gssh relay authorize gssh-pub:<keys> --label "My Mac"
```

**3. Serve:**
```bash
gssh serve --relay ws://localhost:4480/ws
```

**4. Create invite:**
```bash
gssh share create
# Output: https://gitspace.sh/join#<TOKEN>
```

**5. Connect from client:**
```bash
gssh identity init --label "Laptop"
gssh connect https://gitspace.sh/join#<TOKEN>
```

---

SECTION: Remote Access - Identity Management

Every machine and client has a cryptographic identity:

```bash
gssh identity init [--label <name>] [--force]
gssh identity show [--fingerprint] [--json]
```

Identity storage: `~/gitspace/.identity/`

---

SECTION: Remote Access - Access Control

**Grant access:**
```bash
gssh access add gssh-pub:<keys> --label "Brad's Phone"
```

**Manage access:**
```bash
gssh access list [--json]
gssh access remove "Brad's Phone"
gssh access remove <key-prefix> --force
```

**Connect without invite (pre-authorized):**
```bash
gssh --relay ws://relay.example.com/ws
```

---

SECTION: Configuration

### Global Config

`~/gitspace/.config.json`:
```json
{
  "currentProject": "my-app",
  "projectsDir": "/Users/username/spaces",
  "defaultBaseBranch": "main"
}
```

### Project Config

`~/gitspace/<project>/.config.json`:
```json
{
  "name": "my-app",
  "repository": "myorg/my-app",
  "baseBranch": "main"
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RELAY_PORT` | Relay port | `4480` |
| `SPACES_CURRENT_PROJECT` | Override project | Config |

---

SECTION: Troubleshooting

**"No identity found"**
```bash
gssh identity init --label "My Device"
```

**"Machine offline"**
- Ensure `gssh serve` is running
- Check relay connectivity
- Verify the machine is authorized on the relay

**"Client not authorized"**
- Use an invite: `gssh share create`
- Or add public key: `gssh access add <key>`

**"Invite expired"**
- Create new invite: `gssh share create --expires 7d`

**"GitHub CLI not authenticated"**
```bash
gh auth login
```

---

SECTION: Security

**End-to-end encrypted:** Terminal traffic encrypted with AES-256-GCM. Relay cannot decrypt.

**Cryptographic identity:** Ed25519 signing + X25519 key exchange. No passwords.

**X3DH handshake:** Session keys derived per-connection.

**Current limitations:**
- Client proof-of-possession for identity signing keys is not fully enforced (ACL spoofing risk if attacker learns authorized public key)
- Permission flags not fully enforced server-side after handshake; "view-only" is intended behavior, not strict guarantee

---

SECTION: Glossary

| Term | Definition |
|------|------------|
| Machine | Device running `gssh serve` |
| Client | Device connecting via browser or CLI |
| Relay | WebSocket router (default: `wss://relay.gitspace.sh`) |
| Relay Identity | Ed25519 keypair used by the relay to sign messages and challenges |
| Authorized Machine | Machine public key approved to register with a relay |
| Identity | Ed25519 + X25519 keypairs |
| Invite | Signed token for first connection |
| ACL | Access Control List |
| X3DH | Key exchange handshake |
| Worktree | Git feature for multiple working directories |
| Bundle | Repo onboarding configuration |

============================================================
J) FINAL CHECKLIST
============================================================

Before finishing, verify:

- [ ] Every command uses exact subcommand names (especially `gssh relay start`, `gssh serve`)
- [ ] Defaults match:
  - [ ] Relay port: 4480
  - [ ] Serve relay default: `wss://relay.gitspace.sh`
  - [ ] Share URL: `https://gitspace.sh/join#...`
  - [ ] Share expires default: 24h
- [ ] Security notes are conservative and include "current limitations" callout
- [ ] No mention of non-existent features (dashboards, OAuth flows on relay, etc.)
- [ ] Custom scripts and bundles are documented
- [ ] All troubleshooting items have solutions
- [ ] Glossary includes all key terms

Now apply these changes to the Docs pages in the Figma site.
