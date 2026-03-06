# [P1] Cloud Connect UX: Workspace to Machine Resolution

Status: implemented.

## Problem

`cloud list` is workspace-centric, while `client connect` requires machine ID. Users must manually map workspace to machine.

## Goal

Allow direct connect from cloud workspace identity.

## Scope

- Add `gssh cloud connect <workspace-id>` (or equivalent resolver command).
- Improve `cloud list` output with machine mapping and suggested connect command.
- Handle non-ready states (`bootstrapping`, `error`, `destroyed`) with clear errors.

## Proposed implementation

- `src/cli/commands/cloud.ts`
  - Add `connect` subcommand.
- `src/commands/cloud.ts`
  - Resolve workspace -> machine ID and delegate to remote connect.
- `src/commands/connect.ts`
  - Reuse existing connect path.

## Acceptance criteria

- [x] Users can connect via workspace ID directly.
- [x] Ready-state validation prevents confusing connect failures.
- [x] `cloud list` presents enough info to connect without cross-referencing.

## Tests

- [x] Command tests for connect by workspace ID.
- [x] Error-path tests for non-ready workspace states.
