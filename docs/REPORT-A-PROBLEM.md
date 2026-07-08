# Report a problem → GitHub issue → workspace → fix

Status: design. A user-facing "report a problem" button that captures a
redacted diagnostic bundle and **files a GitHub issue**; the issue can then be
**imported into GitSpace as a workspace with a goal**, where the fix runs
through the normal review-gated chain (plan → code → review → ship → PR). The
report is a **work order**, and GitSpace fixes it the same way it builds any
feature — dogfooding the whole platform on its own bugs.

Two loops, joined at GitHub Issues:

- **Loop 1 — capture → issue.** The button assembles a redacted diagnostic
  bundle and files a GitHub issue (the durable, external, deduplicable record).
- **Loop 2 — issue → workspace → fix.** An issue is imported exactly the way a
  Linear issue seeds a workspace today, but seeding a real **goal** (not just a
  `.prompt/` file). The fix then produces a reviewable, documented change —
  goal doc, journal, review guide, PR — like any other workspace.

Why the issue is the seam and not an inline agent: a GitHub issue is a triage
surface humans already understand, it threads discussion, it dedups, and it
survives independent of any workspace. And routing the fix through a real
workspace-with-a-goal means the agent produces a *reviewable* change (guide +
evidence + PR), not a raw diff. The earlier "fire a trigger agent inline" idea
is lighter but bypasses exactly the review machinery that makes a fix
trustworthy.

## Current state (verified 2026-07-07)

- **Server tracing is env-gated and ring-less.** `writeTraceLog`
  (`src/utils/trace-log.ts:26`) only fires when `GITSPACE_TRACE` is set, and
  only appends JSONL — no in-memory ring, nothing captured by default. The
  event-loop-lag sampler (`server.ts:336`) is gated the same way.
- **The daemon's raw stdout/stderr IS always captured** since the unification
  quick-win: `getDaemonLogFd` (`cli.ts:144`) →
  `<sessionDir>/tmux-lite-daemon.log`. This already caught two real bugs.
- **The browser has zero error capture.** No `window.onerror`, no
  `unhandledrejection`, no ErrorBoundary, no longtask observer, no ring.
  `web/main.tsx` mounts `<App/>` bare — a render throw unmounts silently.
  This is exactly the "whole webpage freezes / goes blank" symptom.
- **Version is a lie.** `PACKAGE_VERSION` is hardcoded `"1.0.0"` in four
  places (`protocol.ts:13`, `serve.ts:93`, `status.ts:16`,
  `useDaemonStatus.tui.ts:14`); real is `0.2.0-rc.38`. A report must carry the
  true version or triage starts from false premises.
- **Redaction is flag-only.** `crash-log.ts:43` `redactArgv` scrubs a fixed set
  of sensitive CLI flags. Nothing scans free text for `ghp_`, `github_pat_`,
  `Bearer …`, JWTs (`eyJ…`), or the home directory. A bundle carries error
  bodies and logs, so we need a **content** redactor before anything leaves the
  machine.
- **Transcript errors are flattened early.** `useTranscript.web.ts:87,108`
  replace real errors with `'Failed to load transcript'`; `:165` swallows
  entirely. "Agent transcripts refuse to load" (a symptom you named) currently
  produces no diagnostic. Keep `err.message`.
- **No `gh issue` command of any kind exists** (create, list, view). The
  closest POST pattern to model `createIssue` on is `postGitHubApi`
  (`github-review.ts:757`): `gh api <endpoint> --method POST --input <tmpfile>`
  — the issue endpoint is `repos/{owner}/{repo}/issues`. Reads use
  `gh api … --paginate --slurp` / `--jq`. Arg safety via `escapeShellArg`.
- **The `github` source-ref already exists, unused.** `GoalRecord.sourceRefs`
  (`types/goals.ts:132`) has a `SourceRef` variant `{ type: 'github', id, url,
  title }` that **nothing populates today** — a ready-made attachment point
  linking a goal back to its issue.
- **Issue→workspace has a working analog: Linear.** `add.ts:337-421` splices a
  "Create from Linear issue" source, derives the workspace name from the issue
  (`generateWorkspaceName`), and seeds `.prompt/issue.md`. But it does NOT
  create a goal (`bindPlannedGoalForWorkspace` only binds a pre-existing one).
  The GitHub version reuses this path and diverges at the goal seam.
- **Reusable substrate that already exists:** the inbox (`server.ts:267`) for
  notifications; `ensureWorkspaceGoalChain` (`goal-chain.ts:508`) +
  `updateGoalRecord({ doc, sourceRefs })` (`:308`) to create+seed a goal;
  `crash-log.ts` redaction to extend; process-level crash handlers
  (`index.ts:90,100`, server/CLI only).

## The four stages

### 1. Capture — the bundle

A `DiagnosticBundle` (versioned schema) assembled on demand:

- **Client half** (new, ~150 LOC in web):
  - A bounded ring (last ~200 entries) fed by `window.onerror`,
    `unhandledrejection`, and a thin console.error tap.
  - A **freeze watchdog**: a heartbeat interval + `PerformanceObserver`
    longtask; on a stall > ~5s, flush the ring tail to `sessionStorage` so a
    freeze/blank-page *survives reload* (you report it after refreshing).
  - A top-level React **ErrorBoundary** in `web/main.tsx` that renders a
    "something broke — report it" panel instead of unmounting to blank.
  - The recent RPC log (requestId, type, duration, outcome) — the backends
    already see every RPC; add an `onDiagnostic` tap.
- **Server half** (new, small): make `writeTraceLog` *always* push to a bounded
  in-memory ring (the JSONL append stays `GITSPACE_TRACE`-gated); un-gate the
  lag sampler so lag stats are always available. A `diagnostics-bundle` RPC
  returns: ring tail, lag stats, session/agent tables, pending permission/
  question counts, uptime, relay status, **real** versions, daemon-log tail.
- **Facts**: fix `PACKAGE_VERSION` to read package.json (one source), include
  git SHA of the running build.

The `diagnostics-bundle` RPC uses the both-transports pattern we've built
repeatedly (artifact-share-mint, project-artifacts-rollup): tmux protocol
Command/Response + `server.ts` dispatch case, remote request +
`session-handler` dispatch, backend interface + local/remote impls.

### 2. Redact — the gate that makes stage 4 safe

Extend `crash-log.ts` into a reusable `redactText(s)` covering: `ghp_…`,
`github_pat_…`, `Bearer <token>`, JWTs (`eyJ…\.…\.…`), `xox[baprs]-…`,
absolute home paths (`/home/<user>` → `~`), and the existing sensitive-flag
values. Run it over **every string field** of the bundle before it is written
to disk, filed, or handed to an agent. Redaction is not optional and not
after-the-fact — it is the boundary.

### 3. File the GitHub issue — Loop 1's terminus

- New `src/core/github-issues.ts`: `createIssue({repo, title, body, labels})`
  modeled on `postGitHubApi` (`gh api repos/{owner}/{repo}/issues --method POST
  --input <tmpfile>`), returning `{number, url}`. Body = the user's note + the
  redacted bundle (fenced) + version/SHA. Label `gitspace-report`.
- The `report-problem` RPC assembles → redacts → `createIssue` → inbox:
  "Reported as #<n>" with the URL. **Fallback when gh/daemon is down:** write
  the redacted bundle to `<root>/.logs/reports/<ts>/` and say so, so a report
  is never lost.
- Target repo is configurable (default: the affected project's repo; a
  fixed "gitspace feedback" repo is an option for product-level reports).

Stages 1–3 are a complete, useful feature and the conservative ship: a button
that turns a freeze into a triaged, redacted GitHub issue.

### 4. Import the issue → workspace + goal — Loop 2

An issue becomes a workspace the way a Linear issue does, but seeding a real
goal so the fix is a first-class, reviewable change:

- **Source picker:** splice "Create from GitHub issue" into `addWorkspace`
  (`add.ts:337`, parallel to the Linear option). List open `gitspace-report`
  issues via `gh api … --paginate`; user picks one (or pass `--issue <n>`).
- **Name + branch:** `generateWorkspaceName('<number>-<slug>', title)`
  (`add.ts:420`) — e.g. `142-transcript-load-freeze`.
- **Seed the goal (the divergence from Linear):** after the `createWorktree`
  block (`add.ts:487`), `ensureWorkspaceGoalChain(project, workspace)` then
  `updateGoalRecord(project, goalId, { doc: { bodyMarkdown: issueBody },
  sourceRefs: [{ type: 'github', id: '<n>', url, title }] })`. The unused
  `github` source-ref finally gets populated; the goal doc opens pre-filled
  with the problem statement + the diagnostic bundle the agent needs to
  reproduce.
- **Fix runs normally:** the workspace agent plans against the seeded goal,
  writes the fix in Code, journals it, generates a review guide, and ships a
  PR. No new autonomy policy, no bespoke enforcement — it IS the review-gated
  chain. The `sourceRefs` link means the guide/PR can reference the issue and
  the issue can be closed on merge.

Granularity: **one issue → one goal → one workspace** (a one-element chain) is
the default — it matches how Linear issues map and keeps the common bug-fix
path dead simple. A "chain" (stacked goals) is reserved for when a human
explicitly promotes a cluster of related issues into an epic; clustering
intelligence is a later concern, not v1.

The two earlier decisions ("how autonomous?", "where does it run?") **dissolve**
in this model: autonomy is just the normal review gate you already merge
behind, and the fix runs in a dedicated per-issue workspace because that is
literally what "import issue → workspace" produces.

## Open decisions

**How is Loop 2 triggered?** The issue exists; what turns it into a workspace?
1. *Manual import* (recommended v1): the issue sits in GitHub until a human
   runs `gssh workspace add --issue <n>` (or picks it in the source picker).
   Human decides what's worth fixing; zero surprise agent activity.
2. *One-click from the report*: the report dialog offers "file issue AND start
   a fix workspace" so the loop closes in one action for the reporter.
3. *Auto-import on label*: a `gitspace-fix` label (added by a human triaging)
   auto-creates the workspace via the scheduler. Most automated; needs a poll
   or webhook and a policy for who may apply the label.

Recommended: ship 1, offer 2 as a checkbox, defer 3. Keeps a human in the loop
on *what* gets fixed while making the common path one click.

**Which repo gets the issue?** Default to the affected project's own repo (the
fix workspace is already there). A separate product-feedback repo is right for
"GitSpace itself is broken" reports where the reporter isn't the maintainer —
make it a config, not a hardcode.

**Goal vs. chain granularity** — settled above: one issue → one goal by
default; chains only when a human promotes a cluster.

## Build order

1. **Quick wins (~40 LOC), independently valuable:** `PACKAGE_VERSION` from
   package.json; keep `err.message` in `useTranscript`; the client
   ErrorBoundary + `onerror`/`unhandledrejection` ring (stops silent blank
   pages immediately).
2. `redactText` in `crash-log.ts` + tests (the safety gate — before any
   capture ships).
3. Server ring + un-gated lag sampler; `diagnostics-bundle` RPC (both
   transports).
4. Client freeze watchdog + `sessionStorage` survival + RPC-log tap +
   backend `onDiagnostic`.
5. **Loop 1:** `github-issues.ts` `createIssue`; `report-problem` RPC
   (assemble → redact → `createIssue` → inbox, local fallback on failure);
   ReportProblemDialog in the chrome bar (`rightExtra` slot; ⚑ is Inbox —
   don't overload it).
6. **Loop 2:** `github-issues.ts` `listIssues`/`fetchIssue`; the
   "Create from GitHub issue" source in `addWorkspace`; seed the goal via
   `ensureWorkspaceGoalChain` + `updateGoalRecord({ doc, sourceRefs })`. The
   fix then rides the existing review-gated chain — nothing new downstream.

Stages 1–2 are pure risk-reduction and ship regardless. 3–5 is the reporting
half (button → redacted issue). 6 is the resolution half (issue → workspace →
reviewable fix), and it's mostly *reuse* — the Linear import path plus one new
goal-seeding call, then the normal chain does the rest.

## RPC / seam touchpoints (for whoever builds it)

- `diagnostics-bundle` / `report-problem` RPCs: the 7-spot both-transports
  pattern (model: `project-artifacts-status`) — tmux Command+Response unions
  (`protocol.ts`), the execution `case` in `server.ts` (single shared site),
  the remote request interface + union entry (`remote-session/protocol.ts`),
  the access-gated dispatch case in `session-handler.ts`, the interface method
  + local/remote backend impls (`session/backend.ts`, `backends/*`).
- GitHub issues: new `src/core/github-issues.ts`, `createIssue` on the
  `postGitHubApi` pattern (`github-review.ts:757`), reads via `gh api …
  --paginate`.
- Import seam: `add.ts:337` (source splice), `add.ts:420`
  (`generateWorkspaceName`), `add.ts:487` (goal seed via
  `ensureWorkspaceGoalChain` + `updateGoalRecord` with the `github`
  `sourceRef`). No new goal/chain infrastructure — those functions exist.
