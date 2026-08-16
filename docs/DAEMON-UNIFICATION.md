# Daemon unification — one machine daemon

Status: ACCEPTED direction (2026-07). Prerequisite for artifact-protocol
Phase 5 (share links). Supersedes the serve/tmux-lite two-process split.

## Why

- **The split is accidental, not architectural.** serve already owns
  tmux-lite's lifecycle — it spawns the server as a grandchild
  (`scripts/dev.ts:231` documents this) and then talks to it over the unix
  socket like any client (`session-handler.ts` imports `send` from
  `cli.ts`). Two processes, one owner, an IPC hop to itself.
- **Key material and capabilities live on opposite sides.** The machine
  signing key is password-decrypted ONLY in serve's memory
  (`serve.ts:938`); artifacts, mounts, agent sessions, and the trigger
  scheduler live ONLY in the tmux-lite process. Artifact-protocol Phase 5
  (share links signed with the machine key, bytes served from mounts)
  lands cleanly in one process and awkwardly across two.
- **The double-transport tax.** Every machine feature threads BOTH the
  tmux socket protocol and the remote-session protocol plus the
  serve-side forwarding shim. We paid this five times in one week
  (artifacts ×2, triggers, status, provisioning).
- **Lifecycle pain is user-visible.** Two daemons to start/stop/restart
  ("restart the tmux-lite daemon, not just dev:web"), two PID files, two
  status sockets — and the tmux server's stdio is DISCARDED
  (`cli.ts:205-210`, `:1542-1547`), so the process that owns PTYs, agents,
  and artifacts logs to /dev/null in production.

## Scouted facts this design rests on

- serve → tmux commands: `session-handler.handleTypedCommand` →
  `sendBoundedTmuxCommand` → `send()` (cli.ts:317) over the unix socket;
  agent state via `watchAgentState` (same socket).
- The tmux server is spawned lazily by ANY local client when the socket is
  missing (cli.ts spawn sites) — **passwordless local mode is load-bearing**
  (TUI/CLI work with no identity at all).
- serve refuses to run without the decrypted identity (interactive
  password / stdin / keychain), then holds the 32-byte signing seed in
  memory and connects to the relay (Ed25519 challenge-response; the relay
  pins the machine's pubkey in its registry).
- The machine↔relay WS handles only: relay_identity, registered,
  client_connected/disconnected, data, error, pong. All client traffic is
  E2E inside `data` frames, handled by `ClientSessionManager` +
  `SessionHandler` (both plain modules instantiated in the serve process).
- server.ts is a top-level script (~4.3k lines) with its own signal
  handlers (`process.on(signal)` → cleanup → exit) — in-process boot works
  via import; shutdown must be coordinated once serve duties move in.

## Target: one daemon, activation model

**The tmux-lite server process absorbs serve** (not the other way around),
because lazy, passwordless local spawn must keep working, and the PTY/agent
state is the stateful heart nobody wants restarted.

```
gssh (any local client) ── lazily spawns ──► machine daemon (tmux-lite core)
                                              │  PTYs · agents · artifacts ·
                                              │  triggers · snapshot · hooks
gssh machine serve start ── unlock+activate ─►│  + serve runtime (ACTIVATED):
  (thin client: password prompt,              │    machine-relay-client WS
   sends key over the 0600 unix socket —      │    ClientSessionManager/E2E
   same-user, same trust domain as the        │    hosting supervisor
   key file itself)                           │    status/identity surface
```

- **Local mode (default)**: daemon runs with zero identity — everything
  local works exactly as today.
- **Activation**: new socket commands `serve-activate { identity material,
  relay config, options }` / `serve-deactivate` / `serve-status`. The
  daemon starts the relay client + session manager + hosting supervisor
  in-process. `gssh machine serve start` becomes: ensure daemon → unlock
  identity → activate → report. `--foreground` tails the daemon log.
- **session-handler drops the socket hop**: same process now — replace
  `sendBoundedTmuxCommand` with a direct dispatch into the server's command
  switch (extracted as `dispatchCommand(cmd): Promise<Response>`; the
  socket listener calls the same function). One protocol still exists per
  transport boundary that is REAL (local unix socket for CLIs, remote E2E
  for clients) — the self-IPC one disappears.
- **Logs**: the lazy spawn writes the daemon's stdio to
  `<state>/daemon.log` instead of 'ignore' (instrumentation sweep quick
  win #1 lands as part of P1).
- **Status**: one PID, one status surface (fold serve's status socket
  fields — relay connection, client count — into the daemon's status;
  `gssh status` reads one place).

## Trade-offs accepted

- **Crash blast radius**: a relay-client crash now shares a process with
  PTYs. Accepted deliberately (the reverse — serve crashing — already
  orphaned the tmux grandchild). A supervisor/auto-restart can come later.
- **Key in daemon memory**: unchanged exposure — one long-lived same-user
  process holds it instead of another. Passing it over the same-user 0600
  unix socket is within the existing trust domain (the encrypted keyfile +
  keychain password already live there).
- **Signal handling**: server.ts's handlers become the single shutdown
  path; serve's cleanup (relay disconnect, tunnel teardown, pid files)
  registers into it.

## Phases

**P1 — daemon gains the serve runtime (activation).**
New `src/lib/tmux-lite/serve-runtime.ts`: instantiates machine-relay-client
+ ClientSessionManager + hosting supervisor inside the server process,
driven by `serve-activate`/`serve-deactivate`/`serve-status` socket
commands. session-handler keeps `send()` initially (socket-to-self; the
direct-dispatch swap is P3). Lazy spawn logs to `<state>/daemon.log`.

**P2 — `gssh machine serve start` becomes the activator client.**
Unlock → activate → report; `--foreground` tails the log; serve's own
daemonization/PID/status-socket code retired; `gssh status` reads the
daemon. dev.ts stops managing a separate serve child (its 'serve' phase
becomes the activation call).

**P3 — self-IPC removal.**
Extract the server command switch as `dispatchCommand()`; session-handler
calls it directly; socket path unchanged for external CLIs. Delete the
serve-side bounded-forwarding shim.

**P4 — artifact-protocol Phase 5** lands in the unified daemon: mint +
ledger + share_read handler all next to the key and the mounts; relay adds
`GET /artifact-share/<token>` verifying against the registered machine
pubkey and streaming over a new plaintext WS message pair (deliberately
non-E2E — share links exist to serve unauthenticated browsers).

## Non-goals

- The relay stays its own process (it serves OTHER machines too).
- No back-compat shims: `machine tmux start/stop/status` operate on the
  one daemon; docs updated in the same cutover.
