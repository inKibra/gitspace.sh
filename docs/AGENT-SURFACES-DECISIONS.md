# Agent Surfaces — Plan & Decisions

The consolidated decision record + build blueprint. Companion to `AGENT-SURFACES-DESIGN.md`
(the original architecture/block vision). The mock `agent-surfaces-app/` is the living visual spec.
**Updated:** 2026-06-25

---

## 1. Architecture decisions (storage · registry · compute)

### 1.1 Storage — Cloudflare Artifacts as the canonical store
- **`.gitspace/artifacts/` is a Cloudflare Artifacts repo** — git-compatible, versioned
  storage for agents (create repos on demand, fork, standard git protocol, Workers binding).
- **Unified, symmetric layout: base ≡ workspace.** Same `.gitspace/artifacts/` tree
  everywhere; the only difference is **which branch** is mounted (`main` for base,
  `ws/<name>` for a workspace). The old asymmetry (project `goals/` vs `workspace/<ws>/`)
  collapses — chains/planned-goals are just artifacts on `main`; a workspace's goal is
  the same path on its branch.
- **Machines mount via ArtifactFS** — a FUSE driver that does a blobless clone
  (`--filter=blob:none`) then lazily hydrates file contents on read (`git cat-file --batch`).
  Fast cold-start, no full clone. Runs on the **machine** (host/container) — *not* in Workers.
- **Mount point is exactly `.gitspace/artifacts/`.** Its sibling **`.gitspace/runtime/`**
  (ports, locks, dev identity, scheduler state) is **machine-local, never synced**.
- **Roll-up = `git merge ws/<name> → main`** in the artifacts repo (clean because paths
  are identical across base/workspace; reviewable as a PR).
- **Chain/stack alignment = real git status** (`aligned / needs-rebase / dirty-worktree /
  missing-branch / missing-workspace` are literal ancestry/rebase status), not synthetic.
- **Two parallel git layers**: the **source repo** (code; today's worktrees) and the
  **artifacts repo** (`.gitspace/artifacts/`). Keep branch names in **lockstep** (`ws/foo`
  in both). Shipping a workspace = merge **both** branches → main.
- **One gitignore**: in the source repo, `.gitspace/` is a mount → a single ignore line;
  versioning lives in the artifacts repo, not the source repo.
- **Worker-backed read-only viewer** (share / view on the go): a Worker reads the artifacts
  repo via the **Workers binding / REST / git** (read token), *not* ArtifactFS (no FUSE at
  the edge). Lists trees + reads files at any branch/commit, renders block-composed artifacts
  through the shared **block registry**, and **shares via scoped read tokens + a URL**.
- **Capability write-scope = scoped Artifacts tokens** (a trigger gets a write token limited
  to its repo/paths → the "may write X" capability is *enforced by the token*). Side-effects
  beyond data (email/deploy) still need machine-level enforcement.

### 1.2 Block registry — one registry, tiered
- A **block** = a typed, schema-validated unit of *agent-authored content*; React renderer;
  unknown type → markdown fallback. It is **not** chat-specific — it's the universal content
  primitive.
- **One registry** renders the **live transcript**, the **persisted artifacts**, *and* the
  **Worker viewer**. Chat is the *live* lens; an artifact is the *saved* lens; same blocks.
- **Tiers:**
  - **transcript** (the "chat things"): `message` (user/assistant markdown), `thinking`,
    `tool-call` + `tool-result`, `agent-node`, `error`.
  - **interaction**: `verdict-chip`, `approval-gate`/permission, `annotation-thread`, send-to-agent.
  - **structural**: `run-graph`, dataflow.
  - **content**: `code`, `diff`, `file-tree`, `callout`, `evidence`, `data-structure`,
    `code-ref`, `guide`, `mermaid`.
- **tool-call/result are container blocks that nest content blocks** (bash→code, edit→diff,
  screenshot→image, search→file-tree). A `diff` renders identically in a live tool result, a
  review guide, or a saved recap — because it's one block type.
- **Schemas: React-free + zod** (new dep) so the agent/server can author *and validate*; a
  **catalog endpoint** lets the agent learn the vocabulary. (Today: none — schemas are plain
  TS interfaces in `src/types/`; the mock's `src/blocks/` is the only block infra and renders
  the goal doc + workflow, while chat has a *separate* ad-hoc `ChatItem` renderer. Unifying
  chat into the registry as tier-0/1 = design-doc steps 1→2, replacing xterm scrollback.)
- **NOT blocks**: app chrome (sidebar, Cmd-K, settings, inbox, taskbar); **mini-apps/
  dashboards** (`.gssh.html` = sandboxed iframe app, its own runtime); raw `data/*.json`.

### 1.3 Compute · relay · crons
- **Relay = pure E2E router** — cannot decrypt/compute. (A CF Worker/DO relay is parked.)
- **`machine serve` = all compute** — PTY sessions, the OMP agent (PiCoordinator in-process),
  the process/service scheduler, and (extended) crons/triggers.
- **Merge `machine tmux` into `machine serve`.** They're already coupled at runtime (serve
  calls `ensureTmuxLiteServer()` + `sendTmuxLiteCommand()`); merging = one supervised daemon
  + drop the separate CLI. Low–moderate effort, low risk. Target arch: **relay + machine-serve
  (tmux embedded)**.
- **Crons run on a machine, never the relay.** Because storage is canonical in CF, a cron can
  run on **any online machine** that mounts the artifacts repo, then commits back. Nominate a
  **primary base-owner machine** (default executor; e.g. a cloud `serve`); fall back to any
  online machine. (A DO-based scheduler/dispatcher is the eventual picker — deferred.)
- **Headless OMP auth** already works: `discoverAuthStorage(.pi)` + the `Bun.secrets` keychain,
  no interactive prompt — so a cron can invoke a skill/workflow non-interactively.
- **Cron ↔ service tie-in**: a service is a daemon process; a cron can *start a service*; a
  rolled-up/project cron runs against the `main`/base mount. (Exact semantics: open.)

### 1.4 Data model
- **Artifact = anything under `.gitspace/artifacts/`** (versioned in the CF Artifacts repo).
  The envelope is largely **inherited from git**: repo+branch = scope, commit = change,
  merge = roll-up, ancestry = alignment.
- **Kinds**: goal, rubric, evidence, notes, dashboards (def + `*.gssh.html` app + `data/`),
  triggers, reports, rated-precedents, chains.
- **Committed-in-source vs artifacts**: lifecycle `scripts/` stay committed in the *source*
  repo (code-coupled); everything else lives in the artifacts repo.
- **Extend the real models**: `Requirement.judgment` (singular) → **judges[]** + aggregation
  (multi-judge per criterion); **evidence-by-ref** (addressable evidence artifacts).

### 1.5 Mini-apps
- Literally **`*.gssh.html`** files in `.gitspace/artifacts/.../apps/`. Discovered by glob +
  embedded meta. Rendered in **sandboxed, resizable iframes** with a **data resolver**
  (iframe ⇄ host postMessage to read its `data/*.json`). Authoring + data-refresh are skills.

---

## 2. Product / UX decisions (from the mock-vs-real conflict audit)

1. **Color = runtime status, never phase.** `red` error · `orange` permission · `blue`
   waiting/idle · `green` working · `dim` idle. Phase is positional (column), no color.
2. **Phases are surface *modes* that gate abilities** (divergence from today): **plan** =
   spec (no repo edits); **code** = the *only* repo-edit mode, unlocks edit + workflows;
   **review** = diffs/review lens; **ship** = crons run, harvest/rating.
3. **Stage advancement is manual**, with chain/stack-position limits.
4. **Review = Change Guide (lens) + diffs in the right-panel file browser**, with a
   **diff-base selector** (`main` / `merge-base` / `review` / `unsaved` / `current`); reuse the
   real review backend + `@pierre/trees`.
5. **Stack/rebase status surfaced** in the chain (now backed by real git — see 1.1).
6. **Command palette (Cmd-K)** = the action spine; sidebar = navigation.
7. **Redesign the under-explored surfaces**: relay/machines (+ identity on cards), events/
   lifecycle taskbar, toasts, inbox, board stack visualization.
8. **Threading: not limited** (multiple threads; defer any cap).
9. **Create-workspace-from-a-planned-goal** is shown.
10. **Dashboards are agent-authored**, include **agentation**, stored as artifacts.
11. **Multi-pane = Dockview** (chat, dashboards, terminals coexist as panes).
12. **Notes are artifacts** — workspace-scoped, rolled up to the project on ship.

### States the mock should cover (audit — MUST tier)
Board: empty lane · create/delete-in-progress · per-card status color. Workspace shell:
idle/working/error+retry · awaiting permission · no sessions. Chat: thinking · tool running ·
tool error · permission · host-UI dialog · connection error · aborted · queued. Crons/services:
running · failed. Goal/rubric: evidence collecting · collection failed. Relay/machines:
connecting · offline · error+retry · no machines. Inbox: empty · unread. Global: toasts ·
lifecycle taskbar · host-UI dialogs · network offline · loading skeletons.

---

## 2b. Implementation principle — authority per surface
- **Net-new surfaces → the mock (`agent-surfaces-app/`) is the authority.** Its UX is the
  intended target; build to match it. Heavily-modified or replaced surfaces follow the mock.
- **Surfaces where the working app is higher-fidelity or has complicated state logic → do
  NOT downgrade.** Preserve the mature machinery (terminal/PTY, Dockview multi-pane, review/
  diff backend + `@pierre/trees`, chain-stack status computation, agent session/permission
  state machine, relay/handshake, process scheduler); layer the mock's presentation on top.
- **When in doubt, reconcile** — keep the real logic + the mock's UX; don't blindly swap.
- **Prefer clean cutover.** When something can be cleanly superseded or cut over, replace it —
  no legacy adapters, compat shims, or dual-path code. Keep a transitional layer only when a
  clean cutover is genuinely impossible, and call it out.

---

## 3. Build order (dependency-first)

1. **Storage substrate** — CF Artifacts repo model; ArtifactFS mount at `.gitspace/artifacts/`;
   unified symmetric layout; `runtime/` split; roll-up = merge; alignment = git. *(keystone)*
2. **Block registry substrate** — React-free **zod** schemas + web renderers + catalog +
   markdown fallback. *(keystone)*
3. **First vertical slice — goal-validation / rubric** (real data exists). Render through the
   registry; do the **multi-judge** extension; prove roll-up = merge.
4. **Unify chat into the registry** — tier-0/1 transcript blocks replace xterm; tool-call
   nests content blocks.
5. **Control seam** — `PiCoordinator` methods (`switchModel`, `setThinkingLevel`, `getUsage`,
   auth, settings, approve) + `omp-types` extensions → light up the agent chrome.
6. **Net-new subsystems** — triggers/crons (scheduler + token-scoped capability + headless
   run), dashboards/mini-apps (iframe host + data resolver), cron↔service.
7. **Merge `serve` + `tmux`** into one daemon.
8. **Worker read-only artifact viewer** + token sharing.
9. **Breadth** — board stack viz, inbox, relay/machines, taskbar/toasts, project home,
   empty/loading/error states.

Parallel: SDK hygiene (upstream the two logic patches; drop TUI-render patches via step 4;
keep the `pi-runtime` firewall).

---

## 4. Open / exploratory
- **Primary base-owner machine** policy + the **DO dispatcher** that picks the cron executor.
- **Crons ↔ services** exact semantics (start-a-service; rolled-up runs against base).
- **Stage-advancement constraints** derived from chain/stack edges.
- **Side-effect capability enforcement** beyond token write-scope (email/deploy/PR).
- **Scripts**: stay committed in source vs move into artifacts (leaning: source).
- **Relay as CF Worker/DO** (parked).

---

## 5. Mock status (the living spec)
`agent-surfaces-app/` currently reflects: color=runtime-status; stage-as-mode capability strip;
board Stacks lens with git-alignment + machine identity; Cmd-K; inbox; machines/relay; toasts;
lifecycle taskbar; agent chat (transcript + tool/host-UI/error states) with model-switch /
context / usage chrome; settings panels (sign-in/general/model/agent/usage/context) shaped to
the OMP SDK; dashboards canvas (agent-authored + agentation + artifact); crons & triggers
(capability scope, ship-live); review-mode diffs; project home + two-step artifact rail;
fonts = **Inter** (UI, `cv01`/`ss03`) + **JetBrains Mono** (code). Use it as the visual reference
when implementing the surfaces.
