# [P0] Cloud Bootstrap Token Hardening

Status: partially implemented.

## Problem

Cloud bootstrap unlock/claim flow needs stronger guarantees against replay/race/incorrect claimant scenarios.

## Goal

Tighten bootstrap security with explicit identity binding and strict token/state invariants.

## Scope

- Bind unlock grants to expected machine identity where possible.
- Enforce single-use + strict expiry + irreversible state transitions.
- Reject stale/replayed unlock requests reliably.

## Proposed implementation

- `src/relay/server.ts`
  - Harden unlock grant checks and machine binding assertions.
- `src/relay/control/store.ts`
  - Strengthen token state machine and consumed semantics.
- `src/cloud/bootstrap-entry.ts`
  - Keep bootstrap client behavior aligned with stricter server checks.

## Acceptance criteria

- [x] Replay of consumed token is rejected.
- [x] Wrong claimant machine cannot complete bootstrap.
- [ ] Race attempts do not produce split/ambiguous ownership of bootstrap path.

## Tests

- [x] Unlock token replay tests.
- [ ] Concurrent claim race tests.
- [x] Expired token rejection tests.

## Notes

- Store-side state invariants are stricter now (`pending` / `vm_created` / `unlock_granted` transitions, workspace status checks, machine key/id consistency checks).
- A broader concurrent-claim regression harness is still worth adding before calling this fully complete.
