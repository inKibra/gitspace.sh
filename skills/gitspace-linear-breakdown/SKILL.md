---
name: gitspace-linear-breakdown
description: Turn one or more Linear tickets into a machine-readable GitSpace goal-chain plan. Chains are strictly linear; they continue through the clearest useful path and stop only when choosing the next goal would be arbitrary, blocked, or misleading.
---

# GitSpace Linear Breakdown

Use this skill when asked to take Linear ticket(s) and produce a **machine-readable goal-chain plan**. The deliverable is `plan.yaml`: a structured planning artifact, not setup instructions.

## What you produce

A single YAML document with this exact top-level shape:

```yaml
version: 1
title: "<Project or theme>: chain plan"
sources:
  - type: linear
    ref: "<ticket id or project url>"
plan_questions: []
chains:
  - id: chain-a
    title: "<name>"
    summary: "<what this chain accomplishes end-to-end>"
    goals:
      - id: "<stable-kebab-id>"
        source_refs: ["<Linear identifier or URL>"]
        title: "<IDENTIFIER>: <short verb-led title>"
        objective: "<what this shippable slice delivers>"
        non_goals:
          - "<what it explicitly does not deliver>"
        validation:
          - "<acceptance criterion restated as evidence intent>"
        requirements:
          - id: req-1
            title: "<verbatim criterion>"
            kind: screenshot
            required: true
            generation:
              type: manual
            judgment:
              type: human
            rubric: "<concrete falsifiable checklist>"
    branch_point: null
deferred_items: []
```

Each chain is a strictly linear sequence of goals in execution order. Each goal has an explicit validation contract. The output must be parseable as YAML and must avoid prose-only tables.

## Contract

- The input is intent. You produce the structured plan.
- **Chains are strictly linear. No forks, ever.** Do not stop a chain just because multiple later tasks are possible. Continue linearly when there is a clear best next shippable slice based on priority, dependency, same-surface cohesion, or risk reduction. Add a branch point only when choosing the next step would require guessing a product/technical decision, or when forcing unrelated work into one sequence would create a fake dependency.
- **Independent tracks → separate top-level chains only when that is better than linearizing.** If two pieces of work are independently executable right now and sequencing them would mislead the user or serialize unrelated delivery, put them in separate chains. If they are part of the same product path and a sensible order exists, keep one linear chain. Two chains never share a goal. Two chains never declare a dependency on each other in the plan.
- **One goal per shippable slice.** Each goal must be independently reviewable and shippable. Splitting a single change because the diff is large is wrong; merging two unrelated changes because they're small is also wrong.
- **Acceptance criteria become requirement rubrics.** One requirement per criterion. Never collapse criteria into "looks good."
- **Do not invent.** If a ticket lacks acceptance criteria, do not create placeholder goals, placeholder requirements, or TODO rubrics. Put it in `deferred_items` with the exact missing information needed to plan it.

## Inputs

You may be given any of:

1. **One ticket** ("break down ENG-123"). Read just that ticket.
2. **A set of tickets** ("plan ENG-123, ENG-124, ENG-130"). Treat them as one input; you decide chaining vs independent chains.
3. **A Linear project / cycle / view** ("plan the Q3 billing project"). Treat every ticket in that scope as input.

Sources for ticket content, in priority order:

- The user pastes the ticket title, description, and acceptance criteria.
- The agent has a Linear MCP / Linear CLI available; use it.
- The repo contains an imported issue document for the ticket; that is a valid source too.

If the agent has no way to read a referenced ticket, ask. Do not guess from the identifier.

## Decision rules

For each input ticket, ask:

1. **Same chain, separate chain, or branch point?**
   - "A must land before B and B is the clear next shippable slice" → same chain, A then B.
   - "A and B are independently executable right now, and ordering one after the other would create a fake dependency" → different top-level chains.
   - "A unlocks B and C, but B is clearly the next priority / same surface / risk-reducing follow-up" → keep going linearly with B. Do not branch merely because C is also possible; defer C only if it is not part of the chosen line.
   - "A unlocks B and C, and picking B vs C would require an unmade product/technical choice" → stop at A. Add a `branch_point` listing B and C in `deferred_source_refs`; do not include B or C as chains elsewhere in the same plan.

2. **Within a chain, is the next step worth choosing now?**
   - "Yes, after A we should do B next" → extend the chain.
   - "After A, we might do B *or* C depending on what we learn" → **stop the chain at A**. Add a `branch_point` with what would resolve it.
   - "After A, B and C are both unblocked, but forcing either one next would be arbitrary or harmful" → **stop the chain at A**. Add the branch-point guidance and list the fork children in `deferred_source_refs`; do not plan those children now.

3. **Does any ticket span more than one shippable slice?**
   - "Yes, ENG-123 contains schema migration + API + UI" → that ticket becomes multiple goals, in order, inside its chain, until the next slice cannot be chosen responsibly.
   - "No, ENG-124 is a one-PR change" → one goal in its chain.

4. **Is anything unclear about scope?**
   - Surface only pre-planning questions in `plan_questions`. Do not copy branch points into `plan_questions`; branch points belong on the chain. If a missing answer prevents authoring a valid current goal, set `blocks_planning: true`.

## Mapping a ticket to a goal

For each goal produced from a ticket (one ticket may map to 1..N goals):

1. **Title.** Start with the Linear identifier: `<IDENTIFIER>: <short verb-led title>`. If the ticket becomes multiple goals, suffix each with the slice: `ENG-123: schema`, `ENG-123: API`, `ENG-123: UI`.
2. **Goal fields.**
   - `source_refs` — Linear IDs or URLs that justify the goal.
   - `objective` — what this slice delivers.
   - `non_goals` — what it explicitly does not deliver, especially the next chain step.
   - `validation` — acceptance criteria, one per item, restated as evidence intent.
3. **Requirements.** One per explicit acceptance criterion. Each requirement has:
   - `id:` — stable kebab-case ID unique within the goal.
   - `title:` — verbatim restatement as evidence intent.
   - `kind:` — one of `screenshot | video | test-output | note | file | url`. Pick the smallest unambiguous artifact that proves the criterion.
   - `required:` — default `true`; mark `false` only when the deliverable still ships without it.
   - `generation:` — discriminated object:
     - `{ type: manual }`
     - `{ type: command, command: "<shell command>" }`
   - `judgment:` — discriminated object:
     - `{ type: human }`
     - `{ type: llm, model_hint: "<optional model>" }`
     - `{ type: command, command: "<shell command>", expect: "exit-zero | stdout-contains | file-exists" }`
   - `rubric:` — concrete and falsifiable. The judge's checklist, not the spec.

Do not emit a goal unless it has at least one real requirement with a falsifiable rubric. If the ticket lacks criteria, put it in `deferred_items` instead.

Picking `kind`:

- UI/visual outcomes → `screenshot`
- state-transition demonstrations → `video`
- test-driven criteria → `test-output` with command generation and command judgment when a deterministic check exists
- text summaries / decision records → `note`
- non-text artifacts → `file`
- deploys, previews, external refs → `url`

## Output schema

Use this exact shape. Omit optional empty arrays only where noted.

```yaml
version: 1
title: "<Project / theme>: chain plan"
sources:
  - type: linear
    ref: "<Linear ref or project URL>"
plan_questions:
  - id: question-1
    question: "<only include unresolved scope questions that affect this plan>"
    blocks_planning: true
chains:
  - id: chain-a
    title: "<one-line name>"
    summary: "<what this chain accomplishes end-to-end>"
    goals:
      - id: "<stable-kebab-id>"
        source_refs:
          - "<Linear identifier or URL>"
        title: "<IDENTIFIER>: <title>"
        objective: "<what this slice delivers>"
        non_goals:
          - "<what it does not deliver — especially the next chain step>"
        validation:
          - "<criterion 1, restated as evidence intent>"
          - "<criterion 2>"
        requirements:
          - id: req-1
            title: "<verbatim criterion>"
            kind: screenshot
            required: true
            generation:
              type: manual
            judgment:
              type: human
            rubric: "<falsifiable checklist>"
    branch_point:
      after_goal_id: "<last goal id>"
      reason: "<what forks or is uncertain>"
      resume_after: "<concrete resolving event>"
      deferred_source_refs:
        - "<Linear identifier or URL for each fork child not planned now>"
      guidance: "Check back in after this resolves; plan the next chain(s) from the resolved state. Do not pre-plan past this point."
deferred_items:
  - id: "<stable-kebab-id>"
    source_refs:
      - "<Linear identifier or URL>"
    reason: "missing-acceptance-criteria | fork-child | blocked-by-unplanned-decision | unreadable-source"
    needed_to_plan: "<specific information or resolved event needed before this item can become a goal>"
```

If a chain has no branch point, set `branch_point: null`. If there are no plan questions or deferred items, use empty arrays: `plan_questions: []` and `deferred_items: []`.

Rules:

- YAML must be valid and machine-readable.
- Use stable kebab-case IDs for chains, goals, requirements, questions, and deferred items.
- Use arrays for `sources`, `plan_questions`, `chains`, `goals`, `non_goals`, `validation`, `requirements`, and `deferred_items`.
- Branch points appear at chain tails only, never in the middle.
- Do not create a branch point just because later work can split. Branch only when a single next goal cannot be chosen responsibly, or when linearizing would create a fake dependency.
- Chains never declare dependency on each other. Each chain in the document is a self-contained linear track that's unblocked right now.
- If a source ref appears in any `branch_point.deferred_source_refs`, it must not appear in any chain goal in the same plan.
- Do not emit `TODO`, placeholder rubrics, placeholder requirements, or "acceptance criteria missing" goals. Defer those items instead.
- Do not include shell snippets for applying the plan. The plan is the artifact.

## Workflow checklist

1. Confirm scope: which ticket(s) or project. Restate before reading.
2. Pull each ticket's title, description, acceptance criteria, and any dependency annotations (Linear blocks/relates-to, parent issue, sub-issues).
3. List every ticket on a scratchpad with: identifier, one-line summary, dependencies in/out of the input set.
4. Group into chains using the decision rules. Prefer one useful linear path over exposing every possible branch; do not maximize parallelism.
5. For each chain, sequence by dependency and judgment. Truncate only at the first necessary branch point. State the branch in `branch_point`; put fork children in `branch_point.deferred_source_refs` and `deferred_items`.
6. For each goal, draft structured goal fields and requirements. If no explicit acceptance criteria exist, defer the item instead of creating a placeholder goal.
7. Fill `plan_questions` only for unresolved pre-planning questions, not branch-point summaries.
8. Before handing off, self-check: no `TODO`, no placeholder requirements, every goal has at least one real requirement, and no deferred source ref appears as a planned goal.
9. Hand off only the rendered YAML plan.

## Non-goals

- Does not create workspaces.
- Does not move tickets between Linear states.
- Does not paste large Linear descriptions verbatim into rubrics. Distill them; the rubric is the judge's checklist.
- Does not extend a chain past a branch point. Surface the branch instead.
- Does not collapse unrelated tickets into one chain because they're in the same Linear project.
- Does not include application instructions or operational runbooks.

## Reference: chain shape rules

- A chain is a **strictly linear** sequence of dependent or intentionally sequenced goals. Never a tree, never a fork.
- Two goals are in the same chain when one must land before the next, or when doing them in that order is the clearest product/technical path.
- A chain **does not** end merely because multiple later tasks are possible. It ends when choosing the next task would be arbitrary, depends on a runtime/product decision, or would hide genuinely independent work behind a fake order.
- The plan asks the user to check back in after each branch point. Resuming from the resolved state, the next set of chains gets planned then — not now.
- Two chains never share a goal. Two chains never declare a dependency on each other in the plan.
