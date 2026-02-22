<!-- 433ff376-9e02-49ba-8515-3893acaa22e2 -->
---
todos:
  - id: "snapshot-branch"
    content: "Create a safety backup pointer for current cloud-agents tip"
    status: pending
  - id: "rebase-onto-develop"
    content: "Rebase cloud-agents onto latest origin/develop and resolve conflicts"
    status: pending
  - id: "resolve-hotspots"
    content: "Manually merge src/index.ts and README.md preserving review + cloud command/docs"
    status: pending
  - id: "validate-rebase"
    content: "Run typecheck/build/targeted tests and CLI smoke help checks"
    status: pending
isProject: false
---
# Rebase Prep: `cloud-agents` onto `origin/develop`

## Current State
- Branch: `cloud-agents` (ahead of `origin/cloud-agents` by 1 commit).
- Divergence vs `origin/develop`: `cloud-agents` has 2 commits (`af4bc12`, `216521d`), `origin/develop` has 1 commit (`8754eb5` - review workflow).
- Highest-risk overlap files:
  - `src/index.ts` (both sides add substantial CLI command wiring)
  - `README.md` (both sides add command/docs sections)

## Rebase Strategy
1. Create a fresh safety branch/tag from current `cloud-agents` tip before any rebase attempt.
2. Update remote refs, then start rebase onto latest `origin/develop`.
3. Resolve conflicts by preserving **both** feature areas:
   - Keep develop’s review command tree (`review` / `space review` command registration).
   - Keep cloud control command tree (`cloud status/list/setup/launch/stop/resume/destroy`).
4. Continue rebase, then run focused validation (typecheck + targeted tests).

## Conflict Resolution Focus
- `src/index.ts`
  - Ensure both imports and command registration paths remain present:
    - review commands from `./commands/review.js`
    - cloud commands from `./commands/cloud.js`
  - Verify no command name collisions and both command groups are reachable from top-level CLI.
- `README.md`
  - Keep both documentation surfaces:
    - review workflow usage examples
    - cloud control command table and setup notes

## Verification After Rebase
- Run baseline checks:
  - `bun run typecheck`
  - `bun run build`
- Run targeted tests for touched areas:
  - cloud: `src/commands/__tests__/cloud-lifecycle.test.ts`, `src/commands/__tests__/control-socket.test.ts`
  - review/session: `src/core/__tests__/github-review.test.ts`, `src/session/__tests__/workspace-shell-hooks.test.ts`, `src/session/__tests__/workspace-shell-hooks.integration.test.ts`
  - relay stability: `src/relay/server.test.ts`, `src/relay/__tests__/protocol-validation.test.ts`
- Smoke test CLI command discovery:
  - `gssh review --help`
  - `gssh cloud --help`

## Success Criteria
- Rebase completes with no dropped command surfaces.
- `src/index.ts` exposes both review and cloud command families.
- `README.md` documents both sets of features.
- Typecheck/build/tests pass for cloud + review paths.