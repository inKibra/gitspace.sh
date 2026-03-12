# [P0] Cloudflared Preflight and Install UX

## Problem

Hosted relay and hosted serve flows require `cloudflared`, but checks happen late and install guidance is inconsistent.

## Goal

Fail early and clearly when `cloudflared` is missing, with platform-aware install instructions.

## Scope

- Add preflight helper command (`gssh doctor relay` or `gssh deps cloudflared`).
- Run preflight automatically in hosted relay/serve startup paths.
- Improve install instructions for macOS and Linux.

## Proposed implementation

- `src/utils/cloudflared.ts`
  - Add `getCloudflaredInstallHint()` helper.
- `src/commands/relay.ts`
  - Preflight in hosted mode before startup.
- `src/commands/serve.ts`
  - Preflight for hosted tunnel path.
- CLI command registration for explicit doctor/deps command.

## Acceptance criteria

- [ ] Missing `cloudflared` is reported before startup attempts.
- [ ] Error message includes install guidance for current platform.
- [ ] Hosted path does not continue past failed preflight.

## Tests

- Unit tests for install hint resolution by platform.
- Command tests for preflight failure output and exit behavior.
