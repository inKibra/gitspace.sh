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
5. **No long exclusive locks.** Slow work is a Pi durable task in the object that owns it.
6. **Errors say what to do next** in plain language (e.g. "Darktop is offline since 9:41 and no other machine is ready; start GitSpace on Darktop or attach another machine").
7. **No checks nobody asked for.** Tests that only pin removed behavior are deleted with it.
8. **Reads return stored rows.** A read never re-derives, never rebuilds a snapshot, never fans out across objects and never writes.
9. **Derive once, when the data changes.** The object that owns the data recomputes what changed and stores the result; reads serve that result.
10. **Live updates are small messages about the one thing that changed.** A lost message is corrected by the next change or by one small read on reconnect. No outboxes, replay streams, cursors or snapshots for anything a screen shows.
11. **A simplification pass only deletes checks, refusals and locks.** Adding one needs the user's OK first, even inside a fix.
12. **Workspace state lives in the workspace object as Pi durable documents; multi-step work is a Pi task.** Ordering comes from the object (one event at a time, atomic transactions, output held until writes commit). No hand-built leases, fences, claims, tokens, outboxes, step lists or recovery jobs. Effects outside the object (git store, machine, provider) are made repeatable or report "outcome unknown"; they never fence.
13. **Failures are reported, not stored as blockers.** A failure reaches the agent or user in plain words when it happens. Stored failure state is for display only; nothing reads it to refuse an action. A new attempt always runs; the newest action replaces an older one.
14. **Every action does what was asked.** No refusals based on state; at most a warning beside the button. Delete always works.
15. **Authorization is checked once, at the edge:** the request signature and the user id in the object's name. Nothing re-checks it behind the edge.

Approvals: approval mode, approval cards and the approval queue are removed; agents always run. Kept: `propose_plan`, setup script approval and browser site approval.

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

As built:

- The live object is the account directory object (`UserProjectIndexDO`); the tab's directory socket also carries `{ type: 'subscribe' | 'unsubscribe', keys }` and receives `{ type: 'notice', … }` beside directory events. A socket's keys are kept as hashes in its attachment, so the object hibernates with tabs open. A workspace key matches on workspace and resource.
- Keys: account `settings`, `inference`, `cloud-images`, `machines`, `projects`, `provider-login:<flow>`, `machine:<id>` (the machine reconnected); project `project`; workspace `runtime`, `environment`, `space`, and the machine terminal resources.
- Owners: a change-log commit notices each changed resource once (`DurableChangeLog.wake`); a runtime publication notices `runtime`; a machine sends terminal notices over its relay socket, and the relay tells it when no tab watches one so it stops observing.
- Reads: the former subscriptions keep their paths as queries returning only events newer than `after` — at most 64 changes (else the current snapshot), or 256 runtime deltas (else a reset). A tab keeps one read in flight plus at most one queued per key, and rereads every key when its socket reopens.
- Still streamed: `inspector.transcript`, `inspector.artifacts.read`, `inspector.resources.read`, `inspector.repository.tree` (finite downloads), and the machine-facing `project.environment.watch`.

Batch 1 below replaces the cursor reads, change-log snapshots and the directory stream with rule 10.

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
10. **Usage alerts and a daily report** of rows read, rows written and active hours per worker and namespace, so a runaway loop is caught within a day. The platform worker's cron (00:15 UTC) reports the previous UTC day for each script in `USAGE_REPORT_SCRIPTS`, stores it in R2 at `usage-reports/<script>/<date>.json`, and logs `usage-report-spike` for a namespace (or the whole worker) whose day, or any single hour, rose more than 5× (hourly: rows written, active time or requests). It needs the `CF_ANALYTICS_TOKEN` secret (Account Analytics: Read). `bun scripts/cloudflare-usage-report.ts [--hours 24 | --date YYYY-MM-DD]` prints the same report locally from the wrangler login.

## Agent and user tools

- `workspace_status` — the summary: machines (online/ready, setup per script with errors and log refs, sync: last sync, unsent local changes, unapplied cloud changes, problem, conflicts) and the cloud version.
- `sync` tool, one method each: `status` (unsent machine changes, cloud changes not yet on the machine, conflicts, last sync), `now`, `diff` (with a patch for one path), `discard` (backs up first), `backups`, `restore(ref)`, `resolve(path, keep)`.
- `environment.runPhase({ machine, phase, script? })`; an interactive script returns "needs a person at a terminal".
- Conversation notices on machine offline/online, setup failure and sync conflicts.
- Environment tab: Overview, Machines (one status each, setup results inline, sync line: Sync now, Show unsent changes, conflict choices through `runtime.sync`), Setup (named steps, interactive scripts, approvals), Values (names only).
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

Each phase ships to bradleat and is verified on Golconda and PR 101 in the browser before the next. Darktop is the only machine; lightbeam is not migrated.

0. **Safety** — commit and push current work; index the nonce table; reproduce and fix the snapshot that deletes 16 Golconda files (rule 1). Done.
1. **Sync** — base rule and backups (rules 1–2); `sync` tool; plain `git push` to one snapshot ref per workspace. Done.
2. **History on Pi** — imported OMP history converted once into native Pi entries; transcript and `history_search` read pi-durable's own entries in bounded windows; transcript/history projection tables dropped. Done.
3. **Execution and attachments** — proof machinery and attachment lifecycle deleted (`attaching|ready|detached`); `POST /runtime/execute` returns the tool result; `gitspace.status` document and `workspace_status` tool. Done.
4. **Transport** — Done:
   - **Auth:** every worker and Durable Object isolate caches the vault's device registry and account state (refresh 30 s, fail closed at 120 s) and verifies the existing per-request device signatures itself; 60 s window, clients learn server time from the `Date` header; no nonce writes; socket proofs in `Sec-WebSocket-Protocol`; sockets recheck against the cache and close on revocation. (Chosen over a JWT: the worker already has every device key, so a token would add a format and a secret without adding a property.)
   - **Two objects per request:** the workspace object owns its metadata and lifecycle (seeded once from the project) and authorizes runtime requests locally; archive/delete/phase go to the workspace first.
   - **Machines:** relay notices (`assignments`, `workspace.snapshot`, `release`, `devices`, `settings`, `environment`) carry no state; the machine fetches over HTTP, catches up on every connection, retries failed reads with backoff. Online = relay socket connected (ping auto-response). Machine-wide assignments read a per-machine index. Presence is re-asserted to workspaces on every accepted socket and on the relay sweep.
   - **Browsers:** one hibernatable socket per tab to `UserProjectIndexDO`; owners send `{ project, workspace, resource, version }`; tabs re-read with bounded cursor queries. Finite downloads stay streams.
   - **Sockets and timers:** service tunnels and the Chrome extension socket hibernate; no timers in object classes. The cloud browser's CDP socket is outgoing and cannot hibernate (open decision below).
   - **Locks:** `runtimeSetBaseBranch` is a durable step list; machine pairing takes no lock.
   - **Usage report:** platform cron `15 0 * * *` (needs secret `CF_ANALYTICS_TOKEN`) and `scripts/cloudflare-usage-report.ts`; flags daily and hourly spikes.
5. **Machine** — old agent stack and `core` deleted (done); machine CLI.
6. **UI** — demo code deleted (done); Environment tab (done); single status everywhere (done: the workspace object derives one summary from live tasks, questions and `gitspace.status`; every surface shows it through one dot).
7. **Cloud legacy** — legacy migration, placement mutators, and dead control operations deleted (done); remaining tests; old snapshot refs (`refs/gitspace/spaces/*/checkpoints/*`) cleanup.

Rows stored by older releases are rewritten when read: machine journal attachments and DO attachment rows map `lost`/`draining` to `detached`, and a stored runtime snapshot that no longer parses is rebuilt at startup from its cursor. A stored workspace status summary in the old shape (derived from conversation flags) reads as unreported until that workspace's runtime publishes again.

Alarms: a due wake whose handler neither cleared nor moved it is dropped at the end of the alarm (an orphaned `leases` row from the deleted attachment lifecycle kept one workspace waking ~21 times a second).

Search: `grep` is exact ripgrep and needs an attached machine; `code_search` is a cloud FTS5 trigram index per workspace (built in alarm steps per snapshot, bounded verification, reports how far behind it is). Agents may attach machines (`machines` `op: 'attach'`, attach on first need, per-machine "Agents may attach", default on).

## Work plan

Every item is verified the way the user works, in the browser, before it is reported done.

**Batch 0 — rules and audit.** Done: rules 8–15 above; audit of every read endpoint and check in `local://audit-*.md` (worker checks: 144 keep, 151 delete, 86 decided by rules 12–15).

**Batch 1 — unblock: workspace state on Pi, no blocking conditions.**
1. Done (`1d8ae04`). Delete always works, whatever state the workspace is in: the lifecycle and "complete cloud/destroy first" refusals are gone, and the sidebar, project cards and creation panel all offer Delete. A creation that never finishes needs no timeout: Retry and Delete are offered while it runs, and the newest action wins. Then delete the two stuck PR 101 creations in Deedible Info.
2. Done (`7c5b2fdb`, `4273ac4e`, `8cf78774`, `f550693e`, `c185f926`, `404cd53b`). Environment runs live in the workspace object: its environment state, runs and logs moved out of the project object once (the project keeps only shared values and approvals). A new run replaces the running run of its phase, Cancel always ends a run, a lost machine ends its runs, a run nobody owns after a machine restart ends when cancelled. No ownership token, run journal, restart reconciliation or streamed watch: the machine follows its runs through the relay notice. The runtime waits for a run's end instead of polling. A running interactive run shows "Running in terminal" with Open terminal and Cancel.
3. Done. Cloud edits: delete the writer lease, its fence and recovery job; edits run in order inside the object; the git compare-and-swap stays.
4. Done. Base-branch change runs once in the checkout's queue with repeatable steps (a failure is reported, retrying finishes it); the step list, alarm retries and the fence that refused every other call are deleted.
5. Workspace creation and machine snapshot publication become Pi tasks; "pending" and "abandoned" publication states and the detach refusal are deleted. Done so far (`649c7697`, `03577af2`, `bc0f3170`): the detach refusal and the abandoned state are gone; operations lost their never-set target machines, claim token, lease and revision refusal. Left, needs a decision: the pending publication record is what lets an uncertain git push be finished instead of leaving the cloud ref ahead of the recorded version; creation already offers Retry and Delete while it runs.
6. Done (`4764abd9`). The workspace object decides its lifecycle and phase and the project records them without a revision check, so a project-side write (a rename) no longer leaves an archive or delete half-applied. The project row stays as the listing's copy, written only by the workspace (rule 9); listing never reads workspace objects.
7. Stuck states become reported failures: Composio "not ready", uncertain logins, browser fences (the agent is told the action's outcome is unknown), cached checkpoint rejections. Done (`87a9814`, `f88e7c9`, `3857237`; checkpoint rejections are no longer stored, every capture retries and reports).
8. Done (`c508260`, `2cef3d8`). State refusals removed: a failed project making workspaces read-only, "lifecycle was destroyed", delete waiting for cloud destroy, provision requiring automatic setup, cron delete while running, journal gates.
9. Done (`0e15e79`). Duplicate authorization removed: membership scans, the hostname settings hop, the capability map, repeated subagent/approval/generation checks.
10. Done. Approval mode, approval cards and the approval queue removed. Plan approval and the per-machine "Agents may attach" question stay.
11. Done (`a2558ba`). Agent commands longer than 5 minutes no longer time out at the relay.
12. Done. Bugs the audit found: an agent's cron run opens the wrong object (no code ever created that task; deleted); a machine is refused when it asks to be attached; an LFS table that is never read (the whole origin-receipt and source-resolution round trip was dead and is deleted, with the leftover collection code).
13. Done (platform Worker redeployed from `89816d8f`; a fresh invitation signs up and opens on default release `b355af77`). New accounts: the platform channel is a Sep 12 build whose signup crashes ("internal error"); `cloudflare-judges` and `signup-test-1014` were put on bradleat's release by hand (`/tmp/opdeploy/deploy-tenant.ts`). Publish a current default release so invitations work unaided (published `b355af77`, image `gitspace-onboarding@sha256:eb0617a8…`). The Workers AI key dialog should ask for the account ID instead of taking `{"token","accountId"}` (done). An agent's `read` right after its own `write` in the cloud returned empty once (fixed with item 3: reads wait for writes admitted before them). The platform's default cloud image (Sep) never becomes healthy; `cloudflare-judges` pins `gitspace-onboarding@sha256:1e754a2e…` (built from `9c1b34d`, works) — make a current image the platform default.
14. Done (`5dc51740`, `31b31d9b`, `f76b7a0f`). Found while staging the demo: a project agent cannot set relations on another workspace ("outside this agent's workspace"); a workspace sourced from another workspace starts from its last commit, so uncommitted cloud edits never reach it; a machine whose unsent changes include a >32 MB file blocks sync, so a new `.gitignore` cannot reach the machine to fix it (the agent had to delete `node_modules`).

**Batch 2 — status and live updates.**
1. Done (`4245232c`). Status as a small message: on change each workspace sends `{ workspaceId, status }`; the socket object keeps one row per workspace and forwards it; the sidebar updates that row; page load reads the rows once. The open workspace's view is unchanged. Done when an agent working, then the user clicking away, leaves the row Working until it stops.
2. Done (`d67a2e14`, `1d34a697`). Remove outboxes, replay streams and snapshots (account-directory outbox and stream, every `*.events` cursor endpoint) for the same pattern. A change sends a notice and the tab reads the current state (settings.state, inference.list, machine.image.list, environment.state); the account directory is sent whole when a socket opens, then one slice per change; sources publish directly. `terminals.events` stays: it is a machine's terminal output stream, not screen state.
3. Done. "Account directory connection failed": record close codes to tell deploys from network drops; brief reconnects are not shown as errors.

**Batch 3 — drive and documents.**
1. Done. `local://` → `drive://`, hard cutover, no alias (cron artifact scopes rewritten once; links in old transcripts stay text): parser, composer, tools, skills, agent instructions, inspector tab "Drive".
2. Done (`3aa874b3`, `add8482a`). Agents read PDFs and documents: Workers AI `toMarkdown` (`[ai]` binding), result kept in the workspace object by content hash; pages of at most 2,000 lines / 40,000 characters with an offset note. Measured: a 200-page text PDF (715 KB) converts in 0.6 s to 626 KB of Markdown; a scanned PDF converts to empty pages, so it reports that it has no text layer.
3. Done (`daebf26d`, `24580074`). Files tab shows binary files (PDF in the viewer, not base64): PDFs embed with a download fallback, images render, other binaries download. The automation browser loses its page when Chrome's PDF viewer attaches, so the PDF view itself was not screenshotted.
4. Done (`f3ec1514`). Chat: attachments as links; user messages rendered as Markdown.
5. Done (`974dfb75`, `7276d1be`, `aa6823bb`). File names with `:`; abandoned upload chunks cleaned up. Drive URLs encode each path segment, so `log 10:30.txt` is `log%2010%3A30.txt` and never reads as a selector; starting an upload removes staged uploads untouched for a day. Found on the way: agents could not read a drive text file over 128 KiB at all; agent reads of drive and repository text now page like documents.

**Batch 4 — reads that rebuild** (from the audit).
1. Done (`31940d75`, `84293b8f`). `environment.get` returns the workspace's stored environment, derived when its files change (was 3.4 s, five objects; now the panel fills in 0.5–0.8 s). The workspace object records the commit and profile it derived from and derives again only when they move; an agent adding a lifecycle script shows in an open panel. Found on the way: a new workspace's first checkpoint ref was created twice when the panel and agent opened together ("stale ref").
2. Done (`8b8f20d3`). Inspector: drop the 3-object preamble on every request; opening the Inspector no longer starts the agent; `inspector.view`, overview, repository tree and artifacts read stored rows. `inspector.view` opened the runtime to report a saved-transcript status nothing displayed (the unused `SavedWorkspaceHistory`); that read and its fields are gone. The workspace and project rows are read in parallel, and the inspector-context object names its workspace on first use instead of a bootstrap call per request.
3. Done (`d8e85379`, this commit). `space.view`, `project.list` (writes on every call), `stackStatus` (git merge-base per read), the machines list (runs fleet control), the Providers screen (decrypts every credential, calls every provider). `project.list` creates the GitSpace project only for a new account. The machines list returns catalog rows (`reconcileFleetMachines` deleted; machines change through sleep/resume/destroy). `space.view` lost its serial event-offset read and four constant or unused fields. `stackStatus` keeps its comparison in the project object per child/parent/base commit and recomputes only when one moves. Providers keep each credential's non-secret account (type, identity, email) beside it, so the list decrypts nothing; usage still asks each provider, at most once a minute, because showing live usage is that screen's job.

**Batch 5 — machine and relay.**
1. Delete old-machine paths: `afterSnapshot` long-poll, `runtime.heartbeat`, echo heartbeat.
2. Relay drops on Darktop (every connection resets together); a finished command is not reported failed.
3. Machine-wide assignments take ~30 s for 4 workspaces: cache per commit.
4. Agents attaching machines, tested live.
5. Conversation notices: machine offline/online, setup failure, sync conflict.
6. The release follower logs an old launch failure on every start.

**Batch 6 — inference.**
1. Claude fast mode sends requests without the Claude Code identity.
2. Provider errors in plain words with the next step, not raw JSON.
3. OpenAI usage on the Inference page (port omp's ChatGPT usage reader; check the stored provider id).

**Batch 7 — cleanup.** Old snapshot refs (Golconda ~1,108, PR 101 4); `saved-transcript-*` in the worker; the failing LFS and Artifacts tests.

**Batch 8 — small UI bugs.** Golconda's mode switcher; Deedible Info's context meter at 264%; empty `system` messages in Validator and PR 101; ~925 "client disconnected" errors on Validator.

**Later.** Machine CLI (`gitspace status`, `setup`, `sync`, `env --`).

**Parked.** Cloud browser (until Inkibra Aperture): its CDP socket keeps the workspace object awake while a browser is open.

## Needs a decision

- Usage report: `wrangler secret put CF_ANALYTICS_TOKEN`, then deploy the platform worker.
- Idle checkouts stay until the machine is detached — confirm.
- Old Cloudflare workers (`gitspace-api`, `-auth`, `-platform`, `-sandbox-worker`, `-docs`, relay spikes, `gitspace-relays`): punted.
