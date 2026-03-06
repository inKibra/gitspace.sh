# [P1] Non-Interactive Golden Path

## Problem

Prompt-heavy identity/trust/connect paths make automation difficult, even for users who want a deterministic script-based setup.

## Goal

Provide a realistic unattended setup path for hosted relay + machine attach + client connect list.

## Scope

- Normalize `--yes` behavior across auth/serve/connect/invite/enroll flows.
- Add `--password-stdin` where missing.
- Add `--non-interactive` fail-fast mode with explicit missing-input errors.

## Proposed implementation

- `src/commands/auth.ts`
- `src/commands/connect.ts`
- `src/commands/invite.ts`
- `src/commands/machine-enroll.ts`
- corresponding CLI command definitions

## Acceptance criteria

- [ ] End-to-end setup possible without interactive prompts.
- [ ] Commands fail fast with explicit missing-input diagnostics in non-interactive mode.
- [ ] Docs include both interactive and automation sequences.

## Tests

- Command tests for non-interactive failure/success branches.
- Scripted end-to-end smoke test in CI (or local integration harness).
