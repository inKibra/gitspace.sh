# Pi Runtime: Durable Workspaces on Pi 1.0

> **Status: Design with pass-10 owner decisions applied.** The browser, origin-grant, machineless file, and LFS rules below supersede earlier behavior. Broader roadmap items remain proposals. The owner verified Artifacts binding reads and snapshot publication in the `gitspace-live-check` scratch namespace in the InKibra Corp account. Artifacts has no LFS endpoint; GitSpace stores committed local LFS objects in encrypted R2 storage instead.

## 1. Summary

Replace GitSpace's embedded OMP (oh-my-pi 18.2.11) agent runtime with a runtime GitSpace owns, built on **Pi 1.0** packages:

- `@earendil-works/pi-ai` for providers and classifier (Jev) and image models,
- `@earendil-works/pi-durable` for the durable conversations, tasks, and documents of a workspace,
- `@earendil-works/chord` for replicated state, services, and UI sync,
- `@earendil-works/pi-mcp` for MCP and cloud WorkerLoader isolates for scripted tool fan-out.

Target architecture (**option B**): each workspace lives in a **Cloudflare Durable Object** that hosts its pi-durable Session (agent conversation, subagents, operational tasks, documents). Code lives in a per-workspace **Artifacts** repository (internal storage; the `local://` artifact store keeps its name). Machines become **executors**: they hold working copies, run tools, processes, and environment scripts, and attach or detach without moving the workspace.

```text
                       ┌────────────────────── Tenant Worker (Cloudflare) ──────────────────────┐
Browser / MCP ──Chord──▶ Workspace DO: pi-durable Session (conversations · tasks · documents)   │
                       │      │ model calls (cloud egress)        │ credentials over DO RPC      │
                       │      ▼                                   ▼                              │
                       │   providers                    Credential vault DO (existing)            │
                       │      │ Artifacts binding: read files, fork, mint repo tokens            │
                       │      ▼                                                                   │
                       │   Artifacts repo per workspace (git)      R2 bucket per tenant (blobs)   │
                       └──────┬───────────────────────────────────────────────────────────────────┘
                              │ relay: tool calls, jobs, environment runs, PTY streams
                 ┌────────────┴─────────────┐
                 ▼                          ▼
        Machine (local workspace cache) Machine (snapshot-pinned runner)
        supervisor · programs · sync    supervisor · jobs · tests
```

**Fallback (option A):** the same Session code hosted by a per-workspace worker process on the machine, with local storage replicated to the cloud. Only the storage adapter and the process hosting the Harness differ, so option B can be abandoned at the spike without rewriting the runtime.

## 2. Why

### 2.1 OMP as an upstream

- **Patch burden:** three patches over OMP's published packages, ~4,800 lines: `pi-coding-agent` (72 files), `pi-ai` (26 files), `pi-agent-core` (6 files), plus a `pi-catalog` overlay. Every upgrade is a manual re-patch.
- **Upstream churn:** OMP's TypeScript line ships several releases a day (18.0 to 18.4.9 in six weeks). A Rust rewrite (`omp2`) exists on an orphan branch and will publish under the same npm names (`@oh-my-pi/pi-coding-agent` becomes a launcher for a native binary; `scripts/gen-npm-packages.py` on `omp2`). TypeScript extensions will not carry over.
- **What we actually use** (tool calls in 7 GitSpace transcripts, ~11k calls): `read` 3,331, `eval` 2,033, `grep` 1,066, `bash` 881 (238 in the background), `edit` 598, `hub` 501, `write` 468, `todo` 380, `glob` 214, `ask` 81, `web_search` 55, `task` 51. Devices: plan `propose` 93, `report_issue` 56, `lsp` 41 (all failed: no language server configured), MCP 31, `ast_edit` 4. Most of OMP's surface is unused or reimplemented by GitSpace.

### 2.2 Bugs the current architecture produces

Each of these comes from hand-built durability around a worker process:

- A user Stop was recorded as an agent failure (fixed in #150).
- A planned worker restart after a profile edit left workspaces red until Recover (fixed in #150).
- Workspace creation half-completes and needs Retry; the in-process `creating` set is lost on restart.
- Background job records live in OMP's in-process job manager and are lost when the worker restarts.
- Launches hang when the old release does not finish shutting down within 120 s (2026-10-01 and 2026-10-02 04:26 UTC: "the generation remains fenced"), likely on checkpoint uploads of large session files.
- The sidebar shows "Status unavailable" when a status read fails, because UI state is rebuilt from projections with hand-written resync.

pi-durable makes the durable record the state: runs, queued messages, aborts, subagents, and operational tasks are committed before they are shown and resume after a crash.

## 3. Goals and non-goals

### Goals

1. Every workspace's agent and operational state is durable, resumable, and readable without a machine.
2. Machines are interchangeable executors: losing one loses at most in-flight tool effects, never workspace state.
3. No OMP code or patches remain; Pi packages are pinned exactly and wrapped behind GitSpace modules.
4. Keep the agent capabilities we use (table in §8); drop the rest deliberately.
5. Environment scripts keep their format and semantics (§10).
6. One state-sync contract for the UI (Chord), replacing per-feature projections and resync logic.
7. Multiple machines per workspace: read-only runners first (level 1), delegated branches later (level 2).

### Non-goals

- Changing the environment script format, or running environment scripts without a machine.
- Automatically provisioning cloud machines for environment runs.
- Multi-writer access to ignored or machine-local files. Portable working-copy changes do synchronize through the cloud snapshot chain.
- LSP, DAP debugging, Python eval kernels, devices (`xd://`), Mnemopi memory, OMP's TUI.
- A general plugin marketplace.

## 4. Pi 1.0 building blocks

| Package | Role here | Notes |
|---|---|---|
| `pi-ai` 1.0 | Providers, `Models` collection we construct, classifier and image models | `Provider` interface: `auth`, `getModels`, `stream`, `streamSimple`, `classify`, `generateImages`. Providers include `openai-codex`, `amazon-bedrock`, `anthropic`, `openai`, `google`, `openrouter`, and ~40 more. Missing vs OMP: Cursor, Antigravity, Gemini CLI. |
| `pi-durable` 1.0 | Harness: Sessions, conversations, entries, tasks, documents, watch | README marks it **experimental**. Built-in tools: `read`, `write`, `edit`, `bash` only; `read` has no image support yet. Storage: memory, SQLite, JSONL; the portable cores run "on Bun or in Cloudflare Durable Objects". |
| `chord` 1.0 | Replicated state, services, Context, delta tracking | Runtime-neutral except the plugin bundler/loader (`chord/bundler`, `chord/node`, esbuild). |
| `pi-mcp` 1.0 | MCP client | Standalone. |
| Codemode | Sandboxed JS that calls injected tools | Cloud WorkerLoader isolate with no network, raw sockets, Node compatibility, or environment bindings (§7.4). |
| `pi-server` / `pi-client` / `pi-protocol` | Routing clients to hosted Sessions over CBOR | Optional; usable as the relay adapter for Chord services. |

Every Pi package is pinned to an exact version. GitSpace code imports Pi only through `packages/runtime-*` modules so API changes stay contained.

## 5. Architecture

### 5.1 Components

| Component | Where | Owns |
|---|---|---|
| **Workspace DO** (evolves the existing per-space `SpaceAuthorityDO`) | Tenant Worker, one per workspace | The workspace's pi-durable Session: root conversation, subagent conversations, operational tasks, documents. Placement and lifecycle authority it already owns stay in the same actor, so one single writer covers both. Scheduler for dispatching work to machines. |
| **Project DOs** (existing `ProjectAuthorityDO`, `ProjectSecretsDO`, `ProjectCronsDO`) | Tenant Worker | Project-scoped state: environment ledger and values, secrets and grants, cron definitions, and the new QA queue. |
| **Credential vault DO** (existing) | Tenant Worker | Sealed provider credentials, refresh leases, profiles, assignments. |
| **Artifacts namespace** | Cloudflare Artifacts, one per tenant | One repo per project (imported) and one fork per workspace. |
| **R2 bucket** (existing, one per tenant: `gsp-relay-<accountId>`) | Cloudflare | Blobs: `local://` artifacts, uploads, large tool outputs. |
| **Machine runtime** | User machines, GitSpace cloud machines | Attaches to workspaces, holds working copies, runs the **supervisor** (terminals, services, jobs, environment runs), and executes admitted machine tools. Codemode stays in the cloud. |
| **Relay** (existing) | Cloudflare | Transport between DOs, browsers, and machines. |

### 5.2 Ownership rules

- **One owner per Session:** the Workspace DO is a single-instance actor, so pi-durable's "never two owners" rule (spec §7.5) holds by construction. No machine ever opens a workspace's Session storage.
- **Machines own effects, not state.** A machine's local journal proves what a process did; the durable record of the task lives in the DO.
- **Cloud-authoritative remains cloud-authoritative:** placement, credentials, projects, profiles, and secrets keep their current homes.

### 5.3 Option A fallback

If the DO spike fails (CPU, bundle compatibility, cost), the Harness runs in a **per-workspace worker process on the machine**:

- The machine process becomes a router and supervisor; it spawns one worker per active workspace, which owns that workspace's storage (SQLite or JSONL). This follows Pi's own server/worker split (`pi-server` README).
- Handoff between workers: stop admitting work, `harness.close()` with a deadline, kill on timeout, open in the new worker only after the old process is gone. GitSpace enforces single ownership with an OS file lock held by the worker.
- Storage replicates continuously to R2 (JSONL segments are append-only and easy to ship), so machine loss costs seconds of state.

### 5.4 Package layout

```text
packages/
  runtime-core/          NEW  GitSpace's Pi runtime, runtime-neutral (Durable Object and Bun)
    src/harness.ts             Harness options, storage adapter interface, live settings
    src/documents/             gitspace.* document tokens (defineDoc / defineDocFamily)
    src/tasks/                 CreateWorkspace, Checkpoint, LifecycleRun, Job, Service, Merge, CronSchedule
    src/tools/                 cloud tools; machine tool declarations (schemas only); routing table
    src/extensions/            plan mode, skills, instructions, approvals, TTSR, titles, QA reporting
    src/inference/             vault-backed Provider wrappers, roles, egress placement, catalog overlay, judge
    src/history/               transcript index and relevance gate
    src/placement/             machine selectors and scheduling policy
  runtime-workspace-do/  NEW  Workspace Durable Object host (evolves SpaceAuthorityDO): DO SQLite storage
                              facade, Chord service endpoints, Artifacts binding, dispatch over the relay;
                              exported through account-worker's entry
  runtime-machine/       NEW  Machine executor: ExecutionEnv over working copies, machine tools
                              (bash/grep/ast-grep), cache synchronization,
                              egress proxy, attachment client
  supervisor/            NEW  Process supervisor: PTY and pipe processes, owners, readiness, restart
                              policies, capped logs with cursors; replaces OMP's launch broker
  protocol-runtime/      NEW  zod contracts: machine↔DO frames (tool dispatch, jobs, processes,
                              environment runs, attachment, egress), placement selectors, Chord service
                              declarations shared with the web app
  provider-auth/         NEW  OAuth token refreshers and vault wire schemas (lifted from the pi-ai patch)
  catalog/               NEW  Override data (JSON plus zod schema): hidden models, Bedrock profiles, names,
                              cost fixes, edit-tool rule (§8.8)

  account-worker         CHANGED  exports the Workspace DO; QA queue; Artifacts namespace;
                                  vault serves access tokens over DO RPC
  account-machine        CHANGED  keeps host, updater, relay, settings, CLI-facing runtime; replaces
                                  omp-runtime.ts, agent paths in session-coordinator.ts, and workspace-hub.ts
                                  with runtime-machine and supervisor; gains machine attachment
  account-web            CHANGED  Chord client; Agent hub, machines view, QA inbox, per-machine terminals
  protocol, protocol-agent, protocol-environment, protocol-workspace
                         CHANGED  updated runtime-agnostic contracts
  platform               CHANGED  deployer binds the tenant's Artifacts namespace; Workspace DO CPU limits
  mcp-server             CHANGED  tools target the new runtime
  core, cli, deployment, sandbox-worker, ui, blocks, docs, design-tests, operator-*
                         unchanged except call sites (deployment drops OMP runtime packaging at M7)

  account-omp            REMOVED at M7, with packages/account-omp/patches/* and every @oh-my-pi/* dependency
```

**Dependency rules** (enforced by an import-graph check in CI):

1. Only `runtime-core`, `runtime-workspace-do`, and `runtime-machine` import `@earendil-works/*`.
2. `runtime-core` is runtime-neutral: no `node:*`, no `chord/node`, no `chord/bundler`, no `pi-codemode`.
3. `runtime-workspace-do` is Worker-safe; its bundle is checked for Node-only modules.
4. `runtime-machine` may use Node/Bun APIs and `pi-mcp`. It does not host codemode.
5. `protocol-*` packages import neither Pi nor runtime packages; `account-web` imports `protocol-*` and the Chord client only.
6. `account-machine` uses `runtime-machine`, `supervisor`, and `protocol-runtime`, never `runtime-core` internals.

## 6. Workspace data model

### 6.1 Conversations

- **Root conversation:** the workspace's main agent.
- **Subagent conversations:** owned by the spawning tool task (foreground) or a background anchor task (persistent), following pi-durable examples 22 and 23.
- **History:** entries are immutable; compaction, reset, and rewind are context edits over retained history.

### 6.2 Documents

| Document | Scope | Contents |
|---|---|---|
| `pi.agent`, `pi.live`, `pi.inbox`, `pi.usage` | conversation | Built-in: agent choices, running generation and tools, queued messages, spend. |
| `gitspace.execution` | workspace | `{ defaultMachineId: string \| null }`. A ready cache or automatic first-ready selection; never conversation ownership. |
| `gitspace.workspace` | session | Phase (plan/code/ship), goal, dependencies, branch, Artifacts repo, creation progress. |
| `gitspace.todos`, `gitspace.plan` | conversation | Todo phases; plan reference and approval state. |
| `gitspace.machines` | session | Attached caches and pinned runners, capabilities, and readiness per profile. |
| `gitspace.environment` | session | Selected profile, run ledger mirror, bindings, per-copy materialization state (§10). |
| `gitspace.jobs` | session | Job and process registry for the agent hub (§8.2). |
| `gitspace.qa` | session | Reports filed in this workspace before they reach the project QA queue. |

### 6.3 Tasks

| Task | Purpose | Replay |
|---|---|---|
| `pi.generation`, `pi.tool`, compaction | Built-in agent loop | Built-in |
| `CreateWorkspace` | Fork repo, record placement, first checkout, activate | Phases are idempotent |
| `Checkpoint` | Snapshot working copy to a private ref | Safe |
| `LifecycleRun` | Dispatch an environment run to a machine, stream logs, record outcome | **Never re-run shell effects**; interrupted on machine loss |
| `Job` | Run a command on a machine at a commit | Interrupted on machine loss unless declared safe |
| `Service` | Supervise a long-running process on a machine | Restart policy per service |
| `Merge` (level 2) | Merge a subagent's branch into the workspace | Safe |
| `CronSchedule` | Sleep until the next tick, start the run | Safe; backoff persists |

## 7. Execution model

### 7.1 Tool routing

Each tool is declared **cloud** or **machine**:

- **Cloud:** repository `read`, `write`, `edit`, `apply_patch`, and `find` always use the DO's Artifacts working-copy snapshot, whether machines are attached or not. `find` reads a commit-keyed path index and accepts `pattern` and `path`; it rejects the unsupported `glob` option. History, workspace reads, web search, judging, and cloud MCP also run here.
- **Machine:** `bash`, jobs, processes, environment runs, and AST matching execute on the chosen cache. Default `grep` uses pinned ripgrep on a verified caught-up cache, otherwise the cloud snapshot index. Cloud codemode sends nested calls through the normal tool authority.

The workspace has one main conversation. Only it and human edits to local caches can change the shared cloud working copy. Main-agent mutations serialize within a turn; independent reads can run in parallel. No conversation carries machine placement. Each admitted machine command carries the latest cloud snapshot as its minimum input.

### 7.2 Choosing machines

File tools have no machine selector. Program execution uses the workspace default or an explicit per-call override:

- `machines`: list attachments and use `setDefault` to choose a ready cache. `machineId: null` restores automatic first-ready selection. A configured but unavailable default fails rather than silently selecting a different machine.
- Applicable machine tools accept `on` to override the workspace default.
- `on` is a machine ID, unambiguous label, or selector such as `{ needs: ["macos"], profile: "ios", prefer: "idle" }`. No ready match fails immediately.
- `at` selects a separate snapshot-pinned runner on a machine with a ready cache attachment. `"current"` pins the current cloud snapshot; a commit or ref pins that exact source. Existing runners and delegates cannot substitute for a missing execution cache. It does not move a conversation or change the shared copy.
- Policy: per-project allowed machines and labels set by the user; approval before running on a machine the user does not own; secrets restricted by machine trust (§10.6).

### 7.3 Failure semantics

- **Machine loss during a tool call:** the tool task becomes `interrupted` with output so far (pi-durable default for non-replay-safe tools). The agent sees it as a tool result.
- **No machine attached:** cloud file tools and conversation operations continue. Machine tools fail immediately with an actionable error. They do not wait for a machine, launch one, or fall back to machine-side inference.
- **DO restart:** pi-durable resumes tasks from their last checkpoint; partial model output is lost for at most ~100 ms (README "Watching a Conversation").

### 7.4 Codemode

Codemode runs in a fresh cloud WorkerLoader isolate. User code receives revocable tool, MCP, and model capabilities, not machine access or credentials. The isolate has no direct network access, raw sockets, Node compatibility, or injected environment bindings. Each nested tool call passes through normal routing, hooks, approval, and grants and has its own durable outcome. Capability-call and child-call budgets are separate; the child limit also applies to MCP fan-out. A script can catch a definitive failure and complete without repeating earlier effects. Unknown outcomes remain interrupted and cannot replay on recovery. Subagents cannot use codemode.

### 7.5 Machineless operation

The cloud copy remains authoritative with or without attached machines:

1. **Repository files:** all file tools use the DO's Artifacts snapshot chain. Cloud edits change portable file contents, not Git HEAD or the staged index.
2. **Conversation and views:** transcript, documents, tasks, plan, goal, QA, history search, and cloud-tool turns remain available.
3. **Machine programs:** before a command, the cache publishes local changes relative to its durable base and catches up to the command's minimum snapshot. After the command, it publishes a delta, waits for cloud acceptance, and returns the result. An unchanged checkout publishes nothing.
4. **Concurrent changes:** the DO applies machine deltas to the latest cloud copy. Different files merge independently; same-file edits use a three-way merge. GitSpace conflict markers flag a path whether a cache or a cloud `write`, `edit`, or `apply_patch` introduced them. A partial resolution stays flagged while markers remain. An explicit clean replacement or deletion clears that path's conflict notice. Machine Git changes carry HEAD and index state; cloud file edits preserve them.
5. **Continuous sync:** a signed long poll wakes caches when the cloud snapshot changes. A filesystem watcher coalesces human edits through the same capture queue. Batched, cached Git ignore checks keep ignored writes from resetting the debounce; changes to ignore files invalidate the cache, including external global ignore changes. Capture waits for the complete dirty set, index, and HEAD to remain stable for one second, then checks again immediately before and after capture. A changed candidate is discarded before publication and retried. Every untracked file that Git does not ignore is portable, including editor scratch filenames. Git's standard rules cover `.gitignore`, `.git/info/exclude`, and `core.excludesFile`; tracked files remain covered regardless of those rules. Reconnect reconciles from the last applied durable base instead of resetting the checkout.
6. **Publication recovery:** one durable DO publication queue serializes canonical updates. This is not a machine writer lease. Once admitted, an uncertain publication must finish or remain fenced; it cannot be replayed as a new command.

A settle window cannot prove that a writer has finished. A writer paused for longer than one second can look like a completed save. Avoiding that ambiguity requires a writer-completion protocol; timestamps alone cannot provide it.

## 8. Agent features

### 8.1 Tool inventory

| Tool | Decision | Notes |
|---|---|---|
| `read`, `write`, `edit`, `bash` | Owner-schema registrations | File tools use the cloud copy; bash uses an execution cache. Each model gets `edit` or `apply_patch` by family (§8.8). |
| `apply_patch` | Cloud file mutation | Shared V4A parser and atomic snapshot publication for OpenAI families (§8.8). |
| `grep`, `find` | Separate owners | `grep` uses caught-up machine ripgrep or the cloud snapshot index; `find` uses the DO's commit-keyed path index. |
| `codemode` | Keep | Cloud WorkerLoader isolate with nested durable tool calls (§7.4). |
| `space_*` | New | Our host namespace as tools: environment, goal, artifacts, phase, workspace. |
| `agents`, `jobs`, `proc` | New, replace `hub` | §8.2. |
| `todo`, `ask`, plan approval | Port | Documents and waiting submissions. |
| `web_search`, `generate_image` | Port | `pi-ai` image models. |
| `ast_grep`, `ast_edit` | Port | `@ast-grep/napi`; keep staged-edit accept/reject. |
| `history_search`, `history_read` | New, replace Mnemopi | §8.6. |
| `report_issue` | Port to the QA queue | §8.7. |
| `checkpoint`, `rewind` | Port as context edits | §8.5. |
| Removed | — | `eval` (JS and Python; agents use `bun`/`python3` via `bash`), `lsp`, `debug`, devices, Mnemopi tools, `github`, `security_scan`, `prewalk`, `vibe`, advisor, autolearn, TTS/STT, collab, IRC, OMP TUI. |

### 8.2 Agent hub: `agents`, `jobs`, `proc`

OMP's `hub` combined three systems (`tools/hub/index.ts:1-16`). Our transcripts used `wait` 178, `logs` 64, `start` 44, `send` 43, `jobs` 40, `stop` 34, `restart` 24.

- **`agents`** (`spawn`, `send` steer/follow-up, `stop`, `list`, `status`): subagents are pi-durable conversations. Parking and reviving come free; there is no in-memory registry.
- **`jobs`** (`run`, `wait`, `list`, `logs`, `cancel`): background commands as durable tasks, executed by a machine's supervisor. Unlike OMP's in-process job manager, records survive restarts.
- **`proc`** (`start`, `logs`, `send`, `stop`, `restart`): supervised long-running processes, shared with terminals and services so agents and people see the same processes.
- **UI:** an Agent hub panel shows the task graph (`harness.taskGraph()`), subagent transcripts, jobs, and processes grouped by machine.

### 8.3 Subagents

Subagents remain task-owned conversations with background anchors and internal `agents.send` steering. User and device prompts target only the main conversation. The workspace has no conversation picker.

Inspector shows each child's bounded transcript, status, and the definition and model selection retained when it started. These views are read-only. A child's Stop aborts its subtree and background ownership tasks, then removes unanswered questions from that subtree. Main and sibling work continues. Main Stop still stops the whole tree.

### 8.4 Time-traveling stream rules (TTSR)

Rules keep OMP's frontmatter (`condition`, `astCondition`, `question`, `scope`, `agents`, `interruptMode`) so existing rule files keep working.

- **Tool-call rules** (`tool:edit(*.ts)` etc.): `beforeTool` hook with regex and ast-grep conditions; block and inject the rule. All three real hits in our transcripts were tool-call rules.
- **Judged rules** (`question`): `afterResponse`/`onYield` plus one batched Jev `classify()` per output; threshold as OMP (≥ 0.7).
- **Mid-stream text and thinking rules:** pi-durable has no streaming hook (`harness/types.ts:592-623`). Our provider wrapper sees every stream chunk; on a match it aborts the stream. pi-durable stores the partial as aborted and excludes aborted messages from later requests (spec §2.1), which is OMP's `contextMode: discard`. The rule is then steered in and the run continues. **[unverified]** how pi-durable's retry policy treats a provider-aborted stream; part of spike S1.

### 8.5 Checkpoint and rewind

OMP's tools are context tools: `checkpoint { goal }` marks the start of an investigation; `rewind { report }` drops the intermediate messages and keeps the report (`tools/checkpoint.ts`). In pi-durable, entries are immutable; rewind becomes a **context edit** that omits the span from the model's context while retaining it in storage (spec ~§2.1, heads and context edits). **[unverified]** that context edits can omit a middle span; spike S1. Combined with code snapshots (§9.3), a conversation fork can also restore the matching code state.

### 8.6 History search instead of memory

- **Index:** FTS5 over (1) compaction summaries and plan/goal documents, (2) user messages and final replies, (3) tool calls (paths, commands, errors). Workspace scope first, then project.
- **Tools:** `history_search(query, scope)` returns snippets with row references; `history_read(ref, around)` expands to raw rows (the existing MCP `gitspace_transcript_page` around-row selector).
- **Relevance gate:** on session start and when a cheap Jev check detects a topic change, run BM25 over notes, ask Jev per candidate (`relevant` score, `decision` bool, `conflict` bool), and attach the top notes to the user message (not the system prompt, to keep the cache warm) with dates and references. Log every inject or skip decision to measure precision.
- **Push memory:** user-visible workspace and project instructions and skills, with the agent proposing additions instead of retaining silently.

### 8.7 QA queue

- `report_issue` and a "Report" action on any transcript row or tool call create a **project QA item** with tool, model, runtime version, workspace, and a `history://` reference.
- A per-project QA inbox: dismiss, merge duplicates (Jev or keyword similarity suggests), **Send to GitSpace** (our product queue, with a redacted excerpt), or **Create issue** in the project's repo.
- Nothing leaves the project without a human action. OMP stores reports locally and pushes to `qa.omp.sh` only with consent (`tools/report-tool-issue.ts`); the 56 reports GitSpace agents filed could not be found on the machine afterwards.

### 8.8 Edit tools

No hashline. Each model gets exactly one edit tool, chosen by the format its vendor trains it on. The rule is data in `packages/catalog`; a profile can override it per model.

| Family (model ID, ignoring a `vendor/` prefix) | Tool | Evidence |
|---|---|---|
| OpenAI `gpt-4.1*`, `gpt-5*`, `gpt-6*`, `*codex*`, on any provider | `apply_patch`: Codex V4A patch (`*** Begin Patch`, `*** Update File: path`, context lines, `-`/`+`, no line numbers) | GPT-4.1 prompting guide: the family is "extensively trained" on V4A. GPT-5.1 ships `apply_patch` as a built-in Responses tool. It is Codex CLI's only edit tool. |
| Everything else: Claude, Gemini, Grok, Qwen, Kimi, GLM, DeepSeek, MiniMax, Mistral, open weights | `edit`: pi-durable's `path` plus `edits[]` of exact `oldText` → `newText` | Anthropic's text editor tool is `str_replace` (`old_str`/`new_str`); Gemini CLI's is `replace` (`old_string`/`new_string`); open models target Claude Code-compatible tools. |

- **Unlisted OpenAI models** (`o3`, `o4-mini`, `gpt-oss`) default to `edit` **[unverified]**; move them only on transcript evidence.
- **Transport:** `apply_patch` is a pi-ai grammar tool (`constrainedSampling: { type: 'grammar', variants: { openai_lark } }`). It goes out as a freeform custom tool when the model's catalog row has `compat.supportsOpenAIGrammarTools`. On pi.dev today that covers 25 of 42 OpenAI models (every GPT-5 and later), all 9 Codex models and all 13 GitHub Copilot GPT models. Everywhere else pi-ai falls back to a JSON function tool with one string input, so the model still writes V4A. OpenAI's built-in `{ type: "apply_patch" }` tool (OpenAI reports 35% fewer failures for the named tool) is not in pi-ai 1.0; adding it to our provider wrapper is a later measured change.
- **Implementation:** the shared protocol package owns the pure V4A planner. Cloud snapshot mutation applies it under the same publication queue as `write` and `edit`.
- **Model switches:** the tool set follows the active model at the next turn; earlier calls stay in history. S1 confirms that pi-durable accepts a changed tool set mid-conversation **[unverified]**.
- **Feedback:** QA metrics record edit failures per model, and the rule changes as data.

### 8.9 Plan mode, skills, rules, instructions

- **Plan mode:** a read-only phase extension (pi-durable example 27); plan file in `local://`; approval through the question card with an Open plan link.
- **Skills:** discovery, live refresh, `skill://` URLs, skill list as a system-prompt section.
- **Instructions and phase context:** system-prompt sections from workspace controls.
- **Approval modes:** `beforeTool` hook.
- **Titles:** a cheap-model call after the first turn.

### 8.10 Browser ownership and approval

Headless Chromium is the default source for tests, previews, scraping, and tasks that do not need the user's accounts. It runs locally on an attached executor and needs no browser approval in any mode. Subagents get headless only.

Only the main agent may explicitly request `source: relay` for a task that needs the user's signed-in Chrome session. Each workspace has one coloured tab group, named after the workspace. The agent sees and controls only tabs in that group. A user shares an existing tab by dragging it into the group and takes it back by dragging it out. The extension checks membership before every operation; no picker or per-tab lease remains.

Creating the group requires approval outside yolo and is automatic in yolo. Relay access uses the environment's approved host set (§10.9). Navigation, page actions, JavaScript, and screenshots within that set need no separate prompt. Redirects and page-initiated network traffic are not gated. Explicit agent navigation and actions are gated by the destination/current host.

A reusable signed grant binds the workspace, executing machine, attachment generation, tab group, approved origin set, and expiry. It does not belong to a conversation. Per-attempt authorization still binds the calling conversation and task; only the main conversation may use relay. The machine and extension verify signatures, group membership, and the current host. A machine switch invalidates old execution authority.

Relay navigation waits for Chrome's `Page.navigate` reply before starting its load budget. A reply with an error or download fails; a missing reply fails at the signed or dispatch deadline. After a successful reply, the relay waits for the matching main-frame load or same-document event. This load budget is at most ten seconds and reserves time before dispatch expiry to check the new document's host and group membership. A committed, approved page that has not finished loading returns `loaded: false` with its frame identity; a completed load returns `loaded: true`. Both results require those live checks. Signed expiry, revocation, disallowed hosts, and lost membership remain failures.

## 9. Code storage

### 9.1 Artifacts

Cloudflare Artifacts (open beta 2026-10-01; billing from 2026-10-14): git repos with Workers bindings for `create`, `import`, `fork`, `readFile`, `readTree`, `readBlob`, `log`, repo-scoped tokens, and event subscriptions. Limits: 1 GB per repo, 32 MB per file, 1 TB per account (raisable), git protocol v1/v2 for fetch, v1 for push, no `filter`.

Measured: inkibra-core 254 MB packed, gitspace-source 89 MB, deedible 59 MB, golconda 30 MB; no blob over 32 MB.

The owner's live check confirmed `readCommit`, `readTree`, `readFile`, `readBlob`, and `info`, plus snapshot publication on top of an existing snapshot. The new commit had the expected parent; source HEAD, index, and branch stayed unchanged; Git `ls-remote` saw the checkpoint ref.

Binding ref lookup differs from Git ref lookup. `repo.log({ ref })` accepts bare branch names and commit IDs. `repo.log()` without a ref reads HEAD's history. `HEAD`, `refs/heads/main`, `heads/main`, and custom checkpoint refs return an empty list even when the refs exist. Translate branch refs before binding lookup, use no-ref log for HEAD, and use the DO's stored commit IDs for snapshots. Never infer an empty repository from an unsupported ref query.

Initial checkpoints are published before the cloud runtime persists them or admits a cache. A populated fork already holds source commits, but does not yet have the new workspace's `refs/gitspace/spaces/<workspaceId>/checkpoints` ref. The checkpoint owner creates that ref at the initial branch commit through Git receive-pack; repeating initialization at the same tip is safe, while an advanced canonical ref is never rewound. Empty imported repositories publish their unborn snapshot graph instead. Native materialization can therefore fetch the advertised canonical ref without substituting a branch or relying on an earlier cloud edit to publish it.

The owner reran the unmodified Pass 10 check under Node 24 with fork `probe-fork-20261005035600-c`. Direct `ArtifactsCodeStore` checks confirmed full/bare branches, HEAD, feature branches, commit IDs, missing branches, `readFile`, rejected custom refs, and initial-checkpoint behavior. An existing matching-description scratch repository is now seeded only when no-ref history is empty, even if its requested branch is absent.

For Pass 12, the owner reports that the real-service lookup checks and live check still pass with fork `probe-fork-20261005035600-d`. These findings do not prove live R2 operation or tenant activation.

### 9.2 Layout

- **Namespace per tenant**, bound to the tenant Worker by the platform deployer alongside the tenant's R2 bucket.
- **Project creation:** the account creates a project in the cloud: authority, base workspace, and directory entry, with no machine. An import records its origin; without a base branch, the account reads the default branch a public remote advertises over smart HTTP, and asks for the branch when it cannot (a private origin). The project repo itself is created or imported when the first workspace runtime opens.
- **Project repo:** imported from the project's origin by the binding's one-shot `import`, which refuses private origins (`REMOTE_AUTH_REQUIRED`) and origins over its 40 MB limit (`MEMORY_LIMIT`). For those, the user opens the project on a connected machine. A machine that clones an imported project, at creation or first open, seeds the repository itself. Only the open holder of the project's base space can lease `project-<projectId>`; the Worker creates it empty, with no import and no initial commit. The machine publishes the base branch's full history in bounded packs before the base space's first checkpoint and never moves an existing branch. Until that branch exists, cloud runtimes report the import as pending and retry on the next request.
- **Workspace repo:** a fork of the project repo; machines receive short-lived write tokens for that fork only, minted by the Workspace DO.
- **Account storage ceiling:** all tenants share the platform account's 1 TB; request an increase before scale.

### 9.3 Snapshots and checkpoints

- **Snapshot:** immutable working-tree Git objects pushed to `refs/gitspace/spaces/<workspace>/checkpoints`. Each new snapshot parents the previous one. HEAD, index commit, and index tree carry over unchanged during cloud file edits; machine Git commands change them deliberately.
- **Unborn repositories:** `headCommit: null` means symbolic HEAD names a branch with no commit. The index snapshot has no parent; worktree snapshot commits remain concrete. Restore keeps that branch unborn and restores the worktree and index without a hard reset. Cloud edits, cache readiness, and machine handoffs use the worktree commit, not a fabricated HEAD. After the first real commit, the next checkpoint records its hash. GitSpace-created scratch projects start with a real initial commit; imported empty repositories need not.
- **Checkpoint:** continuous, incremental snapshots while working; shutdown only flushes the tail. This removes full uploads from the launch path.
- **Not in git:** ignored and machine-local files (`.env`, builds, `node_modules`, `.gitspace/local/*`) are recreated by `workspace/materialize`, as today.
- **Cloud writes:** `isomorphic-git` builds blobs, affected trees, commits, and packs under Worker `nodejs_compat`; bounded binding reads hydrate only required objects. A compare-and-swap Git receive-pack push extends the checkpoint ref. The Artifacts binding itself has no write API. A durable pending publication fences subsequent canonical updates until recovery resolves an uncertain push.

### 9.4 Git LFS

Artifacts stores LFS pointers, not LFS payloads. The owner's live `POST <remote>/info/lfs/objects/batch` returned 404. Each repository keeps its configured LFS remote: origin or `lfs.url` in `.lfsconfig`. Only a deliberate Git push invokes git-lfs's normal origin pre-push hook; snapshot publication never pushes LFS objects to origin.

Every pointer in a published snapshot must refer to an object stored off the machine. When capture sees committed objects not on origin, it uploads their payloads to the account's encrypted R2 LFS store, keyed by oid, once per oid. Uncommitted or staged content is never uploaded, including during a deliberate detach or move.

HEAD's `.gitattributes` decides which paths use LFS. Working-copy attribute edits cannot change that decision. Capture builds private index and worktree trees without changing the real index or working tree. It keeps a pointer only when the referenced object is already in R2 or positively confirmed by the origin LFS server. Otherwise it substitutes HEAD's pointer, or omits a path absent from HEAD. Deletes and renames of already-committed LFS files carry over.

The checkpoint stores each held-back path and its kind (`modified`, `added`, or `staged`), plus the object inventory needed for retention. Incremental capture publishes held-back metadata changes even when the sanitized Git trees do not change. Restore looks in the local cache, then R2, then the configured origin. Missing objects fail explicitly rather than leaving a successful checkout with dangling pointers.

Cloud file reads have an 8 MiB limit. They reject a larger LFS pointer before fetching its payload and return verified R2 content within the limit. An origin-only LFS file returns its size and a message that it needs a machine, not raw pointer text. Cloud write and edit refuse LFS-tracked paths because changing them needs a machine and a commit.

Objects and encryption keys are project-scoped. A durable machine inventory covers committed history, including deleted-file pointers. Its HEAD boundary prevents repeated history walks; forward scans exclude the saved ancestor, while a rewrite triggers one complete rescan. Batched publication protection checks object metadata without downloading payloads.

Origin ownership requires a successful authenticated LFS batch `download` response for the requested oid and size, with a download action. Native confirmation honors project Git credentials, Git URL rewrites, SSH `git-lfs-authenticate`, `lfs.url`, and committed `.lfsconfig`. Capture persists positive and negative classifications under a hashed route identity, so unchanged captures do not repeat origin requests. Failed receipt acknowledgements remain retryable. Local `refs/remotes/origin/*` never prove payload availability.

Later-push checks run outside capture. The machine checks at most 64 pending objects in one owned workspace per minute, rotating durable object cursors and workspace selection. Cloud retention checks at most 64 objects from one checkpoint per minute per project. Both paths use ten-second batch request deadlines. Private-origin checks stay on the machine; signed project-scoped receipts carry confirmation, not credentials.

Receipt endpoints omit userinfo, query, and fragment; the Worker rejects them independently. Hydration recovers machine-only URL credentials only when the configured route matches the clean confirmed endpoint. Query-authenticated downloads build the batch URL before adding its query, rather than letting git-lfs append the batch path inside the query. Download requests use only the server's download-action headers, never credentials copied from the origin request.

Machine hydration streams R2 and origin content to a temporary file beside the LFS cache. It rejects excess bytes immediately, then checks the exact size and incremental SHA-256 before an atomic rename. Failure or cancellation removes the temporary file. Cache checks, native smudge output, uploads, and worktree restoration also stream instead of collecting the full payload. R2 encryption retains the existing 32 MiB chunk format; ciphertext reads stop at the expected chunk size plus framing, and authenticated inventories have a separate byte limit. The machine and Worker verify the complete plaintext identity as the stream ends.

In-use roots include current runtime and portable checkpoints, active attachment checkpoints, pending publication predecessors, and unacknowledged retention outboxes. Closed but restorable workspaces retain their roots; historical rows alone are not roots. The DO validates the cache generation and predecessor before admitting a publication. It commits the accepted merged checkpoint and retention outbox together. The outbox retains the snapshot before releasing the exact uploader's publication pin. Portable acceptance uses the same order. Recovery needs no machine response or cleanup call, and keeps pending predecessors rooted until acknowledgement.

An external-origin project can evict R2 only after positive origin confirmation and durable source transition of every affected snapshot. Origin metadata retains the confirmed endpoint, so later `.lfsconfig` changes do not misattribute ownership to a new server. Immutable portable manifests use an authoritative project source overlay at restore. Without an external origin, every object reachable through any branch or tag in canonical project/workspace Artifacts repositories remains protected. Unavailable inventory fails closed. Objects exclusive to archived/deleted workspace snapshots become eligible once attachment and publication pins are gone.

Collection reconciles snapshot owners before its two-phase delete. A deletion marker fences new publications until object deletion and registry removal finish; publication pins never expire on a timer. Concurrent upload losers delete only their own randomized chunks after authenticating the winning manifest, never another publisher's chunks.

Inspector's working comparison labels held-back paths **Only on this machine** and shows **LFS changes leave this machine only after a commit** above the list. These facts come from the saved checkpoint and remain visible offline. Move and deliberate-detach confirmation lists the paths and offers **Commit first** or **Continue without them**. After a move, the agent receives the paths restored to committed versions or omitted because their uncommitted changes stayed on the previous machine. There is no permanent header or sidebar LFS indicator.

The opt-in Artifacts check runs under Node 24, not Bun: Wrangler's remote-binding proxy hangs under Bun. Repository handles use explicit disposal compatible with both workerd and the proxy. The check uses supported binding ref forms and verifies the published checkpoint ref through Git with a short-lived read token. It does not test R2 LFS storage. Offline help is safe; a live run still needs separate owner authorization and retains its disposable fork for owner-directed cleanup. Failure reports include a scrubbed reason, never tokens or credential-bearing URLs.

### 9.5 jj (Jujutsu)

Evaluate at level 2, not before: the working copy as a commit, stable change IDs, stored conflicts, and an operation log would simplify snapshots, merges, and code rewind. Blockers to check first: LFS support **[unverified]**, agents knowing git rather than jj.

## 10. Environments

Environment scripts keep their format and semantics; every run requires a machine. GitSpace never creates a machine to run them.

### 10.1 What stays the same

`.gitspace/bundle.json` (profiles, checks, secrets, values), `.gitspace/lifecycle/<phase>/NN-name[.<profile>].sh`, interactive scripts (`# gitspace: interactive`), `.gitspace/services.json`, approvals by script content hash, bindings via `$GITSPACE_LIFECYCLE_OUTPUT`, secrets materialized per run and redacted from logs, 30-minute deadlines, and never re-running shell effects.

### 10.2 Scopes

| Phase | Scope | Runs on |
|---|---|---|
| `machine/prepare` + `checks` | per machine × profile | every machine that executes for the workspace |
| `cloud/provision`, `cloud/destroy` | per workspace, once | the workspace execution machine by default, or an allowed machine chosen with `on` |
| `workspace/materialize`, `workspace/dematerialize` | per working copy at a commit | the machine holding that copy |
| services | per working copy | the selected execution cache |

### 10.3 Execution

`LifecycleRun` tasks replace the claim/journal protocol: accepted (approval check) → dispatched to machine M with a claim token → running (logs streamed) → finished (result, bindings). The machine's supervisor replaces OMP's daemon broker and keeps the local journal. Interactive runs stream browser ↔ DO ↔ machine PTY; agents never see interactive I/O.

The agent environment schema excludes `interactive` and `cloud/destroy`. Human lifecycle requests retain both. The same agent dispatch schema governs admission, machine parsing, cancellation, and recovery; `on` and `at` belong to dispatch selection rather than the lifecycle request passed to the local manager.

### 10.4 Definitions come from a commit

The DO reads `bundle.json` and scripts from Artifacts at a ref, so the Environment view works without a machine. Runs pin the commit and script hashes. Edits to scripts take effect at the next snapshot.

### 10.5 Runners

`jobs.run` on a runner resolves prerequisites as child tasks: prepare and checks for the profile (skipped when recorded for the same script hashes), checkout and materialize at the commit (skipped when that copy is already materialized there), then the job. Profiles double as capability requirements (`on: { profile: "ios" }`). Optional `inputs` per materialize script (e.g. lockfiles) skip reruns when unchanged.

### 10.6 Secrets and machine trust

Secrets stay sealed in the cloud and are materialized per run. New: grants on secret × machine label, checked before dispatch; a run needing a secret its target machine is not trusted with is routed elsewhere or refused.

### 10.7 Agent surface

`environment` tool: `get` (works without a machine), `setProfile`, `putValue`, `runChecks`/`runPhase` with `on`, `log`, `cancel`. Embedded agents still cannot approve, run `cloud/destroy`, or see interactive I/O. Separately authorized whole-account API/MCP keys with Write and `lifecycle.control` may approve execution content and browser origins through `environment.approve`.

### 10.8 Open questions

- Shared cloud resources across copies (inkibra's preview): default shared through bindings, per-copy opt-in later.
- Fixed ports (golconda) collide when two copies share a machine.
- Clean-up of runner copies and how long warm copies are kept.

### 10.9 Browser origin grants

Bundle version 1 accepts `browser: { "origins": ["github.com", "*.cloudflare.com"] }`. Entries are host names, host patterns, or `"*"`, never URL paths. The Environment tab shows each entry beside scripts and checks. Browser definitions come from the recorded Git HEAD, not dirty working-tree or index content; before the first checkpoint, the canonical workspace branch supplies that commit.

Each origin is an independent, domain-separated content-hash item in the existing `LifecycleApprovalSchema` ledger. Existing per-user lifecycle-control authority approves or revokes it. Whole-account API/MCP keys with Write and `lifecycle.control` may approve browser origins; this is intended authority, not a browser-only action. Adding one entry asks only about that entry. Removing it drops its workspace-scope approval; removing it on base also drops the project-scope approval. Re-adding an entry does not restore those approvals. Ordinary environment configuration and yolo cannot manufacture an origin approval.

Project-scope approval on the base workspace applies only where a workspace's committed bundle lists that origin. Branches created before base added an origin inherit the grant once they merge or rebase base and include the entry. An entry found only on a branch gets workspace approval, not project approval. After merge, the user or an authorized lifecycle-control API/MCP client may approve it on base for project-wide use. The agent proposes an edit to `.gitspace/bundle.json` when it needs a missing host; even in yolo, that new item needs lifecycle-control approval before it grants access.

### 10.10 Terminal environment

Bundle version 1 accepts an optional `terminal: { "path": ["node_modules/.bin", "~/.cargo/bin"], "env": { "NODE_ENV": "development" } }`. Path entries are checkout-relative or `~/`-relative, never absolute or escaping; they lead `PATH` in order. `env` holds plain values and cannot set `PATH`, `GITSPACE_*`, secret-like names, or declared values and secrets. `terminalEnvironment` in `protocol-environment` resolves it purely; machines apply it to agent bash commands, declared services, and workspace terminals, reading the checkout's own `.gitspace/bundle.json`. A missing or invalid bundle adds nothing.


## 11. Machines, supervisor, terminals

### 11.1 Supervisor

Replaces OMP's launch broker, which GitSpace uses today for every terminal, service, and lifecycle run (`workspace-hub.ts`, `terminal-worker.ts`; ~2.7-3k lines of OMP code: `broker.ts`, `client.ts`, `protocol.ts`).

- Process model per machine: start/list/describe/wait/send/stop/restart; PTY (Bun's native `Bun.spawn({ terminal })`, verified on Bun 1.4) and pipe processes; owners; readiness by log pattern or port; restart policies; rotating capped logs with cursors.
- Serves user terminals, services, lifecycle runs, agent jobs, and agent processes with one model.
- Independent of agent execution, so processes survive agent restarts.

### 11.2 Attachments and execution machines

- The DO owns the shared working copy. Every normal attachment is an equal local `cache` that follows the cloud, with no writer lease. A `runner` stays pinned to an immutable source; a `delegate` remains branch-isolated.
- A machine attaching runs `machine/prepare` + checks for the workspace's profile, then checks out or fetches its copy.
- The UI groups terminals, services, and environment state by machine.
- Automatic reclaim pauses when uncommitted LFS changes remain local. The machine row shows the blocked paths. Manual reclaim and detach require a fresh choice to commit first or continue without those changes; consent belongs to that request.
- Cleanup publishes its final checkpoint once, against the accepted predecessor, before removing the checkout. Reclaimed caches can resume. Explicit detach ends in `detached` and removes the machine row.
- Heartbeats expire after 30 seconds. Header and machine rows update without waiting for another runtime snapshot; offline status takes precedence over setup state.
- Each assignment fails alone. Work on one checkout stays serialized while other checkouts proceed. A failure is recorded on its attachment and reported with the heartbeat (operation, message, attempts, next retry); the machine retries the same request with capped exponential backoff and clears the failure once the operation succeeds.
- Setup, materialization and drain renew the attachment lease with a progress heartbeat every 20 seconds while they run, not only on phase transitions.
- `lost` is terminal. The machine stops every process in that checkout and stops following it. A cloud sandbox removes the checkout it acquired; a computer keeps it and records it as orphaned. A live local attachment missing from the machine's assignment list is treated as lost.
- The final drain checkpoint protects LFS objects under its own publication, named by its checkpoint ref like every incremental capture. Only capture holds a publication; restores read without pinning.
- Every live attachment is a lease with a `deadlineAt` the cloud computes from its state and machine kind (`ATTACHMENT_LEASE_MS`). A cloud sandbox gets 20 minutes of setup or materialization and 10 minutes of drain since its last reported progress, and 5 minutes since its last heartbeat while ready or parked. A paired computer gets 24 hours of setup or drain and is never lost for heartbeat loss alone. Only progress renews setup and drain; resending an old progress time does not.
- The workspace authority's alarm forces each expired lease to `lost` (`lossReason: 'deadline'`). It also audits fleet membership at least hourly: an attachment whose machine left the fleet becomes `lost` as `machine-destroyed` (tombstoned) or `machine-revoked`. Every sweep logs one `Runtime lease sweep` line (attachments examined, lost, deadlines started, missing machines, failures).
- A machine's kind is recorded the first time the cloud sees it in a sweep, admission or heartbeat; until then its leases use the computer windows. Recording a kind keeps when each lease started, so a cloud sandbox's overdue lease expires at once. A workspace whose runtime opens with rows written before leases, or with machines of unrecorded kind, sweeps itself immediately.
- `lost` releases everything the attachment held: the shared-checkout barrier (the same machine may attach again), its unresolved executions (they end `interrupted`), a pending cache action (it fails), and any lifecycle run claim it owned (it ends `interrupted` without a human abandon).
- Before release, the cloud settles the snapshot publications the machine admitted. One in flight finishes. One left durably pending resumes. One the provider proved unpublished is abandoned, so no late finish can advance the canonical snapshot. One of unknown outcome keeps the writer fenced and keeps recovering. The reason is recorded as the lost attachment's `failure`.
- Destroying or revoking a machine marks its attachments in every workspace `lost` before its credentials are removed. A one-time fleet backfill sweeps every workspace for attachments of machines removed before leases existed.
- Dispatch, the agent's `machines` list, and service listings exclude `lost` attachments and attachments not heard from within 30 seconds.
- Every cloud sandbox provider call has a deadline (`SANDBOX_PROVIDER_DEADLINE_MS`): 30 seconds for status and cancel-replacement, 2 minutes for sleep and destroy, 3 minutes for create and resume, 10 minutes for prepare-replacement (a full workspace checkpoint); image calls get 30 seconds for status and default, 2 minutes for discard, 5 minutes for a switch, 10 minutes for prepare. A call past its deadline fails, and the failure is recorded on the machine as its `error`.
- A machine power transition (stop, start, destroy) is a lease (`MACHINE_OPERATION_LEASE_MS`, 20 minutes, longer than its slowest chain of provider calls). If the row still carries that operation id when the lease lapses, for example because the request died, the fleet alarm settles it: the provider's observed state if it answers, otherwise `error`, with "operation timed out" recorded and the operation id cleared so the user can retry. Provisioning keeps its own attempt lease. In Settings, a pending action blocks only its own machine.

### 11.3 Multi-machine levels

| Level | Machines do | Consistency |
|---|---|---|
| 1 | Cloud file tools and human cache edits update one snapshot chain; programs execute on synchronized caches or pinned runners | Three-way delta merge, durable bases, visible conflict paths |
| 2 | Delegated subagents work on their own branch, possibly on another machine, and return commits; a `Merge` task integrates | git merges; conflicts become agent tasks |

## 12. Inference and credentials

### 12.1 Models and providers

- `pi-ai` `Models` constructed with only our providers; each provider is a GitSpace wrapper that resolves credentials from the vault.
- Missing providers (Cursor, Antigravity, Gemini CLI): port as our own `Provider` objects or drop; decide per usage.
- Model roles stored in `pi.agent` per conversation; profile revisions apply on the next request (no worker restarts exist).

### 12.2 Credential vault

| Piece | Plan |
|---|---|
| Vault DO, leases, profiles, assignments | Unchanged |
| OMP broker wire types (`SnapshotResponse` etc.) | Our own schemas in `@gitspace/protocol` |
| Token refreshers (Anthropic, Codex, Cursor, Antigravity, Gemini CLI) | Our own package, lifted from the `pi-ai` patch; use `pi-ai` 1.0's own OAuth where it runs on Workers |
| Broker client and managed-inference guard | Removed under option B: the provider wrapper gets tokens over DO RPC; credentials never leave Cloudflare |
| Login flows | Run in the vault DO: GitSpace's own flows (Anthropic, Codex device code, Cursor, Gemini CLI, Antigravity) and `pi-ai`'s provider flows (OpenAI Sign in with ChatGPT, Copilot, OpenRouter, xAI, Kimi, Meta). Loopback-redirect flows (Sign in with ChatGPT: `http://127.0.0.1:1455/auth/callback`) finish by pasting the callback URL; Anthropic shows a code to copy. |

The GitSpace-owned flows use client-registration metadata vendored in `packages/provider-auth/src/catalog.ts` from OMP's `pi-catalog` 18.2.11, with its MIT attribution preserved in the package license. There is no runtime catalog-package dependency; only the four required client registrations are retained, and Cursor's custom flow needs no client-registration metadata. Further adoption of Pi OAuth must preserve cloud login state, refresh safety, and provider coverage. In particular, legacy Codex device-code credentials and Pi's working OpenAI Sign in with ChatGPT route are not interchangeable (§12.3); vendoring does not change or remove either route.

Legacy `openai-codex` is disabled in provider/model admission and for new cloud sign-ins; profile overrides cannot re-enable it. The device-code polling implementation, pending-flow completion, and existing credentials remain intact for the later one-time migration or a future deliberate re-enable. Stored accounts can still be inspected and managed, but are not offered as an available inference provider. The separate `openai` provider keeps both Sign in with ChatGPT and API-key support.

**Idea (not planned): browser-extension callback capture.** The GitSpace browser extension could watch for a navigation to a loopback callback (`127.0.0.1:1455/auth/callback?…`) while one of the account's sign-ins is pending, check its `state` against that sign-in, and forward the URL to `providers.login.respond`, removing the paste for loopback providers. Copy-paste stays the fallback.

### 12.3 Egress placement

Model calls from the runtime DO work (verified on lightbeam, 2026-10-08). OpenAI's ChatGPT web backend (`chatgpt.com/backend-api`, used by Codex device-code accounts) blocks some Cloudflare egress addresses with its "Unable to load site … VPN" page: one workspace runtime failed repeatedly from `2a06:98c0:3600::103` while another succeeded. Sign in with ChatGPT tokens target `api.openai.com/v1` instead; device-code tokens cannot (OpenAI drops `chatgpt.tokens.use.direct`, and the API refuses them for missing `api.responses.write`). The usage endpoint (`chatgpt.com/backend-api/wham/usage`) also returned 403 from the vault DO on 2026-09-22 (`provider-auth.ts:484-486`).

- Default: cloud egress for every provider.
- Fallback per provider: machine egress, where the DO sends the request to an attached machine that streams the response back; the machine receives only a short-lived access token.
- Usage checks stay machine-side until a Worker request with the machine's exact headers is tested.
- Test first (spike S0): one streamed Codex request and one usage request from Cloudflare egress.

### 12.4 Model catalog

The catalog is data loaded at runtime: no generator of our own, no sync service, no launch.

- **Source:** Pi's published catalog, one JSON document per provider at `https://pi.dev/api/models/providers/<id>?types=chat,image,classifier`. Today openai has 44 models (28 KB), anthropic 16 (10 KB), amazon-bedrock 180 (87 KB). Pi's CI rebuilds it from models.dev and provider model lists hourly on weekday mornings (UTC). Responses carry `ETag` and `Last-Modified`; revalidation returns 304.
- **Loading:** pi-ai's `Provider` contract already does this: `refreshModels(context)` persists through a `ModelsStore` (`read`/`write`/`delete` per provider; entry `models`, `etag`, `lastModified`, `checkedAt`). `runtime-core` wraps each built-in provider: the bundled models are the floor, the stored document overlays them when it is newer, and it is revalidated when older than 4 hours. The Workspace DO implements `ModelsStore` on its SQLite storage. Pi's own wrapper (`withRemoteCatalog`, coding-agent) is not exported and pulls Node-only config (`fs`, `os`), so `runtime-core` carries an equivalent of about 100 lines on the pi-ai contract.
- **Overrides are data too:** `packages/catalog` JSON, validated by its zod schema, applied after the catalog: hidden models, Bedrock `us.`/`global.` inference profiles, display names, cost fixes, the edit-tool rule. The profile's own provider configuration applies last.
- **Removal:** a model that disappears upstream falls back to the role's default model with a transcript notice.
- **Independence:** if pi.dev becomes unreliable, point `catalogBaseUrl` at our own copy of the same documents (Pi's MIT generator, `packages/ai/scripts/generate-models.ts`, run on a schedule); nothing else changes.

### 12.5 Judge

A classifier role defaulting to TypeSafe Jev (available through `typesafe`, `openrouter`, `cloudflare-workers-ai`, `vercel-ai-gateway`, `opencode`), with a cheap chat model as fallback. Used by judged TTSR rules, history relevance, stuck-run detection, and QA deduplication.

## 13. UI

- **State sync:** Chord replicated state over the relay for workspace, agent, task, environment, and terminal state: snapshot, then ordered deltas, `reset` on overflow. Replaces `fact_events` projections and per-feature resync for these domains.
- **Machineless views:** transcript, documents, code, environment, QA from the DO.
- **New surfaces:** Agent hub panel, machines view, QA inbox, per-machine terminals and services.
- **Drafts:** send carries the sending device's observed draft revision and the exact draft text it sent. The accepted send clears that revision, or a newer draft only when the sending device itself saved exactly the sent text (its in-flight save). Another device's draft or different text is never cleared, and a late save of the sent text never refills the composer. Discard makes one revision-checked clear; a conflict adopts the newer cloud draft without retrying an empty edit.
- **Agent setup:** the main cloud session reads committed definitions from `.agents/agents/*.md` and the supported legacy `.omp/agents/*.md` location. The frontmatter `name`, or filename when absent, identifies each agent. For duplicate names, `.agents/agents` wins regardless of discovery order; Inspector names both paths in a diagnostic. Save keeps a revision-checked cloud override for the same path and future starts; it does not write or commit a repository file. Existing children keep their retained definition.
- **Usage:** recorded root and descendant token and cost totals remain available without machines. Provider account limits and their refresh stay separate from session cost.
- **Services:** Inspector lists declared services and agent processes across caches. Running services offer Stop, Restart and Logs; stopped or failed services offer Start and Logs. Starting, restarting and stopping services show progress and offer Logs only. Offline machines show the reason and disable service controls. Actions target an exact machine, attachment and generation. Private URLs include the machine identity and use the existing cookie-bound service login.
- **Files:** Inspector's file tree, status and file reads for a cloud workspace come from its committed cloud checkpoint (HEAD, index and worktree trees in Artifacts), never from a machine holding a legacy placement. Modes compare the same pairs as on a machine; untracked means present in the worktree but not the index. File reads follow the cloud `read` limits: 8 MiB, LFS pointers hydrated from cloud LFS storage or refused with a machine hint. Diffs are not served in the cloud yet and return an explicit error.
- **Subagent identity:** Inspector uses the requested spawn name, then the retained definition name, then the role. Generated messaging addresses remain unique. Older records retain their saved address as the display name. Role and model have explicit labels; definition revisions show eight characters with the full value available on hover and copy.
- **Creation progress:** long creation calls keep streaming progress instead of failing the request (the UI currently reports "request timed out" while creation succeeds).
- **Source:** Settings → Source and the sidebar read deployment status and revert from the account, never from a machine. Every fleet machine is listed alike (no "home" machine); the fleet has converged when every current machine runs the selection, so a fleet with no machines has converged. The machine building a launch reports each phase to the account, which keeps the latest launch for every browser.
- **Onboarding inference:** the Default inference step cannot finish until a provider is connected and the Default model role names one of that profile's authenticated models. It never picks a model; once a provider connects with no Default, it opens the Models tab.

## 14. Migration and cutover

- **Runtime per workspace:** a workspace setting `runtime: omp | pi`, switched at a session boundary. New workspaces default to `pi` once milestone M6 is met.
- **Existing transcripts:** OMP JSONL stays readable through the current transcript index; no conversion of history into pi-durable.
- **Data domains move one at a time** (creation, checkpoints, environment runs, crons, jobs, QA), each deleting its hand-built predecessor when it lands.
- **OMP removal:** when no workspace runs on OMP, delete `account-omp`, the OMP patches, `pi-natives`, and OMP-only code paths.

## 15. Milestones

Each milestone ends with its exit criteria demonstrated on Darktop and recorded as Goal evidence.

| ID | Milestone | Exit criteria |
|---|---|---|
| **M0** | Decisions and spikes | S0: Codex model and usage request from Cloudflare egress. S1: pi-durable + Chord + `pi-ai` in a DO: one conversation, one tool call over the relay, CPU per turn and per commit, Worker bundle compatibility, provider-aborted stream behaviour, context edits omitting a span, tool set changed mid-conversation. S2: Artifacts import of inkibra-core, fork, clone/push timings, snapshot to a private ref, `readFile` from a DO, LFS answer, WalGit comparison. Go/no-go for option B. |
| **M1** | Runtime core | Workspace DO hosts a Session; vault-backed providers with the catalog overlay on DO storage; machine attachment and routing for `read`/`write`/`edit`/`apply_patch`/`bash`/`grep`/`find` with the edit-tool rule; relay transport; kill-and-resume tests for DO and machine. |
| **M2** | Agent parity | `todo`, `ask`, plan mode and approval, skills, rules (tool-call and judged TTSR), `space_*`, MCP via `pi-mcp`, `local://`, cloud WorkerLoader codemode, web search, images, titles, QA reporting, history search. Real-model test suite equivalent to today's `account-omp` suite. |
| **M3** | Supervisor and environments | Supervisor replaces the OMP broker for terminals, services, lifecycle runs; `LifecycleRun` tasks; environment definitions from commits; `jobs`/`proc`/`agents` tools; Agent hub panel. |
| **M4** | Workspace operations | `CreateWorkspace` and `Checkpoint` tasks on Artifacts; continuous snapshots; launch no longer blocks on uploads; crons as tasks. |
| **M5** | UI on Chord and machineless | Workspace, agent, task, environment, terminal state via Chord; machineless repository read/edit/write and conversation; creation progress streaming. |
| **M6** | Default runtime | New workspaces use `pi`; one week of daily use without Recover; mid-stream TTSR in the provider wrapper. |
| **M7** | Remove OMP | No workspace on OMP; `account-omp`, OMP patches, `pi-natives`, broker client, and OMP-only paths deleted. |
| **M8** | Multi-machine level 1 | Read-only runners with prerequisites, machine selection, machine trust for secrets. |
| **M9** | Multi-machine level 2 | Delegated subagents on branches and machines with merge tasks; jj evaluation. |

## 16. Testing

- **Kill tests:** kill the DO, the machine, and the relay mid-turn, mid-tool, and mid-environment-run; assert resume behaviour and no re-run shell effects.
- **Storage conformance:** pi-durable's `registerStorageConformance` for any storage adapter we write.
- **Real-model tests:** the existing local OpenAI-compatible server approach from `account-omp` tests, against the new runtime.
- **Golden transcripts:** recorded multi-turn sessions replayed for regression of tool routing and TTSR.
- **Load:** CPU per turn and commit in the DO under a tool-heavy session (~840 reads).

## 17. Risks

| Risk | Mitigation |
|---|---|
| pi-durable is experimental | Exact pins; Pi imports only in `packages/runtime-*`; conformance and kill tests gate upgrades. |
| DO CPU limits and cost | Measure in S1; keep heavy work on machines; option A fallback. |
| Worker bundle compatibility (Chord's esbuild path, Node-only code in `pi-ai`) | Verified in S1; keep Node-only modules out of the DO import graph. |
| Provider refusal of Worker egress | S0 matrix; per-provider machine egress fallback. |
| Artifacts beta, limits, no LFS | S2; own LFS server; WalGit kept until replaced. |
| Shared 1 TB account Artifacts ceiling | Request increase; per-tenant usage monitoring. |
| Storage growth (append-only Session) | Measure in S1; retention policy for finished operational tasks **[unverified]** in pi-durable. |
| Two-owner handoffs (option A only) | File lock plus close deadline plus kill. |
| Losing Python eval, LSP, debug | Deliberate; revisit only with usage evidence. |

## 18. Type system

The rules live in the repository skill `.agents/skills/type-system` (adapted from inkibra core's skill to zod, `better-result`, result-rpc and tsgo; also linked from `.claude/skills`). Every new package in §5.4 follows it strictly; existing packages adopt it where they are touched. This section records only how the runtime applies it.

### 18.1 Owners in the runtime

| Contract | Owner | Consumers |
|---|---|---|
| Machine↔DO frames, placement selectors, Chord service declarations | zod schemas in `protocol-runtime`; types via `z.infer` | `runtime-*`, `supervisor`, and the web app import them; nobody restates a shape |
| Pi types (`Model`, `AssistantMessage`, `ConversationId`, `TaskId<T>`, document and task tokens) | Pi packages, imported only by `runtime-*` | Use the tokens; never cast `snapshot()`/`outcomes()` results |
| Tool parameters | The canonical zod schema in `protocol-*`, or the existing owner package | Registration derives JSON Schema; runtime execution parses with that same owner schema |
| Tool descriptions | Applicable OMP 18.2.11 prompts adapted to supported GitSpace operations | Registration regressions reject generic descriptions and untyped parameter envelopes |
| Catalog overrides and edit-tool rule | Override schema in `packages/catalog` | `runtime-core` provider wrappers |

### 18.2 Identities and states

- **Branded IDs** (zod `.brand()` at the owning schema): `WorkspaceId`, `ProjectId`, `MachineId`, `RunId`, `SnapshotRef`, `CatalogRevision`, plus Pi's own `ConversationId`/`TaskId`.
- **Discriminated unions:** placement checkout (`shared | snapshot | branch`), egress (`cloud | machine`), lifecycle run status, attachment role, task phases.
- **Real ingress** (`unknown` allowed, parsed once): relay frames, RPC bodies, DO RPC from other Workers, DO SQLite rows, Artifacts file reads, environment bundles, catalog shards, provider responses. Pi validates tool arguments itself.

### 18.3 Errors at the Pi boundary

- Expected failures are `better-result` `TaggedError` values that serialize to the domain failure schemas (`AgentFailure`, `WorkspaceFailure`, and a new `RuntimeFailure` in `protocol-runtime`).
- A tool's `execute()` turning a failure into an error result for the model is a deliberate mapping in the tool adapter; task phases record failures as task outcomes. Neither throws internal errors through Pi.

### 18.4 Type tests

New packages keep `src/**/*.typecheck.ts` files, compiled by `bun run typecheck:packages`, with a positive and a forbidden (`@ts-expect-error`) case for: brand separation, placement and egress unions, document and task token inference, tool parameter inference, and protocol schema ↔ tool schema agreement.

## 19. References

- Pi 1.0: `earendil-works/pi` v1.0.0: `packages/durable/README.md`, `packages/durable/docs/spec.md`, `packages/chord/README.md`, `packages/server/README.md`, `packages/coding-agent/docs/{codemode,cli,models}.md`.
- OMP 18.2.11 sources referenced: `tools/hub/*`, `async/job-manager.ts`, `tools/checkpoint.ts`, `tools/report-tool-issue.ts`, `export/ttsr.ts`, `session/ttsr-coordinator.ts`, `capability/rule.ts`, `launch/*`, `judgment/index.ts`.
- Pi catalog and tools: `.github/workflows/publish-model-catalog.yml`, `packages/ai/scripts/generate-models.ts`, `packages/ai/src/{models,models-store,types}.ts`, `packages/coding-agent/src/core/{model-runtime,remote-catalog-provider}.ts`, `packages/durable/src/tools/edit.ts`.
- Edit formats: OpenAI GPT-4.1 prompting guide (V4A `apply_patch`), "Introducing GPT-5.1 for developers" and the GPT-5.1 prompting guide (`apply_patch` tool), Codex `codex-rs/apply-patch`; Anthropic text editor tool docs; Gemini CLI file-system tools docs.
- OMP Rust rewrite: `can1357/oh-my-pi` branch `omp2`, `README.md`, `PHILOSOPHY.md`, `scripts/gen-npm-packages.py`.
- Cloudflare Artifacts: changelog 2026-10-01; docs `artifacts/api/workers-binding`, `platform/limits`, `platform/pricing`, `api/git-protocol`.
- GitSpace code: `account-machine/src/{workspace-environment,workspace-hub,workspace-services,protected-lifecycle,provider-auth,omp-runtime,session-coordinator}.ts`, `account-worker/src/{application,project-environment,project-secrets,providers}.ts`, `platform/src/{index,deployer,tenant-deployments}.ts`, `protocol-environment/src/{schema,lifecycle}.ts`, `sandbox-worker/src/index.ts`.
- `.agents/skills/type-system` in this repository, adapted from inkibra core's `skills/type-system`.
- Related docs: `docs/INFERENCE-PROFILES-DESIGN.md`, `packages/docs/src/workspace-lifecycle.mdx`, `docs/FLEET.md`.
