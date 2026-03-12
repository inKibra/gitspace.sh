# [P0] Deterministic Hosted Relay Startup

Status: implemented.

## Problem

`gssh relay start` can attempt hosted startup and then silently degrade to local-only relay behavior when hosted prerequisites fail.

That breaks onboarding expectations and makes docs hard to trust.

## Goal

When users choose hosted mode, startup must be deterministic:

- either return a public relay URL (`wss://<subdomain>.gitspace.sh/ws`)
- or fail fast with actionable errors

## Scope

- Add explicit startup mode:
  - `--mode hosted` (strict)
  - `--mode auto` (backward-compatible behavior)
  - `--mode local` (no hosted assumptions)
- In hosted mode, fail on:
  - missing subdomain
  - missing/failed tunnel token fetch
  - missing `cloudflared`

## Proposed implementation

- `src/cli/commands/relay.ts`
  - Add `--mode` option and help text.
- `src/commands/relay.ts`
  - Refactor startup path by mode.
  - Keep fallback only for `auto` mode.
  - Standardize printed endpoint for websocket usage.

## Acceptance criteria

- [x] `gssh relay start --mode hosted` never silently downgrades.
- [x] Hosted success prints public URL.
- [x] Hosted failure prints exact remediation commands.
- [x] `--mode local` works without hosted checks.

## Tests

- Startup tests for hosted/auto/local mode matrix.
- Multi-subdomain selection tests for deterministic behavior.

## Follow-up

- Relay owner binding no longer pre-marks the vault as initialized.
- First unlock now repairs legacy incomplete vault metadata created by the earlier startup bug.
