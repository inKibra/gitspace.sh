# GitSpace CLI

A powerful CLI tool for managing GitHub repository workspaces using git worktrees and optional Linear integration. Work on multiple features/tasks simultaneously, each in its own isolated workspace. Features an interactive TUI and support for repo config bundles for team onboarding.

## Features

- **Interactive TUI**: Beautiful terminal interface for managing projects and workspaces
- **Git Worktrees**: Work on multiple branches simultaneously without stashing
- **Linear Integration**: Create workspaces directly from Linear issues with automatic markdown documentation
- **Smart Branch Management**: Automatic detection of remote branches
- **Workspace Status**: Track uncommitted changes, stale workspaces, and more
- **Custom Scripts**: Convention-based scripts for setup, select, pre-setup, and removal phases
- **Repo Config Bundles**: Share onboarding configurations with your team, including scripts and setup steps
- **Secure Secrets**: Store sensitive values in OS keychain via Bun.secrets

## Prerequisites

The following tools must be installed and available in your PATH:

- [GitHub CLI (`gh`)](https://cli.github.com/) - for listing repositories
- [Git](https://git-scm.com/) - for worktree management
- [jq](https://stedolan.github.io/jq/) - for JSON processing

**GitHub Authentication**: You must authenticate the GitHub CLI before using GitSpace:

```bash
gh auth login
```

## Installation

```bash
# npm
npm install -g gitspace

# bun
bun install -g gitspace

# pnpm
pnpm install -g gitspace

# yarn
yarn global add gitspace

# Verify installation
gssh --version
```

## Quick Start

### Launch the TUI

Simply run `gssh` with no arguments to launch the interactive TUI:

```bash
gssh
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

### CLI Commands

You can also use traditional CLI commands:

#### 1. Add Your First Project

```bash
gssh add project
```

Select a GitHub repository, and GitSpace will:
- Clone the repository to `~/gitspace/<project-name>/base`
- Detect the default branch
- Run onboarding steps if a bundle is present
- Create project configuration

#### 2. Create a Workspace

```bash
# Create a workspace from a Linear issue (if configured)
gssh add

# Or create a workspace with a custom name
gssh add my-feature
```

#### 3. Switch Between Workspaces

```bash
# Interactive selection
gssh switch

# Switch to a specific workspace
gssh switch my-feature
```

## Repo Config Bundles

Repo config bundles allow repository owners to share onboarding configurations with their team. When someone clones a project that contains a bundle, they'll be guided through setup steps and have scripts automatically installed.

### Bundle Structure

A bundle is a directory (typically `.gitspace/`) containing:

```
.gitspace/
├── bundle.json           # Bundle manifest with onboarding steps
├── pre/                  # Scripts to run before setup
│   └── 01-copy-env.sh
├── setup/                # Scripts to run on first workspace creation
│   └── 01-install-deps.sh
├── select/               # Scripts to run every time workspace is opened
│   └── 01-status.sh
└── remove/               # Scripts to run before workspace deletion
    └── 01-cleanup.sh
```

### Bundle Manifest (`bundle.json`)

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

### Onboarding Step Types

| Type | Purpose | Storage |
|------|---------|---------|
| `info` | Display information | N/A |
| `confirm` | Verify installation (can check command in PATH) | N/A |
| `secret` | Collect sensitive values (masked input) | OS Keychain |
| `input` | Collect plain text values | Project config |

### Using Bundle Values in Scripts

Bundle values are passed to scripts as environment variables:

- `SPACE_VALUE_<KEY>` - Regular values from input steps
- `SPACE_SECRET_<KEY>` - Secret values from secret steps (fetched from OS keychain)

**Example script:**

```bash
#!/bin/bash
# .gitspace/select/01-status.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

# Access bundle values
if [ -n "$SPACE_VALUE_TEAMNAME" ]; then
  echo "Welcome, $SPACE_VALUE_TEAMNAME team!"
fi

# Access secrets (stored securely in OS keychain)
if [ -n "$SPACE_SECRET_APIKEY" ]; then
  echo "API Key configured"
fi
```

### Bundle Sources

Bundles can be loaded from:

1. **In-repo** (automatic): `.gitspace/`, `.gitspace-config/`, `.spaces-config/`, or `.spaces/` in the cloned repository
2. **Local path**: `gssh add project --bundle-path /path/to/bundle/`
3. **Remote URL**: `gssh add project --bundle-url https://example.com/bundle.zip`

## Commands Reference

### `gssh` (TUI)

Launch the interactive terminal UI.

### `gssh add project`

Add a new project from GitHub.

```bash
gssh add project [options]

Options:
  --bundle-url <url>     Load bundle from remote URL (zip archive)
  --bundle-path <path>   Load bundle from local directory
  --skip-bundle          Skip bundle detection and onboarding
  --no-clone             Create project structure without cloning
  --org <org>            Filter repos to specific organization
  --linear-key <key>     Provide Linear API key via flag
```

### `gssh add [workspace-name]`

Create a new workspace in the current project.

```bash
gssh add [workspace-name] [options]

Options:
  --branch <name>        Specify different branch name from workspace name
  --from <branch>        Create from specific branch instead of base
  --no-setup             Skip setup commands
```

### `gssh switch [workspace-name]`

Switch to a workspace in the current project.

```bash
gssh switch [workspace-name]
# Alias: gssh sw
```

### `gssh switch project [project-name]`

Switch to a different project.

### `gssh list [subcommand]`

List projects or workspaces.

```bash
gssh list [subcommand] [options]
# Alias: gssh ls

Subcommands:
  projects               List all projects
  workspaces             List workspaces in current project (default)

Options:
  --json                 Output in JSON format
  --verbose              Show additional details
```

### `gssh remove workspace [workspace-name]`

Remove a workspace.

```bash
gssh remove workspace [workspace-name] [options]
# Alias: gssh rm workspace

Options:
  --force                Skip confirmation prompts
  --keep-branch          Don't delete git branch when removing workspace
```

### `gssh remove project [project-name]`

Remove a project.

```bash
gssh remove project [project-name] [options]
# Alias: gssh rm project

Options:
  --force                Skip confirmation prompts
```

### `gssh directory`

Print the current project directory path.

```bash
gssh directory
# Alias: gssh dir
```

## Configuration

### Global Configuration

Located at `~/gitspace/.config.json`:

```json
{
  "currentProject": "my-app",
  "projectsDir": "/Users/username/gitspace",
  "defaultBaseBranch": "main",
  "staleDays": 30
}
```

### Project Configuration

Located at `~/gitspace/<project-name>/.config.json`:

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

- `bundleValues`: Values collected from input steps during onboarding
- `bundleSecretKeys`: Keys of secrets stored in OS keychain (values are NOT stored in config)
- `appliedBundle`: Information about the bundle that was applied

### Custom Scripts

GitSpace uses **convention over configuration** for custom scripts:

```
~/gitspace/<project-name>/scripts/
├── pre/           # Run before setup (terminal)
├── setup/         # Run once on workspace creation
├── select/        # Run every time workspace is opened
└── remove/        # Run before workspace deletion
```

#### Script Execution Rules

1. Scripts must be **executable** (`chmod +x`)
2. Scripts run **alphabetically** (use `01-`, `02-` prefixes)
3. **Working directory**: The workspace directory
4. **Arguments**: `$1` = workspace name, `$2` = repository name
5. **Environment**: Bundle values available as `SPACE_VALUE_*` and `SPACE_SECRET_*`

#### Script Phases

| Phase | When | Use Case |
|-------|------|----------|
| `pre/` | Once, before setup | Copy .env files, create directories |
| `setup/` | Once, on workspace creation | Install dependencies, initial build |
| `select/` | Every workspace open | Git fetch, status checks |
| `remove/` | Before deletion | Cleanup, notifications |

### Environment Variables

```bash
# Set the current project (overrides global config)
export SPACES_CURRENT_PROJECT="my-app"

# Available in scripts (from bundle onboarding):
# SPACE_VALUE_<KEY>    - Regular values
# SPACE_SECRET_<KEY>   - Secret values (from OS keychain)
```

## Directory Structure

```
~/gitspace/
├── .config.json                 # Global configuration
├── <project-name>/
│   ├── .config.json             # Project configuration
│   ├── base/                    # Base repository clone
│   ├── workspaces/              # Git worktrees
│   │   └── <workspace-name>/
│   │       ├── gitspace.lock    # Setup completion marker
│   │       └── .prompt/         # Linear issue details (if applicable)
│   │           └── issue.md
│   └── scripts/                 # Custom scripts
│       ├── pre/
│       ├── setup/
│       ├── select/
│       └── remove/
```

## Remote Access

GitSpace provides secure remote terminal access with **end-to-end encryption**. Access your terminal sessions from anywhere via web browser or CLI.

### gitspace.sh Platform

The easiest way to get remote access is through [gitspace.sh](https://gitspace.sh):

```bash
# 1. Authenticate with GitHub
gssh auth login

# 2. Reserve your subdomain (e.g., yourname.gitspace.sh)
gssh host reserve yourname

# 3. Start serving (creates identity if needed)
gssh serve

# 4. Access from browser at https://yourname.gitspace.sh
```

### Self-Hosted Setup

For complete control, run your own relay:

```bash
# Terminal 1: Start relay server
gssh relay start --port 4480

# Terminal 2: Initialize identity and start serving
gssh identity init --label "My MacBook"
gssh serve --relay ws://localhost:4480/ws

# Terminal 3: Create invite for remote access
gssh share create

# Share the invite URL with collaborators
```

### Identity Management

Every machine and client has a cryptographic identity (Ed25519 + X25519 keypair):

```bash
# Create machine identity (stored in ~/gitspace/.identity/)
gssh identity init --label "My MacBook"

# View identity fingerprint
gssh identity show
```

### Access Control

Control who can connect to your machine:

```bash
# List authorized clients
gssh access list

# Add a client by public key
gssh access add spcs_pk_abc123... --label "Work Laptop"

# Remove client access
gssh access remove spcs_pk_abc123...
```

### Creating Invites

Share access via signed invite tokens:

```bash
# Create invite (24h default)
gssh share create

# Custom expiration
gssh share create --expires 7d
```

### Connecting Remotely

```bash
# Connect using invite token
gssh connect <invite-token>

# Connect via TUI with relay
gssh --relay wss://relay.example.com
```

### Remote Access Commands

| Command | Description |
|---------|-------------|
| `gssh auth login` | Authenticate with gitspace.sh (GitHub OAuth) |
| `gssh auth logout` | Sign out of gitspace.sh |
| `gssh host reserve <name>` | Reserve a subdomain on gitspace.sh |
| `gssh host status` | Show hosting status |
| `gssh identity init` | Create machine/client identity |
| `gssh identity show` | Display identity fingerprint |
| `gssh access add <key>` | Authorize a client |
| `gssh access list` | List authorized clients |
| `gssh access remove <key>` | Revoke client access |
| `gssh serve` | Start machine daemon |
| `gssh serve start` | Start serve as background daemon |
| `gssh serve stop` | Stop background serve daemon |
| `gssh share create` | Create invite token |
| `gssh connect <token>` | Connect to remote machine |
| `gssh status` | Show all daemon statuses |

### Relay Server Commands

For self-hosted relay servers:

| Command | Description |
|---------|-------------|
| `gssh relay start` | Start relay server |
| `gssh relay authorize <key>` | Authorize a machine |
| `gssh relay revoke <key>` | Revoke machine authorization |
| `gssh relay machines` | List registered machines |
| `gssh relay trusted` | List trusted relays |
| `gssh relay untrust <url>` | Remove relay trust |

### Terminal Multiplexer (tmux-lite)

Manage terminal sessions:

| Command | Description |
|---------|-------------|
| `gssh tmux start` | Start tmux-lite daemon |
| `gssh tmux stop` | Stop tmux-lite daemon |
| `gssh tmux list` | List sessions |
| `gssh tmux attach <id>` | Attach to session |
| `gssh tmux new` | Create new session |
| `gssh tmux kill <id>` | Kill session |

### Environment Variables

```bash
# Relay server
RELAY_PORT=4480              # Default relay port
RELAY_BIND=0.0.0.0           # Bind address

# Machine identity
GSSH_IDENTITY_PATH=~/gitspace/.identity/  # Identity storage

# gitspace.sh
GITSPACE_API_URL=https://api.gitspace.sh   # API endpoint
```

### Security Model

- **E2E Encryption**: All terminal I/O encrypted with AES-256-GCM
- **X3DH Handshake**: Forward-secret session key establishment
- **Ed25519 Signatures**: Cryptographic identity verification
- **Zero-knowledge Relay**: Relay cannot decrypt terminal content

See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for detailed setup and [docs/REMOTE-DESIGN.md](docs/REMOTE-DESIGN.md) for architecture.

## Troubleshooting

### GitHub CLI not authenticated

```
Error: GitHub CLI is not authenticated
```

**Solution:** Run `gh auth login` and follow the prompts.

### Missing dependencies

**Solution:** Install the missing dependencies using the provided URLs in the error message.

### Bundle secrets not available

If `SPACE_SECRET_*` variables are empty, ensure:
1. You completed the onboarding secret steps
2. Your OS keychain service is running (libsecret on Linux, Keychain on macOS)

## Development

```bash
# Install dependencies
bun install

# Development mode
bun run dev

# Type checking
bun run typecheck

# Run linter
bun run lint
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
