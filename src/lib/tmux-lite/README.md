# tmux-lite

A minimal tmux-like terminal multiplexer built with Bun's PTY API.

## Quick Start

```bash
# Create alias (add to your shell rc)
alias tl="bun run $(pwd)/cli.ts"

# Or run directly
bun run cli.ts <command>
```

## Commands

```bash
tl new [name]     # Create new session
tl attach [id]    # Attach to session (shows picker if no id)
tl list           # List all sessions
tl kill <id>      # Kill a session
tl kill-server    # Stop the server
```

## Usage

```bash
# Start a new session
tl new dev

# List sessions
tl list
# Sessions:
#   ● 0: dev (2m) /Users/you/project

# Detach with Ctrl+D
# [detached]

# Reattach
tl attach 0
# or just
tl a

# Kill session
tl kill 0
```

## Key Bindings

| Key | Action |
|-----|--------|
| Ctrl+D | Detach from session (session keeps running) |

## Architecture

```
┌─────────────────────────────────────────┐
│            tmux-lite server             │
│  /tmp/tmux-lite.sock (control)          │
│                                         │
│  Sessions:                              │
│  ├─ 0: dev    → /tmp/tmux-lite-0.sock  │
│  ├─ 1: build  → /tmp/tmux-lite-1.sock  │
│  └─ 2: test   → /tmp/tmux-lite-2.sock  │
└─────────────────────────────────────────┘
           ▲
           │ Unix socket (~9µs latency)
           ▼
┌─────────────────────────────────────────┐
│              tl (client)                │
└─────────────────────────────────────────┘
```

## Features

- ✅ Persistent sessions (survive terminal close)
- ✅ Detach/reattach
- ✅ Scrollback buffer (100KB)
- ✅ Terminal resize handling
- ✅ Session takeover with confirmation
- ✅ Auto-start server on first command
