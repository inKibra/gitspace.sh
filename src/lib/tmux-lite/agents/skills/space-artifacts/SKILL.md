---
name: space-artifacts
description: The workspace artifacts filesystem — what lives at .gitspace/artifacts, every artifact kind and its contract (dashboards, mini-apps, data, reports, workflow specs, evidence, notes, journal), and how to produce each one correctly. Use whenever you create, read, or reason about artifacts.
---

# Workspace artifacts

`.gitspace/artifacts/` is a real git worktree on this workspace's **artifacts
branch** (one branch per workspace, off `main`; roll-up merges it to `main`
when the workspace ships). Everything in it is versioned, travels with the
branch, and surfaces in the product UI by **path convention**. Write files
there and commit in that directory (`git -C .gitspace/artifacts add -A &&
git -C .gitspace/artifacts commit -m "..."`) — never commit artifacts into
the code repo.

## The kinds (path convention → UI surface)

| Convention | Kind | Surfaced as |
|---|---|---|
| `goal.md`, `rubric.json` | goal canon | **SYSTEM-MIRRORED — never write by hand.** Updated automatically from the goal record; journal/judgments pin hashes into their history. |
| `<name>.dashboard.json` | dashboard | ▦ dock tab + sidebar Dashboards + project home |
| `apps/<name>.gssh.html` | mini-app | runs sandboxed (standalone or in dashboards) |
| `<name>.data.json` or `data/…` | data | feeds apps; ⟳ trigger chips later |
| `reports/<name>.report.json` | report | '⚑ Report' pane + 'Reports · good + bad' rail group; `rating` adds it to Rated precedents |
| `<name>.workflow.json` | workflow spec | ⟜ Workflow pane (phased dataflow) |
| `validation/…`, `shots/…`, `demos/…`, `evidence/…` | evidence | ▸ evidence panes; **attach via goal commands** (`gssh space goal …`), not by hand, so it links to a requirement |
| `notes/…` | note | ✎ notes (prefer `gssh space notes`) |
| `journal/NN-<phase>.json` | phase journal | written by `gssh space journal` — see the phase-journal skill |
| `blame/edits.jsonl` | edit breadcrumbs | automatic; never write |
| `review/guide.json`, `review/analysis.json` | review guide | written via `gssh space guide` — see the review-guide-narrator skill |

Files ≥2MB are stored as LFS-style pointers automatically — commit normally.

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

**Workflow spec** (`x.workflow.json`): `{ recipe, recipePath?, rollup?: [],
phases: [{ name, inputs: [{name, io: 'source'|'artifact'}], gate?: {type:
'human'|'orchestration'|'command', label}, loop?, created?: [{name, type,
from, passedTo}], nodes: [{id, role, kind: 'agent'|'gate'|'tool', model?,
status?: 'done'|'running'|'pending', reads?, writes?, out?}], outputs:
[{name, kind, io, required?, status?}] }] }` — keep node statuses truthful;
the journal records real per-phase history.

## Rules

- Every artifact should serve a requirement, a phase, or a reader — don't
  dump scratch files; use the code repo's gitignored areas for scratch.
- Never duplicate sources of truth into artifacts (no transcript copies, no
  goal-state pastes) — link or pin hashes instead.
- Prefer the CLIs (`gssh space goal|notes|journal|guide`, `gssh artifacts
  status|sync|rollup`) over raw writes when one exists — they validate,
  snapshot state, and record provenance.
