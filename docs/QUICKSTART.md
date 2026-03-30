# GitSpace Quick Start Guide

Get up and running with GitSpace in 5 minutes.

---

## Prerequisites

Install these tools first:

- [Git](https://git-scm.com/) - Version control
- [GitHub CLI](https://cli.github.com/) - `gh auth login` before using GitSpace

---

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

# Verify
gssh --version
```

---

## Part 1: Local Workspace Management

### Launch the TUI

```bash
gssh
```

Use arrow keys to navigate, `Enter` to select, `?` for help, `q` to quit.

### Add a Project (CLI)

```bash
gssh project add
# Select a GitHub repo from the list
```

### Create a Workspace

```bash
# In a project directory
gssh workspace add my-feature --project my-project
```

### Switch Workspaces

```bash
gssh workspace context --project my-project --workspace my-feature
# Or list available workspaces first:
# gssh workspace list --project <project-name>
```

---

## Part 2: Remote Terminal Access

### Option A: gitspace.sh (Easiest)

```bash
# 1. Sign in with GitHub
gssh user auth login

# 2. Reserve your subdomain
gssh user host reserve yourname

# 3. Start serving
gssh machine serve start --foreground

# 4. Open https://yourname.gitspace.sh in browser
```

### Option B: Self-Hosted

```bash
# Terminal 1: Start relay
gssh relay start --port 4480

# Terminal 2: Create relay-machine invite token on relay host
gssh invite relay-machine create --relay ws://localhost:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --label "My Mac"

# Terminal 3: Setup identity, enroll, and serve
gssh user identity init
gssh machine enroll --invite "ws://localhost:4480/ws#<TOKEN>" --label "My Mac"
gssh machine serve start --relay ws://localhost:4480/ws
```

`gssh relay start` always exposes the relay locally at `ws://127.0.0.1:4480/ws`. If you also have
gitspace.sh hosting configured, `auto` and `hosted` modes add the remote tunnel without disabling
same-machine access.

### Connect from Another Device

```bash
# Recover the same owner identity
gssh user identity recover

# Connect as owner
gssh client connect <machine-id>
```

---

## Common Commands

| Command | Description |
|---------|-------------|
| `gssh` | Launch TUI |
| `gssh project add` | Add GitHub project |
| `gssh workspace add <name> --project <project-name>` | Create workspace |
| `gssh workspace context --project <project-name> --workspace <name>` | Show workspace context |
| `gssh workspace list --project <project-name>` | List workspaces |
| `gssh machine serve start --foreground` | Enable remote access |
| `gssh status` | Check daemon status |

---

## Key Bindings (TUI)

| Key | Action |
|-----|--------|
| `Enter` | Select/Open |
| `Tab` | Switch panels |
| `n` | New item |
| `d` | Delete |
| `?` | Help |
| `q` | Quit |

---

## Directory Structure

Default workspace root:

```
~/gitspace/
├── .config.json           # Global config
├── <project>/
│   ├── base/              # Base repo clone
│   └── workspaces/        # Your worktrees
│       └── my-feature/
```

---

## Next Steps

- **Remote access in depth**: [docs/GETTING-STARTED.md](GETTING-STARTED.md)
- **Security architecture**: [docs/REMOTE-DESIGN.md](REMOTE-DESIGN.md)
- **Protocol reference**: [docs/PROTOCOL.md](PROTOCOL.md)
- **Full README**: [README.md](../README.md)

---

## Troubleshooting

### "GitHub CLI not authenticated"

```bash
gh auth login
```

### "No identity found"

```bash
gssh user identity init
```

### "Machine offline"

Ensure `gssh machine serve start --foreground` is running on the target machine.

---

*Last updated: 2025-01*
