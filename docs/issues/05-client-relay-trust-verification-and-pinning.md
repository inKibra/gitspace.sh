# [P0] Client Relay Trust Verification and Pinning

Status: implemented.

## Problem

Client flows (`client connect`, `client machines list`) need explicit relay identity verification parity with serve/enroll trust flows.

## Goal

Require relay trust on client side (TOFU or explicit pubkey) and reject key mismatch by default.

## Scope

- Add client relay identity verification flow.
- Integrate with trusted relay store.
- Add optional `--relay-pubkey` override for explicit trust.

## Proposed implementation

- `src/commands/connect.ts`
  - Verify relay identity before sending authorization messages.
- `src/session/backends/remote-session-backend.ts`
  - Ensure relay identity handshake event is available to client command path.
- Trusted relay utilities in `src/core/`.

## Acceptance criteria

- [x] Unknown relay requires explicit trust confirmation or pubkey.
- [x] Relay key mismatch fails connection by default.
- [x] Client list/connect have consistent trust behavior.

## Tests

- [x] TOFU accept/reject tests.
- [x] Key rotation mismatch tests.
- [x] Explicit pubkey mode tests.
