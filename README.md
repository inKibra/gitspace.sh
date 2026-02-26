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
gssh project add
```

Select a GitHub repository, and GitSpace will:
- Clone the repository to `~/gitspace/<project-name>/base`
- Detect the default branch
- Run onboarding steps if a bundle is present
- Create project configuration

#### 2. Create a Workspace

```bash
# Create a workspace from a Linear issue (if configured)
gssh workspace add --project my-project

# Or create a workspace with a custom name
gssh workspace add my-feature --project my-project
```

#### 3. Target a Workspace

```bash
# List workspaces in a project
gssh workspace list --project <project-name>

# Show context for a specific workspace
gssh workspace context --project my-project --workspace my-feature
```

### Workspace Session Mode (`space`)

When GitSpace opens a workspace-scoped terminal session, it injects a `space` shell function (bash/zsh).

- Use `space ...` for workspace operations without repeating `--project` and `--workspace`
- `gssh` commands are restricted in this mode to avoid cross-workspace mistakes
- `gssh machine tmux ...` is blocked inside workspace sessions

Examples:

```bash
space context --json
space review hunks src/app.ts --format json
space review add-hunk src/app.ts --index 1 --approve --body "Looks good"
```

## Repo Config Bundles

Repo config bundles allow repository owners to share onboarding configurations with their team. When someone clones a project that contains a bundle, they'll be guided through setup steps and have scripts automatically installed.

### Bundle Structure

A bundle is a directory (typically `.gitspace/`) containing:

```
.gitspace/
├── bundle.json           # Bundle manifest with onboarding steps
└── scripts/
    ├── pre/              # Deprecated: migrate scripts into ordered setup/
    │   └── 01-copy-env.sh
    ├── setup/            # Scripts for setup runs (when bundle/value state changes)
    │   └── 01-install-deps.sh
    ├── select/           # Scripts to run on each new terminal attach
    │   └── 01-status.sh
    └── remove/           # Scripts to run before workspace deletion
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

Bundle values are passed to scripts as environment variables using the configured bundle keys:

- `<KEY>` - Regular or secret value using the exact `configKey` from `bundle.json`
- `<NORMALIZED_KEY>` - Uppercase snake-case alias (for example, `teamName` -> `TEAM_NAME`)

**Example script:**

```bash
#!/bin/bash
# .gitspace/scripts/select/01-status.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

# Access bundle values
if [ -n "$TEAM_NAME" ]; then
  echo "Welcome, $TEAM_NAME team!"
fi

# Access secrets (stored securely in OS keychain)
if [ -n "$API_KEY" ]; then
  echo "API Key configured"
fi
```

### Bundle Sources

Bundles can be loaded from:

1. **In-repo** (automatic): `.gitspace/` directory in the cloned repository
2. **Local path**: `gssh project add --bundle-path /path/to/bundle/`
3. **Remote URL**: `gssh project add --bundle-url https://example.com/bundle.zip`

## Commands Reference

### `gssh` (TUI)

Launch the interactive terminal UI.

### `gssh project add`

Add a new project from GitHub.

```bash
gssh project add [options]

Options:
  --bundle-url <url>     Load bundle from remote URL (zip archive)
  --bundle-path <path>   Load bundle from local directory
  --skip-bundle          Skip bundle detection and onboarding
  --no-clone             Create project structure without cloning
  --org <org>            Filter repos to specific organization
  --linear-key <key>     Provide Linear API key via flag
```

### `gssh workspace add [workspace-name] --project <project-name>`

Create a new workspace in the current project.

```bash
gssh workspace add [workspace-name] --project <project-name> [options]

Options:
  --branch <name>        Specify different branch name from workspace name
  --from <branch>        Create from specific branch instead of base
  --no-setup             Skip setup commands
```

### `gssh workspace context --project <project-name> --workspace <workspace-name>`

Show the resolved workspace context.

```bash
gssh workspace context --project <project-name> --workspace <workspace-name>
```

Use `--project` on workspace commands to target a project.

### `gssh project list` / `gssh workspace list --project <project-name>`

List projects or workspaces.

```bash
gssh project list [options]
gssh workspace list --project <project-name> [options]

Options:
  --json                 Output in JSON format
  --verbose              Show additional details
```

### `gssh workspace remove [workspace-name] --project <project-name>`

Remove a workspace.

```bash
gssh workspace remove [workspace-name] --project <project-name> [options]

Options:
  --force                Skip confirmation prompts
  --keep-branch          Don't delete git branch when removing workspace
```

### `gssh project remove [project-name]`

Remove a project.

```bash
gssh project remove [project-name] [options]

Options:
  --force                Skip confirmation prompts
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

GitSpace uses **convention over configuration** for custom scripts. Scripts live
inside each workspace so they can vary by branch:

```
~/gitspace/<project-name>/workspaces/<workspace-name>/.gitspace/
└── scripts/
    ├── pre/       # Deprecated: run before setup (migrate to setup/)
    ├── setup/     # Run when setup state requires refresh
    ├── select/    # Run on each new terminal attach
    └── remove/    # Run before workspace deletion
```

#### Script Execution Rules

1. Scripts must be **executable** (`chmod +x`)
2. Scripts run **alphabetically** (use `01-`, `02-` prefixes)
3. **Working directory**: The workspace directory
4. **Arguments**: `$1` = workspace name, `$2` = repository name
5. **Environment**: Bundle values available by key name (for example `REGION`, `PULUMI_ACCESS_TOKEN`)

#### Script Phases

| Phase | When | Use Case |
|-------|------|----------|
| `pre/` | Deprecated | Move scripts into ordered `setup/` files |
| `setup/` | When setup state changes | Install dependencies, initial build |
| `select/` | Every new terminal attach | Git fetch, status checks |
| `remove/` | Before deletion | Cleanup, notifications |

### Environment Variables

```bash
# Available in scripts (from bundle onboarding):
# <KEY>                - Value by exact bundle config key name
# <NORMALIZED_KEY>     - Uppercase snake-case alias (e.g. teamName -> TEAM_NAME)
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

## Remote Access

GitSpace provides secure remote terminal access with **end-to-end encryption**. Access your terminal sessions from anywhere via web browser or CLI.

### gitspace.sh Platform

The easiest way to get remote access is through [gitspace.sh](https://gitspace.sh):

```bash
# 1. Initialize machine identity on your control host
gssh user identity init
gssh user identity show

# 2. Authenticate with gitspace.sh
gssh user auth login

# 3. Reserve your subdomain (e.g., yourname.gitspace.sh)
gssh user host reserve yourname
gssh user host status

# 4. Start serving
gssh machine serve start
gssh machine serve status
gssh status

# 5. Access from browser at https://yourname.gitspace.sh
```

In hosted mode, this machine is your control node (owner): it runs the relay path, maintains access state, and is the place cloud-control state/secrets are managed.

### Self-Hosted Setup

For complete control, run your own relay:

```bash
# Terminal 1: Start relay server
gssh relay start --port 4480

# Terminal 2: Create relay-machine invite token
gssh invite relay-machine create --relay ws://localhost:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --label "My MacBook"

# Terminal 3: Initialize identity, enroll, and start serving
gssh user identity init
gssh machine enroll --invite "ws://localhost:4480/ws#<TOKEN>" --label "My MacBook"
gssh machine serve start
```

When `--relay` is omitted, `gssh machine serve start` lets you choose from:
- local relay (`ws://127.0.0.1:4480/ws`) if running
- account relays (`*.gitspace.sh`) discovered from your host config/account

### Identity Management

Every machine and client has a cryptographic identity (Ed25519 + X25519 keypair):

```bash
# Create machine identity (stored in OS keychain)
gssh user identity init

# View identity fingerprint
gssh user identity show
```

### Owner Access Model

Remote access is owner-only at runtime.

- Clients and machines must present device certificates derived from the same owner user root identity.
- There is no collaborator ACL grant path for relay or machine access.

### Creating Invites

Use root-signed invites for machine enrollment only:

```bash
# Create machine enrollment invite token
gssh invite relay-machine create --relay ws://localhost:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB>

# List/revoke enrollment invites
gssh invite list --relay ws://localhost:4480/ws
gssh invite revoke <invite-id> --relay ws://localhost:4480/ws
```

### Connecting Remotely

```bash
# On another owner device: recover the same user root identity
gssh user identity recover

# Connect directly as owner
gssh client connect <machine-id>

# Browse machines on a relay
gssh client machines list --relay wss://relay.example.com
```

### Remote Access Commands

| Command | Description |
|---------|-------------|
| `gssh user auth login` | Authenticate with gitspace.sh (GitHub OAuth) |
| `gssh user auth logout` | Sign out of gitspace.sh |
| `gssh user host reserve <name>` | Reserve a subdomain on gitspace.sh |
| `gssh user host status` | Show hosting status |
| `gssh user identity init` | Create user root identity |
| `gssh user identity recover` | Recover identity from mnemonic |
| `gssh user identity show` | Display identity fingerprint |
| `gssh machine serve start --foreground` | Start machine daemon |
| `gssh machine serve start` | Start serve as background daemon |
| `gssh machine serve stop` | Stop background serve daemon |
| `gssh cloud status` | Show cloud control status on current control node |
| `gssh cloud list` | List cloud workspaces from control store |
| `gssh invite relay-machine create --relay <url> --machine-signing-key <k> --machine-key-exchange-key <k>` | Create machine enrollment invite |
| `gssh invite list --relay <url>` | List root-signed invites |
| `gssh invite revoke <invite-id> --relay <url>` | Revoke root-signed invite |
| `gssh client connect <target>` | Connect to remote machine |
| `gssh client machines list --relay <url>` | List accessible remote machines |
| `gssh status` | Show all daemon statuses |

### Relay Server Commands

For self-hosted relay servers:

| Command | Description |
|---------|-------------|
| `gssh relay start` | Start relay server |
| `gssh relay stop` | Stop relay server |
| `gssh invite relay-machine create --relay <url> --machine-signing-key <k> --machine-key-exchange-key <k>` | Create machine enrollment invite |
| `gssh relay machines list` | List registered machines |
| `gssh relay machines revoke <machine-id>` | Revoke machine registration |

### Terminal Multiplexer (tmux-lite)

Manage terminal sessions:

| Command | Description |
|---------|-------------|
| `gssh machine tmux start` | Start tmux-lite daemon |
| `gssh machine tmux stop` | Stop tmux-lite daemon |
| `gssh machine tmux list` | List sessions |
| `gssh machine tmux attach <id>` | Attach to session |
| `gssh machine tmux new` | Create new session |
| `gssh machine tmux kill <id>` | Kill session |

### Environment Variables

```bash
# Relay server
RELAY_PORT=4480              # Default relay port
RELAY_BIND=0.0.0.0           # Bind address

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

If expected bundle key environment variables are empty, ensure:
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
