---
name: space-artifacts
description: The workspace artifacts filesystem — the goal-keyed tree at .gitspace/artifacts, what your `local://` root is, every artifact kind and its contract (dashboards, mini-apps, data, reports, workflow specs, evidence, notes, journal, triggers), local:// drafts + promote, share links, and how to produce each one correctly. Use whenever you create, read, or reason about artifacts.
---

# Workspace artifacts

> **Entrypoint:** `space` is your canonical CLI (e.g. `space artifacts commit`,
> `space goal …`). It is the same binary as `gssh` with the `space` arg
> prepended, so `space X` ≡ `gssh space X` — prefer the shorter `space` form.
> The top-level `gssh artifacts …` commands (provision/status/sync/rollup) are a
> separate maintainer/host surface, not part of the in-session `space` CLI.

> **Orient first:** `space context` (add `--json` for fields) resolves where you
> actually are — project, workspace, workspace status, and note/todo counts.
> Run it before any workspace-scoped command when you are unsure which
> project+workspace you are operating on; every `space` verb below is scoped to
> that resolved context.

`.gitspace/artifacts/` is a real git worktree on this workspace's **artifacts
branch** (one branch per workspace, off `main`; roll-up merges it to `main`
when the workspace ships). Everything in it is versioned, travels with the
branch, and surfaces in the product UI by **path convention**. Write files
there and commit in that directory — never commit artifacts into the code
repo.

## The tree: every goal owns one folder

```
.gitspace/artifacts/            ← the mount (the whole branch)
  <project-level artifacts>     ← docs, mini-apps, the curated library
  goals/<goal-id>/              ← ONE disjoint subtree per goal
    goal.md  rubric.json  journal/  reports/  review/  apps/  …
```

**You own `goals/<your-goal-id>/` and nothing else.** That disjointness is
load-bearing: because no two workspaces ever touch the same path, merging your
branch into `main` at roll-up is *mechanically* conflict-free. Writing outside
your folder breaks that and is refused by the CLI.

**Every path you type is relative to the root you own.** `reports/x.report.json`
means `goals/<your-goal-id>/reports/x.report.json` — the `space artifacts`
verbs and `local://` all resolve against your root, so you never write the
`goals/<goal-id>/` prefix yourself. The tables and examples below are written
in that space.

Two equally valid ways to commit:

- `space artifacts commit <paths...> -m "…"` — preferred: records
  provenance (who/which session produced it) in git-notes.
- Plain `git -C .gitspace/artifacts add -A && git -C .gitspace/artifacts
  commit -m "…"` — also fine; a managed hook stamps basic provenance. Note git
  paths are MOUNT-relative, so here you do write the full
  `goals/<your-goal-id>/…` path.

## Project agents (@base)

If your working directory is the project's **base clone** (not a workspace
worktree), you are the PROJECT agent and your `.gitspace/artifacts` mount is
the **`main` branch — the project's rolled-up institutional memory**, not a
scratch branch. Treat writes as project-global: curate reports and
dashboards that summarize across workspaces, tend rated precedents, maintain
project-level triggers. Goal/journal/phase machinery is workspace-scoped and
mostly does not apply to you. Your `local://` is the **tree root**, so your
paths carry no `goals/` prefix.

**`goals/**` is roll-up-only.** Because your root is the whole tree you *can*
write into a goal folder — do not. Each goal folder has exactly one writer (the
workspace that owns it) and one path onto `main` (the roll-up merge); anything
else makes that workspace's next roll-up conflict. The CLI refuses it. To change
a goal, use `space goal set --goal <id>`.

## The kinds (path convention → UI surface)

Conventions are relative to the root you own (a workspace's
`goals/<goal-id>/`, a project agent's tree root).

| Convention | Kind | Surfaced as |
|---|---|---|
| `goal.md`, `rubric.json` | goal canon | **SYSTEM-MIRRORED — never write by hand.** Updated automatically from the goal record; journal/judgments pin hashes into their history. |
| `<name>.dashboard.json` | dashboard | ▦ dock tab + sidebar Dashboards + project home |
| `<name>.gssh.html` (conventionally under `apps/`) | mini-app | runs sandboxed (standalone or in dashboards); recognized by extension anywhere |
| `<name>.data.json` or `data/…` | data | feeds apps; ⟳ trigger freshness chips |
| `reports/<name>.report.json` | report | '⚑ Report' pane + Reports rail group; `rating` adds it to the 'Rated precedents' group |
| `<name>.workflow.json` | workflow spec | ⟜ Workflow pane (phased dataflow) |
| `triggers/<slug>.trigger.json` | trigger | ◷ Crons & triggers pane; cron triggers fire unattended from this machine's daemon (schedule grammar: `every N m/h/d` ONLY) |
| `validation/…`, `shots/…`, `demos/…`, `evidence/…` | evidence | ▸ evidence panes; **attach via goal commands** (`space goal …`), not by hand, so it links to a requirement |
| `notes/…` | note | ✎ notes (prefer `space notes`) |
| `journal/NN-<phase>.json` | phase journal | written by `space journal`; consumed by the review guide (no dedicated pane — lands under Other in the rail) |
| `blame/edits.jsonl` | edit breadcrumbs | automatic; never write (no UI pane; feeds the guide) |
| `review/guide.json` | review guide | rendered guide; write via `space guide` |
| `review/analysis.json` | review worksheet | CLI-only intermediate (no UI pane) |

**Large files are handled for you — and only through sanctioned commits.**
Files ≥2MB become standard git-LFS pointers automatically at commit time (a
managed pre-commit hook stores the bytes in the project blob store and
commits a pointer + `.gitattributes` line). Never pass `--no-verify`: the
publish gate refuses to sync or roll up any branch carrying raw large blobs,
the run is flagged, and `space artifacts repair` must rewrite it.

## Drafting with local:// and promote (the typing act)

`local://<rel>` means **the root you own** — not a fixed path. In a workspace
`local://PLAN.md` → `.gitspace/artifacts/goals/<your-goal-id>/PLAN.md`; for a
project agent it is `.gitspace/artifacts/PLAN.md`. You never spell the prefix:
ask for the path rather than composing one by hand. Draft freely — a file at a path that matches no
kind convention (e.g. a bare `PLAN.md`) is just typeless working material.
Get its absolute path (parent dirs created for you) and write to it:

```
p="$(space artifacts scratch-path local://PLAN.md)"
$EDITOR "$p"     # or: your file tools write to "$p"
```

When a draft is worth keeping, promote it into a TYPED location — the source
can be a `local://` reference OR any filesystem path:

```
space artifacts promote local://PLAN.md reports/my-findings.report.json
```

Promotion writes it to the typed path with provenance — that is the moment it
gains a type (report/dashboard/data) and becomes visible to the product and
to future agents.

## Share links

`space artifacts share <relPath> [--ttl 30m|24h|7d] [--max-uses N]`
mints a signed public URL for ONE file, served through the machine's relay
(requires the machine serve daemon active — `gssh machine serve start`).
Anyone with the URL can read that file until it expires or is revoked
(`share-list` / `share-revoke <tokenId>`). By default a share pins the file
at its current commit (a point-in-time capture); pass `--live` to serve the
current branch state on every read. A `local://` share (e.g.
`space artifacts share local://PLAN.md`) is always live, so you can share an
in-progress draft before committing it.

## Reading across goals (precedent, prior art)

Your own artifacts are `local://` / plain relative paths. **Everything another
goal produced lives under its own folder**, so cross-goal search is a glob over
`goals/*/`, never a bare read of `reports/`:

```
rg '"surface"' .gitspace/artifacts/goals/*/reports/     # all goals' reports
ls .gitspace/artifacts/goals/*/                          # what other goals made
ls .gitspace/artifacts/                                  # project-level artifacts
```

A bare `.gitspace/artifacts/reports/` is the PROJECT-level report dir and is
usually empty — searching it and concluding "no precedent exists" is the
failure mode this layout most invites. Use the glob.

Your branch came off `main`, so every published goal and project artifact is
already on disk: read it with ordinary tools (`ls`, `rg`, `Read`). What you
cannot see is a neighbour's unpublished work — that is the correct boundary.
Cross-scope *writes* always go through the `space` CLI, never a file write.

## Contracts you must honor when authoring

**Mini-app** (`apps/x.gssh.html`): ONE self-contained HTML document — inline
CSS/JS, no external requests (sandbox blocks them). Listen for
`window.addEventListener('message', e => { if (e.data?.type === 'gssh:data') render(e.data.data) })`.
Must tolerate `data == null` and repeated messages. Keep it small and dark-
themed (`background:#000`, mono fonts) to match the shell.

**Data** (`data/x.data.json`): arbitrary JSON — the shape is defined by the
app that consumes it. Document the expected shape in a comment at the top of
the app. Apps never fetch; new numbers = a new data commit.

**Dashboard** (`x.dashboard.json`):
```json
{ "name": "Ship dashboard",
  "panels": [ { "id": "p1", "app": "apps/ops-board.gssh.html",
                "title": "Build metrics", "data": "data/build.data.json",
                "size": "half" } ] }
```
`size`: `half` | `full`. `data` optional. Panels render as sandboxed iframes
fed by postMessage; UI edits auto-persist, so re-read before rewriting.

**Report** (`reports/x.report.json`) — agent feedback to gitspace:
```json
{ "kind": "good-pattern",         // praise | good-pattern | frustration | workflow-quirk | gitspace-quirk
  "surface": "review-gate",       // short mono identifier of what it's about
  "note": "markdown body",
  "quote": "optional verbatim quote",
  "rating": 4,                     // optional 1-5 → appears in Rated precedents
  "attachments": [ { "type": "goal-doc-snapshot", "ref": "reports/x.md", "label": "…" } ] }
```
> **A report only enters the shared corpus if it is FAVORITED.** Roll-up carries
> a goal's canonical record (goal.md, rubric, journal, workflow, evidence…) to
> `main` automatically, but reports are *curated*: an un-favorited report stays
> on the workspace branch and never reaches `main`, so future workspaces (which
> branch from `main`) can't ground on it. Filing a report is necessary but not
> sufficient — the user favorites (★) the ones worth keeping, and only those
> become durable and corpus-visible. If a report matters, say so and ask the
> user to favorite it; do not assume filing alone makes it persist.

**Trigger** (`triggers/<slug>.trigger.json`) — prefer the Crons & triggers UI
or ask the user; if authoring by hand: `{ id, name, kind: 'cron'|'manual',
when, writes: ["data/**"], runs: { type: 'skill', ref: 'agent-prompt',
prompt } }`. Cron `when` accepts ONLY `every N m/h/d`. The `writes` globs
are relative to the root you own (`data/**` means
`goals/<your-goal-id>/data/**`) and are an ENFORCED scope: when a trigger run ends, out-of-scope artifact
changes are automatically reverted and the run is marked failed. Runs may
receive a capability token in their prompt — pass it verbatim to
`space artifacts commit --cap <token> …` for sanctioned writes.

**Workflow spec** (`x.workflow.json`): `{ recipe, recipePath?, rollup?: [],
phases: [{ name, inputs: [{name, io: 'source'|'artifact'}], gate?: {type:
'human'|'orchestration'|'command', label}, loop?, created?: [{name, type,
from, passedTo}], nodes: [{id, role, kind: 'agent'|'gate'|'tool', model?,
status?: 'done'|'running'|'pending', reads?, writes?, out?}], outputs:
[{name, kind, io, required?, status?}] }] }` — keep node statuses truthful;
the journal records real per-phase history.

## Your role: forming artifacts through the stages

Artifacts are not an afterthought — they ARE the work product the review-gated
process runs on. What you produce, per stage:

**Plan** (spec only — repo read-only):
- Author the goal doc + requirements/rubric via `space goal …` (the
  system mirrors canon to `goal.md`/`rubric.json`; you never write those
  files). Each requirement declares the EVIDENCE SHAPE you'll owe later.
- Draft freely with `local://`; promote the plan artifacts worth keeping.
  Draft the execution plan as `<name>.workflow.json` — phases, gates,
  what each phase reads/writes. This is your contract with the reviewer.

**Code** (the only stage that edits the repo):
- Bracket every workflow phase with `space journal phase-start --intent`
  / `phase-end --outcome` (see phase-journal skill). The system snapshots
  goal/workflow/review state, computes what your phase advanced, and
  auto-commits — this is what makes the review guide able to tell YOUR story
  with YOUR stated intent, and makes commit history readable.
- Capture evidence AS requirements are satisfied (`space goal …` attach
  flows) — screenshots, test output, demos land under `validation/` linked to
  their requirement. Evidence captured at the moment of proof beats evidence
  reconstructed at review time.
- Build observable outputs when the goal calls for them: data artifacts for
  metrics, mini-apps + dashboards when numbers deserve a live view.
- Update workflow node statuses truthfully as phases complete.
- Edit breadcrumbs record themselves — you do nothing.

**Review** (review the change):
- Generate/refresh the guide (`space guide analyze` → narrate stale
  beats → `submit`; see review-guide-narrator skill). Your journal entries
  from Code are the grounding — this is where honest intents pay off.
- When the reviewer requests changes: journal the fix as its own phase, and
  resubmit the guide — only beats you touched re-narrate.
- File reports (`reports/*.report.json`) for anything worth remembering:
  patterns that worked (`good-pattern`, rate it → precedent), friction
  (`frustration`, `workflow-quirk`, `gitspace-quirk`). This is how the system
  learns across workspaces.

**Ship** (post-merge ops):
- Close the final journal phase; ensure workflow statuses are final.
- Roll-up (`gssh artifacts rollup <workspace>`) merges the whole record — canon history,
  journal, evidence, dashboards, guide — into `main`, arriving intact at
  `goals/<your-goal-id>/`. Nothing moves and nothing is renamed, so every
  reference to your artifacts keeps resolving. Your goal folder becomes part of
  the project's institutional memory and the seed corpus for the next chain's
  precedents.

The test for every artifact: could a future agent (or reviewer) reconstruct
WHY from what you left behind? If not, the artifact is missing or hollow.

## Rules

- Every artifact should serve a requirement, a phase, or a reader — keep
  rough drafts as typeless `local://` files, promoted to a typed path only
  when they earn a place in the record.
- Never duplicate sources of truth into artifacts (no transcript copies, no
  goal-state pastes) — link or pin hashes instead.
- Prefer the CLIs (`space goal|notes|journal|guide`, `space
  artifacts commit|promote|share|scratch-path|repair`, and the top-level
  `gssh artifacts status|sync|rollup <workspace>` maintainer commands)
  over raw writes when one exists — they validate, snapshot state, and
  record provenance.
- Never `--no-verify` in the artifacts mount; if the publish gate refuses a
  branch, run `space artifacts repair`.
