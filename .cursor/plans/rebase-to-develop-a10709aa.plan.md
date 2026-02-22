<!-- a10709aa-0796-4375-b78e-3227ae23491d -->
---
todos:
  - id: "preflight-safety"
    content: "Fetch origin, verify clean tracked state, create backup branch before history rewrite"
    status: pending
  - id: "run-rebase"
    content: "Rebase `cloud-agents` onto `origin/develop` and resolve conflicts incrementally"
    status: pending
  - id: "resolve-hotspots"
    content: "Merge both sides' logic in `src/index.ts` and `src/commands/serve.ts` without dropping features"
    status: pending
  - id: "validate-rebase"
    content: "Run typecheck and targeted command/serve tests to confirm merged behavior"
    status: pending
  - id: "publish-safely"
    content: "Review rewritten commits and push with `--force-with-lease` if acceptable"
    status: pending
isProject: false
---
# Rebase `cloud-agents` Onto `origin/develop`

## Current divergence snapshot
- Current branch: `cloud-agents` (`HEAD` = `6b8e476`)
- Rebase target: `origin/develop` (`aaaa41d`)
- Merge base: `4f874ff` (`rc.19`)
- Commits to replay (in order):
  - `b512906` Add cloud control lifecycle and harden bootstrap token flow
  - `fb43870` wip
  - `6b8e476` Update control_meta test for schema v3
- Likely conflict files (changed on both branches since merge base):
  - `src/commands/serve.ts`
  - `src/index.ts`

## Plan
1. **Preflight + safety checkpoint**
- Confirm clean tracked working tree and branch position (`cloud-agents`).
- Refresh remote refs (`git fetch origin`) so `origin/develop` is current.
- Create a safety pointer before rewriting history (e.g. `git branch backup/cloud-agents-pre-rebase`).

2. **Run the rebase**
- Execute: `git rebase origin/develop` (non-interactive, preserving current commit order).
- Resolve conflicts commit-by-commit and continue with `git rebase --continue`.

3. **Conflict resolution focus**
- `src/index.ts`: keep both feature sets registered in CLI wiring:
  - develop-side additions (events/process commands + process runner internal path)
  - branch-side additions (cloud command group + serve bootstrap/unlock/workspace-id flags)
- `src/commands/serve.ts`: preserve both behavior tracks together:
  - develop-side process-hosting/serve-tunnel logic
  - branch-side cloud bootstrap/unlock/control-store + relay identity flow
- Prefer semantic merges (retain both capabilities) over taking one side wholesale.

4. **Validate rebased branch**
- Run typecheck and targeted tests around touched areas.
- Minimum validation: `bun run typecheck`.
- High-value targeted tests:
  - `src/commands/__tests__/cloud-lifecycle.test.ts`
  - `src/commands/__tests__/control-socket.test.ts`
  - any serve/process hosting tests affected by merged `serve.ts` paths.

5. **Finalize + publish safely**
- Inspect rewritten history (`git log --oneline --decorate origin/develop..HEAD`).
- If branch is shared remotely, push with lease protection: `git push --force-with-lease`.
- If issues appear, recover instantly via the backup branch or `git rebase --abort` (while mid-rebase).

## Notes
- The untracked `.cursor/` directory should not block rebase, but tracked file modifications would.
- Main risk is behavioral regression in `serve` startup paths because both sides introduce large changes there; validate both cloud-control and process-hosting code paths after rebase.