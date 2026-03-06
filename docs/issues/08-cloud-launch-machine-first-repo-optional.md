# [P1] Cloud Launch Should Be Machine-First (Repo Optional)

## Problem

`gssh cloud launch` currently requires `--repo` and `--branch`, but cloud runtime is machine-centric and repo/branch are mostly launch metadata.

## Goal

Support cloud machine launch without repo binding, while preserving optional repo/branch metadata.

## Scope

- Make `--repo` optional in CLI.
- Make launch options and provider contract accept missing repo/branch.
- Keep metadata display in `cloud list` when provided.

## Proposed implementation

- `src/cli/commands/cloud.ts`
  - Change `--repo` from required to optional.
- `src/commands/cloud.ts`
  - Make `repo` optional in launch options.
- `src/relay/control/sprites-provider.ts`
  - Align provider input contract with optional repo/branch.
- tests in `src/commands/__tests__/cloud-launch.test.ts`.

## Acceptance criteria

- [ ] `gssh cloud launch` works without `--repo`.
- [ ] Existing repo/branch launch still works unchanged.
- [ ] `cloud list` includes repo/branch only when present.

## Tests

- Launch tests for with/without repo.
- Backward compatibility tests for existing command patterns.
