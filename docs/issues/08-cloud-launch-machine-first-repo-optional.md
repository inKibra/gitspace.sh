# [P1] Cloud Launch Should Be Machine-First (Repo Optional)

## Problem

`gssh cloud launch` currently treats `--repo` / `--branch` like required launch inputs, but cloud runtime is machine-centric and repo/branch are only optional metadata.

## Goal

Support cloud machine launch without repo or branch metadata, while preserving optional repo/branch metadata when explicitly provided.

## Scope

- Make both `--repo` and `--branch` optional in CLI.
- Make launch options and provider contract accept missing repo/branch.
- Reject `--branch` when `--repo` is omitted.
- Keep metadata display in `cloud list` when provided.

## Proposed implementation

- `src/cli/commands/cloud.ts`
  - Change `--repo` from required to optional.
  - Remove the implicit default for `--branch` and treat it as optional metadata.
- `src/commands/cloud.ts`
  - Make `repo` and `branch` optional in launch options.
  - Only accept `branch` when `repo` is present.
- `src/relay/control/sprites-provider.ts`
  - Align provider input contract with optional repo/branch.
- tests in `src/commands/__tests__/cloud-launch.test.ts`.

## Acceptance criteria

- [ ] `gssh cloud launch` works without `--repo`.
- [ ] `gssh cloud launch --repo owner/repo` works without `--branch`.
- [ ] Existing repo/branch launch still works unchanged.
- [ ] `gssh cloud launch --branch main` fails unless `--repo` is also provided.
- [ ] `cloud list` includes repo/branch only when present.

## Tests

- Launch tests for machine-first, repo-only, and repo+branch flows.
- Backward compatibility tests for existing command patterns.
