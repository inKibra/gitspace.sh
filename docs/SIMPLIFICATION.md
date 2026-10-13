# GitSpace simplification

Status: proposal for sign-off. Replaces the "untrusted cache" model in PI-RUNTIME-DESIGN.md where they conflict.

## Why

The runtime treats a user's machine as an untrusted cache and wraps every effect in proof, leases and fences. Each layer fails closed, so one stuck call, stale record or late heartbeat locks a workspace, and each layer reports its own status. On 2026-10-13 this caused: machines stuck "attaching" behind a readiness proof, a workspace locked by a launch fence (36 rejected calls), offline flapping from heartbeats waiting on snapshot capture, and an interactive setup run that could never start.

## Model

- **Workspace** — files in the cloud git store plus the conversation. The cloud owns both.
- **Machine** — the user's computer, attached to workspaces.
  - **Online** = its relay socket is connected. No heartbeats.
  - **Ready** = online and sync for the workspace is running (checkout exists). Nothing else changes it.
  - **Commands** run directly and return their output. A machine restart reports a running command as `interrupted`.
  - **Setup** = the repo's lifecycle scripts run with secrets and values injected. Each script has its own result; a failure never blocks anything. Interactive scripts run in the terminal panel.
- **Status** — one summary per workspace, computed in one place, stored where the sidebar reads it. UI, agent, CLI and conversation notices all read it.

## Rules

1. **Sync is a diff against a recorded base.** A machine snapshot can only change or delete files that existed in its base; a file the cloud added after the base can never be deleted by it. The cloud three-way merges; same-file changes on both sides are conflicts.
2. **Nothing is lost without a backup.** Discarding unsent machine changes first commits the machine state to `refs/gitspace/backups/<machine>/<timestamp>` and uploads it to the cloud store; resolving a conflict first keeps the conflicted cloud version at `refs/gitspace/backups/cloud/<timestamp>`. Each backup records its base (`<ref>-base`); restoring re-applies the backup's changes since that base onto the current files as a three-way merge, so later cloud changes are not reverted. No upload, no discard. Agents may discard; no human approval. A machine backup keeps its LFS pin until it is pruned (newest 20 or last 30 days).
3. **No polling, no long-polls.** The cloud pushes work and sync notices over the relay socket; the UI uses hibernatable sockets. Alarms stop rescheduling when there is nothing to do.
4. **A request touches at most two Durable Objects**: the worker and the object that owns the data. Signatures are verified in the worker; replay protection does not scan a shared table. Call graph is one-directional (workspace → project, never back).
5. **No long exclusive locks.** Slow work is a durable step list processed by alarms.
6. **Errors say what to do next** in plain language (e.g. "Darktop is offline since 9:41 and no other machine is ready; start GitSpace on Darktop or attach another machine").
7. **No checks nobody asked for.** Tests that only pin removed behavior are deleted with it.

## Relay push (machines)

Every machine already holds one WebSocket to the account's `UserRelayDO`, accepted with the Hibernation API.

- **Liveness:** WebSocket protocol pings, or a fixed ping answered by `setWebSocketAutoResponse`. Neither wakes the object nor is billed. Online/offline is written only on connect and on close/error; a silently dead socket is detected on read from the auto-response timestamp. No timers, no alarms.
- **Cloud → machine:** a small notice ("run attempt A", "workspace W is at version V") sent over the socket; the call returns at once. The machine pulls what it needs over HTTP and POSTs the result. No request is held open while a command runs.
- **Service tunnels** (dev-server WebSockets) use `acceptWebSocket`, never `accept()`, so they do not pin the relay.

## Live updates (browser)

`result-rpc` keeps queries and mutations. Its 16 subscription procedures (streamed HTTP responses held open by the data-owning object) are replaced:

- One WebSocket per tab to a per-account live object, accepted with the Hibernation API.
- When state changes, the owning object sends one notice to the live object: `{ project, workspace, resource, version }`. The live object forwards it to the tabs subscribed to that key.
- The tab refetches with a normal `result-rpc` query using its cursor.
- Short streaming downloads (inspector file and transcript reads) stay as streams; they end.

## Cloudflare usage rules

From Cloudflare's pricing and lifecycle docs (2026-09-30): duration is billed while an object runs or is idle but cannot hibernate; reads are billed per row scanned ($0.001/M); writes cost 1,000× more ($1/M), each index and each `setAlarm` adds writes; incoming WebSocket messages bill 20:1, protocol pings and auto-responses are free.

1. **Nothing pins an object.** No `setTimeout`/`setInterval` in Durable Object classes; no standard `WebSocket.accept()`; no streaming responses or long-polls from data-owning objects; `waitUntil` only for short bounded work.
2. **No request waits on a machine.** Cloud → machine is a notice; results come back as a new request.
3. **Alarms stop when idle** and never reschedule unconditionally; an alarm that throws must not loop.
4. **Every hot query is indexed;** no unindexed `WHERE`/`DELETE`/`ORDER BY`, no `COUNT(*)` on growing tables, no "select all then filter". Bounded with `LIMIT`.
5. **Write only on change.** No rewriting unchanged rows, no whole-JSON rewrites to change one field, no index that is not read.
6. **No per-account choke point** in the request path; at most two objects per request; one-directional calls.
7. **Safe across deploys.** Every deploy resets every object: in-flight calls are retried idempotently and no status is derived from a transient failure.
8. **Bounded memory and fan-out:** never load a whole table or history into memory; no per-request fan-out across workspaces.
9. **Cache API and KV only for immutable data** (git objects).
10. **Usage alerts and a daily report** of rows read, rows written and active hours per worker and namespace, so a runaway loop is caught within a day.

## Agent and user tools

- `workspace_status` — the summary: machines (online/ready, setup per script with errors and log refs, sync: last sync, unsent local changes, unapplied cloud changes, problem, conflicts) and the cloud version.
- `sync` tool, one method each: `status` (unsent machine changes, cloud changes not yet on the machine, conflicts, last sync), `now`, `diff` (with a patch for one path), `discard` (backs up first), `backups`, `restore(ref)`, `resolve(path, keep)`.
- `environment.runPhase({ machine, phase, script? })`; an interactive script returns "needs a person at a terminal".
- Conversation notices on machine offline/online, setup failure and sync conflicts.
- Environment tab per the approved proposal (`?gallery=environment-proposal`) plus a sync line: Sync now, Show unsent changes, conflict choices.
- Machine CLI: `gitspace status`, `gitspace setup [phase] [--interactive]`, `gitspace sync`, `gitspace env -- <command>`.

## Delete

| Area | Today | Approx. size |
|---|---|---|
| Machine's old agent stack: local SQLite (`core`), `MachineSessionCoordinator`, `ProjectLifecycleManager`, `cloud-space-authority`, portable space controller, session publication replay, device-registry poll, legacy migration client | still started by the machine host | ~5.5k src + ~5.9k test + 2.0k `core` |
| Executor proof machinery: attempt journal, sealed receipts and acks, fences, checkout queue, per-command snapshots, replay classes | `runtime-machine/executor.ts`, `journal.ts`, `account-machine/runtime-executor.ts` | ~1.3k src rewritten to a few hundred |
| Attachment lifecycle: leases, deadlines, pause/reclaim/drain, primary flush, runner/delegate roles, cache-action request ids, retry records, default execution machine | `runtime-workspace-do/attachments.ts`, `runtime-attachments.ts`, `runtime-dispatch-selection.ts` | ~0.85k src rewritten to ~200 |
| Polling: 10s heartbeat, 10s assignments, snapshot long-poll, 20s release poll, 30s device poll | machine + `SpaceAuthorityDO` | replaced by relay push |
| Placements and legacy migration in the cloud | `project-authority.ts`, `space-authority.ts`, `application.ts`, `legacy-*` | ~0.3k files + ~80 call sites |
| Status derivations (11 functions) | web, protocol-workspace, protocol-environment | replaced by one summary |
| Demo code in the product: mocks, fixtures, galleries, blog drafts | `account-web` | ~1.8k + 288 KB content |
| Tests pinning removed behavior | machine 15.5k, worker 14.8k test lines total | delete, not rewrite |

## Keep

Signed requests with replay protection (indexed), credential vault and secret injection, cloud git store as file owner, three-way merge with conflict reporting, conversations, crons, MCP connections, skills.

## Phases

Each phase ships to bradleat and is verified on Golconda and PR 101 in the browser before the next; then lightbeam.

0. **Safety** — commit and push current work; index the nonce table; reproduce and fix the snapshot that deletes 16 Golconda files (rule 1).
1. **Sync** — base rule and backups (rules 1–2); `sync.*` tools.
2. **Execution and attachments** — delete proof machinery and attachment lifecycle; one status summary; `workspace_status`; plain errors.
3. **Transport** — relay push replaces machine polling; live notices replace the 16 `result-rpc` subscriptions; signature checks in the worker; two-object rule; no long locks; Cloudflare usage rules and daily usage report.
4. **Machine** — delete the old agent stack and `core`; machine CLI.
5. **UI** — Environment tab per proposal; single status everywhere.
6. **Cloud legacy** — placements, migration, dead control operations and tests; lightbeam rollout.

## Open

- Idle checkouts are never removed automatically; they stay until the machine is detached (assumed from the model; confirm).
