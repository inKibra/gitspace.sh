# GitSpace Quick Start Guide

Get up and running with GitSpace in 5 minutes.

You do not drive GitSpace from the terminal. You run a few setup commands once,
start `gssh web`, and then work in the web app.

---

## Prerequisites

- [Git](https://git-scm.com/) - required
- [GitHub CLI](https://cli.github.com/) - optional, used to discover GitHub repos
  when adding a project. Run `gh auth login` first if you want that.

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

## Part 1: Start the app

```bash
# 1. Create your user root identity (24-word mnemonic, write it down)
gssh user identity init

# 2. Create a local device identity (this is the command `gssh web` names)
gssh user auth login

# 3. Start the web stack and open the browser
gssh web
```

`gssh web` starts a local relay, starts machine serve, registers a one-time browser
enrollment, and opens your browser at `http://127.0.0.1:4480/?enroll=<token>`. If a
local relay or a serving daemon is already running for your identity on that port, it
reuses them instead of starting new ones. Press Ctrl+C to stop what it started.

It refuses to start without both a user root identity and a local device identity,
and names those two commands when it does. It does not check gitspace.sh login.
GitHub login only matters later, if you want a public subdomain.

`gssh user auth login` signs in to gitspace.sh with GitHub and creates the local
device identity on the way through, prompting for a password to encrypt it. Any
other command that needs the device identity will offer to create it too.

Useful flags:

| Flag | Effect |
|------|--------|
| `--port <port>` | Local relay/web port (default `4480`) |
| `--relay` | Start a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain |
| `--takeover` | Reclaim local relay and serve daemons for the current identity |

From here on, everything below is optional. Projects, workspaces, terminals, and
agent sessions are all in the app.

---

## Part 2: Projects and workspaces from the CLI

The same operations exist as commands if you want them scripted.

### Add a project

```bash
gssh project add
# Select a GitHub repo from the list
```

### Create a workspace

```bash
gssh workspace add my-feature --project my-project
```

### Inspect workspaces

```bash
gssh workspace list --project my-project
gssh workspace context --project my-project --workspace my-feature
```

There is also `gssh space`, a workspace-scoped command group (`context`, `review`,
`goal`, `chain`, `stack`, `notes`, `service`, `hosting`, `events`, `bundle`,
`journal`, `guide`, `artifacts`, `workflow`). Run `gssh space --help` for the list.

---

## Part 3: Reach the app from another device

`gssh web` alone is local only. To reach it from elsewhere you need a relay that
both ends can see.

### Option A: gitspace.sh

```bash
# 1. Sign in with GitHub
gssh user auth login

# 2. Reserve your subdomain
gssh user host reserve yourname

# 3. Start the web stack behind a hosted relay
gssh web --relay

# 4. Open https://yourname.gitspace.sh
```

`gssh web --relay` requires `cloudflared` on your PATH and a reserved subdomain. It
also has to start its own relay, so stop any relay that is already running first with
`gssh relay stop`.

### Option B: Self-hosted relay

Run your own relay and point machines at it:

```bash
# On the relay host
gssh relay start --port 4480

# On each machine that should be reachable
gssh machine serve start --relay ws://<relay-host>:4480/ws
```

`gssh relay start` defaults to `--mode auto`, which is always reachable locally and
also attaches gitspace.sh hosting when that is available. `--mode local` keeps it
local only. `gssh relay stop` stops it.

To let someone else's machine register on your relay, create an invite for it. The
two key values are that machine's Ed25519 signing public key and X25519 key exchange
public key:

```bash
gssh invite relay-machine create --relay ws://localhost:4480/ws \
  --machine-signing-key <BASE64_ED25519_PUB> \
  --machine-key-exchange-key <BASE64_X25519_PUB> \
  --label "Their Mac"
```

The invite defaults to `--expires 24h` and `--max-uses 1`. It prints the invite token
and the exact `gssh machine enroll --invite "<token>"` command to run on that machine.
`gssh invite list` and `gssh invite revoke <invite-id>` manage them afterwards.

### Connect from a terminal on another device

The web app is the normal way in. There is also a terminal client:

```bash
# Recover the same owner identity there (24-word mnemonic)
gssh user identity recover

# See which machines you can reach, then connect as owner
gssh client machines list --relay <relay-url>
gssh client connect <machine-id>
```

---

## Common Commands

| Command | Description |
|---------|-------------|
| `gssh web` | Start the local relay + serve web stack and open the browser |
| `gssh project add` | Add GitHub project |
| `gssh workspace add <name> --project <project-name>` | Create workspace |
| `gssh workspace list --project <project-name>` | List workspaces |
| `gssh workspace context --project <project-name> --workspace <name>` | Show workspace context |
| `gssh machine serve status` | Show serve daemon status |
| `gssh status` | Show status of all gitspace daemons |

`gssh` with no arguments prints help. There is no TUI.

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

### "GitHub CLI is not authenticated"

```bash
gh auth login
```

### "User root identity is required for `gssh web`"

```bash
gssh user identity init
# or, on a second machine
gssh user identity recover
```

### "Local device identity is required for `gssh web`"

```bash
gssh user auth login
```

### "Web UI assets not found"

You are running from a source checkout. Build them:

```bash
bun run build:web
```

### "Machine offline"

Make sure the target machine is actually serving. Either `gssh web` is running
there, or check the daemon directly:

```bash
gssh machine serve status
gssh status
```

---

*Last updated: 2026-08*
