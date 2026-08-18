# GitSpace CLI

GitSpace manages GitHub repository workspaces as git worktrees, so you can work on
several branches at once, each in its own isolated directory.

You run a few commands to set it up, then you work in the web app. `gssh web` starts
the local relay and machine daemon on this machine and opens the browser. The CLI is
there for setup, scripting, and anything you want to automate.

Full documentation: <https://gitspace.sh/docs>

## Features

- **Web app**: The interactive surface, started with `gssh web`
- **Git Worktrees**: Work on multiple branches simultaneously without stashing
- **Linear Integration**: Create workspaces directly from Linear issues with automatic markdown documentation
- **Smart Branch Management**: Automatic detection of remote branches
- **Workspace Status**: Track uncommitted changes, stale workspaces, and more
- **Custom Scripts**: Convention-based scripts for setup, select, pre-setup, and removal phases
- **Repo Config Bundles**: Share onboarding configurations with your team, including scripts and setup steps
- **Secure Secrets**: Store sensitive values in OS keychain via Bun.secrets

## Prerequisites

- [Git](https://git-scm.com/) - required. GitSpace checks for it and stops if it is missing.
- [GitHub CLI (`gh`)](https://cli.github.com/) - only needed to discover and clone GitHub
  repositories. Without it you can still add a project from a git remote URL.

**GitHub Authentication**: Authenticate the GitHub CLI before adding a project from GitHub:

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

### Open the web app

`gssh web` is how you start GitSpace. It needs two identities first, both one-time
setup:

```bash
# 1. Create your user root identity (generates a 24-word mnemonic).
#    On a second machine, use `gssh user identity recover` instead.
gssh user identity init

# 2. Create the local device identity for this machine.
#    `gssh user auth login` prompts for it as part of GitHub login.
gssh user auth login

# 3. Start the local relay and machine daemon, and open the browser
gssh web
```

`gssh web` starts a local relay on port 4480 (change it with `--port`), starts
`machine serve` against that relay, registers a one-time browser enrollment, and
opens the browser at that enrollment URL. Press Ctrl+C to stop the stack.

If a local relay is already running on that port and is bound to your user root
identity, `gssh web` reuses it instead of starting a second one. The same is true
for the machine daemon: if it is already serving the same relay URL, `gssh web`
reuses it. It stops with an error if the running relay is on a different port, is
bound to a different identity, or is a hosted relay.

`gssh web` checks for the two identities above and nothing else. It does not check
gitspace.sh authentication. The GitHub login half of `gssh user auth login` only
matters if you later want a gitspace.sh subdomain, which is what `gssh web --relay`
uses to serve the same app over `https://<name>.gitspace.sh` through a cloudflared
tunnel. See [Remote Access](#remote-access).

If you are running from a source checkout rather than an installed package, build the
web assets first or `gssh web` has nothing to serve:

```bash
bun run build:web
```


### Setup commands

Projects and workspaces can be created from the CLI:

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
- Inside a workspace session (`GSSH_SESSION_MODE=workspace`), `gssh` accepts only
  `gssh space ...`, `gssh help`, `-h`/`--help`, and `-V`/`--version`. Everything
  else exits with an error.

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
| `select` | Choose one value from a fixed list of options | Project config |

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

Run `gssh` with no arguments to print help. Every command's options are available
from `gssh <command> --help`.

The workspace-scoped `gssh space` commands are not listed in the root help output.
Run `gssh space --help` to see them.

### `gssh web`

Start the local relay and machine serve stack and open the web app.

```bash
gssh web [options]

Options:
  --port <port>     Local relay/web port (default: 4480)
  --relay           Start a hosted relay with cloudflared tunnel to your
                    gitspace.sh subdomain
  -y, --yes         Auto-confirm prompts
  --takeover        Reclaim the local relay and serve daemons for the current
                    identity
  --password-stdin  Read the local device identity password from stdin
```

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
  --status <phase>       Kanban phase: plan, code, review, ship (default: code)
  --issue <number>       Import a GitHub issue: name the workspace after it and
                         seed its goal
  --no-setup             Skip setup commands
```

### `gssh workspace context --project <project-name> --workspace <workspace-name>`

Show the resolved workspace context.

```bash
gssh workspace context --project <project-name> --workspace <workspace-name> [options]

Options:
  --json                 Output structured JSON
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
  "createdAt": "2025-01-01T00:00:00Z",
  "lastAccessed": "2025-01-01T00:00:00Z",
  "linearTeams": ["ENG"],
  "bundleValues": {
    "teamName": "engineering"
  },
  "bundleSecretKeys": ["apiKey"]
}
```

- `linearTeams`: Linear team keys this project uses
- `bundleValues`: Values collected from input and select steps during onboarding
- `bundleSecretKeys`: Keys of secrets stored in OS keychain (values are NOT stored in config)

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
# 1. Create your user root identity on your control host
gssh user identity init
gssh user identity show

# 2. Authenticate with gitspace.sh
gssh user auth login

# 3. Reserve your subdomain (e.g., yourname.gitspace.sh)
gssh user host reserve yourname
gssh user host status

# 4. Start the hosted web stack (relay + tunnel + serve) and open the browser
gssh web --relay

# 5. Check status any time
gssh status
```

`gssh web --relay` requires `cloudflared` on your PATH and a reserved subdomain, and
it starts its own relay, so stop any running relay with `gssh relay stop` first. It
serves the same web app at `https://yourname.gitspace.sh`.

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

`gssh relay start` always keeps the relay reachable locally. If account hosting is configured,
`auto` and `hosted` modes add a `*.gitspace.sh` tunnel on top of the same local relay instead of
replacing loopback access.

### Identity Management

Every machine and client has a cryptographic identity (Ed25519 + X25519 keypair):

```bash
# Create your user root identity (generates a 24-word mnemonic)
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
| `gssh web` | Start the local relay + serve stack and open the web app |
| `gssh machine serve start` | Start serve as background daemon |
| `gssh machine serve start --foreground` | Run the serve daemon in the foreground |
| `gssh machine serve stop` | Stop background serve daemon |
| `gssh machine serve status` | Show serve daemon status |
| `gssh cloud status` | Show cloud control status for the running serve daemon |
| `gssh cloud list` | List cloud workspaces from the control relay store |
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
| `gssh relay status` | Show relay server status |
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
| `gssh machine tmux new [name]` | Create and attach to a new session |
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

# Run the CLI from source
bun run dev

# Build the web UI assets (gssh web requires them)
bun run build:web

# Type checking
bun run typecheck

# Run linter
bun run lint

# Tests (runs each test file in its own process)
bun run test
```

## Documentation

Full documentation is at <https://gitspace.sh/docs>.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
