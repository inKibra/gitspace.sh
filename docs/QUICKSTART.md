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
gssh add project
# Select a GitHub repo from the list
```

### Create a Workspace

```bash
# In a project directory
gssh add my-feature
```

### Switch Workspaces

```bash
gssh switch my-feature
# Or just: gssh switch (interactive)
```

---

## Part 2: Remote Terminal Access

### Option A: gitspace.sh (Easiest)

```bash
# 1. Sign in with GitHub
gssh auth login

# 2. Reserve your subdomain
gssh host reserve yourname

# 3. Start serving
gssh serve

# 4. Open https://yourname.gitspace.sh in browser
```

### Option B: Self-Hosted

```bash
# Terminal 1: Start relay
gssh relay start --port 4480

# Terminal 2: Setup identity and serve
gssh identity init --label "My Mac"
gssh serve --relay ws://localhost:4480/ws

# Terminal 3: Create invite
gssh share create
# Share the URL with collaborators
```

### Connect from Another Device

```bash
# First time: create identity
gssh identity init --label "Laptop"

# Connect using invite
gssh connect <invite-token>
```

---

## Common Commands

| Command | Description |
|---------|-------------|
| `gssh` | Launch TUI |
| `gssh add project` | Add GitHub project |
| `gssh add <name>` | Create workspace |
| `gssh switch` | Switch workspace |
| `gssh list` | List workspaces |
| `gssh serve` | Enable remote access |
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
gssh identity init --label "My Device"
```

### "Machine offline"

Ensure `gssh serve` is running on the target machine.

---

*Last updated: 2025-01*
