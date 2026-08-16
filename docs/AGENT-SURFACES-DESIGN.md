# Agent Surfaces — Design Doc

**Status:** draft · **Date:** 2026-06-19 · **Owner:** GitSpace web

Turn GitSpace's terminal-first agent surface into a native, structured, multi-lens
system where everything an agent produces — transcripts, plans, recaps, reviews,
workflow runs, and field notes — is a **durable, viewable, feedback-bearing
artifact** rendered from **one block registry**.

This doc consolidates research across omp-deck, agent-native (BuilderIO), the omp
SDK, Fabro, Factory, Linear Guides, and principal-ade (Code Trails / File City).

---

## 1. The one idea

> **One canonical data model → one block registry → N synchronized lenses.**
> Every artifact is a git-native committed file with anchored feedback that
> routes back to the agent.

Today the agent's *input* side is already native React (`NativeComposer`,
`NativeAgentSurface`, slash/file pickers, host-UI dialogs, steering queue). The
*output* side is still terminal-first: it renders through `SessionTerminal.web.tsx`
(xterm) as PTY scrollback. There are zero structured message/tool renderers.

This design closes that gap **once**, with a registry that simultaneously powers
the live transcript, plans/recaps, code-review guides, workflow run-graphs, and
quirk/field-note artifacts.

---

## 2. Canonical data model

Three primitives underlie every surface:

1. **Block** — a typed, schema-validated unit of structured content.
   `{ type, data (zod-validated), placement }`. Authored by the agent, rendered
   by React. Unknown type → markdown fallback (never breaks).
2. **Run trace** — the structured event stream from an agent fan-out. For omp
   `workflow`, this is `EvalToolDetails → cells[] → { code, statusEvents[] }`
   where `statusEvents` carry `op: "phase" | "log" | "agent"` (agent events =
   coalesced progress snapshots: id · role · model · status · tokens · cost ·
   currentTool · intent).
3. **Anchor** — `{ file, lines }` (+ optional "why"). The cross-link spine shared
   by recaps, guides, quirks, and review findings.

Everything else is composition.

### Artifact files (git-native)

```
.gitspace/
  plans/<slug>.mdx          # /visual-plan output
  reviews/<pr>.mdx          # code-review guide + results
  workflows/
    recipes/<name>.md       # reusable orchestration shape (skill-shaped)
    roles/<name>.md         # subagent role (prompt + schema)
    schemas/<name>.json     # structured-output contract
    runs/<id>.json          # captured run receipt (graph + trace)
  quirks/<slug>.mdx         # codebase field notes (dim 1)
```

Committed → versioned, diffable, travels with the worktree. This is what
agent-native fakes with a hosted DB; GitSpace gets it for free.

---

## 3. The block registry (keystone)

`defineBlock`-style contract, lifted from agent-native, adapted to GitSpace's
`.ts` / `.web.tsx` split:

```ts
defineBlock<TData>({
  type: "annotated-code",
  schema: zod,                 // data shape + validation
  mdx: { tag, toAttrs, fromAttrs },   // byte-stable round-trip
  Read: FC,                    // read-only renderer (.web.tsx)
  Edit?: FC,                   // optional — auto-form from schema if omitted
  placement: ["block" | "inline"],
  example: "...",              // shown in the catalog handshake
})
```

- **React-free `.config.ts`** (schema + mdx) so server/agent code never pulls in
  React. **`.web.tsx`** holds `Read`/`Edit`.
- **`<BlockView>` + `<BlockRegistryProvider>`** render any block; **registry with
  fallback** → unregistered types degrade to markdown.
- **Catalog handshake**: an `engine.listBlocks()` endpoint returns the live
  registry vocabulary (type, tag, placement, fields, example). The agent fetches
  it *before* authoring and validates against it *after* — never memorizes tags.
  (agent-native's `get-plan-blocks` pattern. This is why their artifacts are
  reliable: quality lives in the harness, not the prompt.)

### Block tiers (build order)

**Tier 0 — substrate:** `BlockView`, `markdown`/`rich-text`, `callout`, `table`,
`columns`, `tabs`.

**Tier 1 — evidence (port from agent-native):** `annotated-code` (margin notes
anchored to changed lines — *the* code-evidence primitive), `diff`, `file-tree`
(add/modify/remove/rename change chips), `code`, `data-model` (interactive ERD),
`diagram`, `mermaid`, `checklist`.

**Tier 2 — interaction:** `question-form` (single/multi/freeform, recommended,
write-in), `annotation-thread` (anchored comments), `verdict-chip`
(pass/fail/partial · severity · confidence), `approval-gate` (accept/reject/
request-changes), `send-to-agent` (→ steering/follow-up queue).

**Tier 3 — run/process (NEW, omp-specific):** `run-graph` (phases as swimlanes,
`parallel()` fan-out, `pipeline()` staged chains), `agent-node` (role · model ·
status · tokens · cost · intent · schema-typed result), `guide` (signal-ranked
sectioned diff projection — see §6).

---

## 4. The surfaces (all compositions)

| Surface | Composition |
|---|---|
| **Live transcript** | `agent-node`-style tool cards via registry (replaces xterm for the agent pane; keep xterm for real PTY panes) |
| **Plans** | doc surface · rich-text · annotated-code · diagram/data-model · file-tree · callout(decision) · bottom question-form · approval-gate · optional canvas |
| **Workflows** | run-graph · agent-node cards · phase timeline · cost meter · eval source as annotated-code · per-node schema-typed result · recipe catalog |
| **Review (guide + results)** | guide (signal-ranked sections) · annotated-code/diff evidence · verdict-chip · annotation-thread · approval-gate · send-to-agent |
| **Post-orchestration recap** | run-graph (traversal) · file-tree change chips · data-flow diagram · annotated-code of load-bearing edits · temporal scrub |
| **Quirks / field notes** | callout(warning) · annotated-code anchor · diagram (annoying workflow) · checklist (workaround) |

---

## 5. Workflows: definition vs run (Fabro model)

omp `workflow` is a **keyword + injected notice** that steers the model to author
ephemeral Python in the `eval` tool. Nothing is persisted. So:

- **The durable element is the graph, not the script.** Represent a workflow as a
  **typed-node directed graph** (Fabro/Graphviz-DOT shape): nodes = agent /
  command / human-gate / branch / fan-out·fan-in; edges carry conditions, loops
  (`max_visits`), goal-gates. Version-controlled in `.gitspace/workflows/`.
- **The omp eval-Python is one *rendering* of the graph.** Regen per run is fine.
- **A run is a *traversal* of the definition**, lit with live state from
  `statusEvents`.
- **Bidirectional:** capture an omp run → emit a graph element; author/edit a
  graph → regen a fresh script next run.

### Element library (reuse without freezing scripts)

Four element types, composed by the agent at author time via the catalog
handshake:

- **Recipe** — orchestration shape (`adversarial-verify`, `judge-panel`,
  `loop-until-dry`, `review→verify`, `migrate`). Skill-shaped, so omp's
  `loadCapability` already loads it. Seeded from the patterns omp already
  enumerates in `WORKFLOW_NOTICE`.
- **Role** — subagent worker (`agent_type` + prompt + return schema).
- **Schema** — structured-output contract (the highest-leverage element; gives
  branchable + visualizable results).
- **Composed recipe** — named binding of recipe + roles + schemas for a recurring
  job.

Every run-graph node is **tagged with the elements it instantiated** → the graph
self-describes, the usage catalog ("which elements used where") falls out, and
runs roll up into per-recipe reliability/cost metrics (Factory's *continual
learning*).

> `orchestrate` (model orchestrates turn-by-turn via `task`) vs `workflow`
> (script orchestrates in `eval`). The clean capturable run-graph is on the
> `workflow` side; `orchestrate` is visualized later as a phase/task timeline
> reconstructed from `todo_write`.

---

## 6. The curated↔raw invariant (Linear Guides)

A recurring UX shape across four surfaces: **a structured, navigable projection
alongside the raw underlying data, bidirectionally linked.**

| Curated view | Raw substrate |
|---|---|
| Plan | the code it targets |
| Workflow definition | run trace |
| Rubric | evidence anchors |
| **Guide** (signal-ranked sections) | **raw diff** |

A `guide` block = ordered sections `{ title, rationale, anchors[], signal:
core|supporting|noise }` — a **projection over a diff**, identical to what an omp
`/visual-recap` produces. Core changes first, supporting/generated changes
grouped, "why" prose per section, each section linking to its diff hunks. Bump
the **narrative lens to first-class for review** (Linear ships it as default).

**Our differentiator over Linear:** their guide is read-only/hosted/GitHub-synced.
Ours is git-native, and feedback routes back to an agent that can *fix* — guide →
finding → send-to-agent → fix → new recap. We close the loop.

---

## 7. The four lenses (synchronized renderers)

One data model, rendered four ways; clicking an element in one moves all four
(Code Trails' synchronization is the product):

| Lens | Source idea | Carries | Priority |
|---|---|---|---|
| **Document** | agent-native | plans, recaps, reviews, rubrics, quirks | core |
| **Graph** | Fabro | workflow definition + run | core |
| **Narrative** | Code Trails / Linear | guided walkthroughs (where/how/what/why) | core *for review* |
| **Spatial** | File City | codebase map (height=LOC, color=status, temporal scrub) | wow-layer |

Document + Graph carry all five surfaces → build first. Narrative is promoted for
review. Spatial (File City) is the differentiated add-on — an *additional renderer
over data you already have*, not a new pipeline.

---

## 8. `report_problem` — three-dimension field-note tool

One agent tool (GitSpace extension via `getManagedPiExtensionPaths()`), routed by
`dimension`:

```
report_problem({ dimension: "codebase"|"harness"|"omp", summary, detail,
                 cross_ref?, anchor?, kind?, severity?, recommendation?, reproducible? })
```

| Dim | Subject | Destination | Persistence |
|---|---|---|---|
| `codebase` | the repo being worked on | `.gitspace/quirks/<slug>.mdx` | **git-native artifact** (specifics ARE the point; no-PII does NOT apply) |
| `harness` | GitSpace itself | local SQLite grievance store → GitSpace endpoint | telemetry (no-PII) |
| `omp` | omp tools/harness | **wrap/mirror** omp's `report_tool_issue` (→ `qa.omp.sh`) + tee into GitSpace store | telemetry (no-PII) |

- **Reuse omp's pattern** for dims 2&3: local SQLite, one consent gate, background
  flush, never blocks, never throws, "generic, NEVER PII."
- **Dim 1 is just another block-registry artifact** — `callout(warning)` +
  `annotated-code` anchor + optional `diagram` + `checklist`. Renders through
  `<BlockView>`, carries anchored feedback + send-to-agent, feeds the catalog
  (quirk density by region → File City coloring). `kind:"annoying-workflow"`
  links to the workflow element library (seed of an automation).

---

## 9. Build order (dependency-first)

1. **Block registry + `<BlockView>` + fallback** + catalog handshake endpoint.
   *(unblocks everything)*
2. **Tier-0/1 blocks** → native transcript replaces xterm for the agent pane.
   *(also retires the TUI-rendering SDK patches)*
3. **Tier-2 interaction blocks** (annotation-thread, verdict-chip, approval-gate,
   send-to-agent on the steering queue).
4. **`guide` block** (= recap projection) → code-review surface. *(near-free once
   annotated-code + diff + anchors exist)*
5. **Tier-3 run-graph + agent-node** fed by `EvalToolDetails` → workflow
   visualization.
6. **`.gitspace/workflows/` element library** + `report_problem` tool +
   `.gitspace/quirks/`.
7. **Spatial lens (File City)** + temporal scrub — the wow layer.

### Current prototype artifacts

The checked-in prototypes are intentionally split by purpose:

- `docs/agent-surfaces-mockup.html` is the broad product mockup for the unified
  block-registry surface. It demonstrates the intended visual vocabulary across
  transcript cards, workflow run graphs, guided review projections, and artifact
  lenses.
- `docs/agent-blame.html` is the first focused vertical slice: provenance for
  code mutations. It shows how mutation events, observed diffs, lineage edges,
  context references, and a squash-merge provenance bundle should feel to a user.

Use the broad mockup to implement the reusable surface primitives, and use Agent
Blame as the first end-to-end product proof that those primitives can explain
real code lineage.

### First implementation slice

1. Land the block registry substrate:
   - React-free block schemas/config,
   - web renderers,
   - markdown/unknown-block fallback,
   - catalog endpoint for the agent.
2. Implement the evidence blocks needed by both prototypes:
   - diff/code,
   - annotated-code,
   - file-tree,
   - callout,
   - verdict/chip metadata.
3. Build Agent Blame as the first vertical slice:
   - mutation event capture model,
   - pre/post image and patch identifiers,
   - lineage scoring metadata,
   - committed provenance bundle under `.gitspace/agent-blame/`,
   - line-click query surface that renders the reasoning chain.
4. Reuse the same blocks for plans/reviews/workflow recaps rather than building a
   separate bespoke review UI.

### Parallel track: SDK hygiene (from omp-deck)
- **Upstream** the two logic patches (`removeQueuedMessage` indexed API, per-session
  bash `cwd`).
- **Drop** the TUI-rendering patches via step 2.
- Keep the `AgentBridge`-style firewall (you have it: `engine`/`pi-runtime`); pin
  exact; prefer typed contracts over defensive `?.` feature-detection.

---

## 10. Cross-cutting principles

1. **Anchored feedback** — every block/line/node can carry a comment or verdict
   pinned to an exact target.
2. **Bidirectional** — that feedback routes back to the agent (steering/queue).
   "Click it or ask for it," both ways.
3. **Git-native** — every artifact is a committed file. Versioned, diffable,
   per-worktree.
4. **Curated ↔ raw** — every surface offers a structured projection + the raw
   substrate, synchronized.
5. **Graceful degradation** — unknown block/event → visible fallback, never a
   silent drop. (Improve on omp-deck: make unknowns *loud*.)
6. **One registry** — transcript, plans, reviews, workflows, quirks all render
   from it. Build once.
