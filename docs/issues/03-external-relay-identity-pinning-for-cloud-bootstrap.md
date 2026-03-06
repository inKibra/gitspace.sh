# [P0] External Relay Identity Pinning for Cloud Bootstrap

Status: implemented.

## Problem

Cloud bootstrap assumes relay identity data is available in control metadata or local relay identity files. In dedicated-relay topology, the control machine may not have local relay identity material.

Result: cloud launch can fail or become ambiguous.

## Goal

Persist and enforce trusted relay identity metadata for cloud bootstrap in external-relay setups.

## Scope

- Persist relay identity (`relayIdentityId`, signing pubkey, fingerprint) after trust verification when `machine serve start` connects to relay.
- Ensure cloud launch resolves relay identity from pinned control metadata first.
- Fail closed on relay identity mismatch.

## Proposed implementation

- `src/commands/serve.ts`
  - Persist trusted relay metadata after successful trust flow.
-  - Persist a cloud-reachable relay URL separately from the last relay URL used for local reconnects.
- `src/relay/control/store.ts`
  - Reuse `bindControlRelayIdentity()` mismatch checks.
- `src/commands/cloud.ts`
  - Prefer pinned control metadata plus a cloud-reachable relay URL, and fail closed when only a local/private relay URL is saved.

## Acceptance criteria

- [x] Dedicated relay machine + separate control machine can run `gssh cloud launch`.
- [x] Pinned relay mismatch blocks launch with explicit error.
- [x] Cloud launch no longer depends on local relay private identity on control machine.

## Tests

- Integration test: external relay + control node + cloud launch.
- Regression test: pinned relay mismatch fail path.
