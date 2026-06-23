# gitspace-linear-breakdown

Agent skill: turn one or more Linear tickets into a machine-readable **GitSpace goal-chain plan**.

## What this skill does

Given Linear ticket(s) — one named ticket, a set, or a Linear project — the agent:

1. Reads the ticket content (via user paste, Linear MCP, or `gitspace/<ws>/issue.md` if already imported).
2. Inventories tickets with their dependencies.
3. Groups them into one or more **strictly linear chains**:
   - Same chain when ordering is required or when a clear product/technical sequence exists.
   - Separate top-level chains only when linearizing would create a fake dependency or serialize unrelated delivery.
4. Sequences each chain by dependency, priority, same-surface cohesion, and risk reduction.
5. **Does not branch just because branching is possible.** If the next step is clear enough, the chain continues. If choosing the next step would be arbitrary, requires an unmade product/technical decision, or would hide unrelated work behind fake ordering, the chain stops and the fork children are deferred.
6. Never declares dependencies between chains and never shares goals between chains.
7. For each planned goal, emits structured objective / non-goals / validation / requirements fields with explicit kind / rubric / generation / judgment.

The deliverable is a single **`plan.yaml`** document. Tickets without explicit acceptance criteria are deferred instead of converted into TODO goals.

## What this skill does **not** do

- Does not create workspaces.
- Does not output application instructions or operational runbooks.
- Does not move tickets in Linear.
- Does not invent acceptance criteria.
- Does not extend a chain past a branch point.
- Does not emit TODO requirements or placeholder goals.

## Install

### Via `skills.sh` / SkillUse

```sh
npx skills add inKibra/gitspace.sh/gitspace-linear-breakdown
```

### Manual copy

```sh
TARGET=~/.claude/skills/    # or ~/.cursor/skills/, ~/.codex/skills/, .agents/skills/
cp -r skills/gitspace-linear-breakdown "$TARGET"
```

## Inputs

The agent reads:
- A user-named ticket (or set of tickets), **or**
- A Linear project / cycle / view

Ticket content can come from:
- User paste (title, description, acceptance criteria)
- A Linear MCP server / CLI available in the host environment
- An already-imported `gitspace/<workspace>/issue.md`

## Output

One YAML document with this shape:

```yaml
version: 1
title: "<Project / theme>: chain plan"
sources:
  - type: linear
    ref: "<ticket refs or project URL>"
plan_questions: []
chains:
  - id: chain-a
    title: "<name>"
    summary: "<what this chain accomplishes>"
    goals:
      - id: "<stable-kebab-id>"
        source_refs: ["<Linear identifier or URL>"]
        title: "<IDENTIFIER>: <title>"
        objective: "<what this slice delivers>"
        non_goals: []
        validation: []
        requirements:
          - id: req-1
            title: "<criterion>"
            kind: screenshot
            required: true
            generation:
              type: manual
            judgment:
              type: human
            rubric: "<falsifiable checklist>"
    branch_point: null
deferred_items: []
```

## Compatibility

Pure planning artifact. The skill emits structured YAML and does not assume a GitSpace runtime.

## License

Inherits the parent repository's license. See `../../LICENSE`.
