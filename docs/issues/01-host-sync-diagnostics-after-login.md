# [P0] Host Sync Diagnostics After Login

Status: implemented.

## Problem

`gssh user auth login` can succeed while host sync fails silently. Users then expect hosted relay/tunnel flows to work but discover missing setup later.

Current pain point: host sync currently ignores many failures in best-effort mode.

## Goal

After login, show an explicit hosted readiness summary:

- active reserved subdomain present/missing
- tunnel token present/missing
- serve tunnel token present/missing
- exact fix command for each missing item

## Scope

- Make `syncHostConfig()` return structured diagnostics (not silent catch-all).
- Surface diagnostics in `authLogin()` output.
- Add optional `gssh user host doctor` for explicit checks.

## Proposed implementation

- `src/commands/host.ts`
  - Return `{ ok, warnings[], checks{} }` from sync path.
  - Keep compatibility for callers that only need side effects.
- `src/commands/auth.ts`
  - Print concise post-login readiness state.
- `src/cli/commands/user.ts` (optional)
  - Add `user host doctor` command.

## Acceptance criteria

- [x] Login output clearly states whether hosted relay is ready.
- [x] Missing host token/subdomain states are visible and actionable.
- [x] No silent failures for token/subdomain fetch in normal login flow.

## Tests

- Unit tests for sync result classification.
- Command tests for post-login output in success/degraded/fail states.
