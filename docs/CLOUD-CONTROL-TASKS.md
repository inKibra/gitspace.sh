# Cloud Control Relay Tasks

Status: in progress
Owner model: single owner (control host operator)

## Phase 0 - Docs and contract

- [x] Define architecture direction (relay as data plane + control plane)
- [x] Lock single-owner model for V1
- [x] Update `docs/GETTING-STARTED.md` with canonical owner setup flow
- [x] Update `README.md` remote access flow and identity-first requirement

## Phase 1 - Control store foundation

- [x] Add persistent control store schema and migrations (Bun SQLite + migration table)
- [x] Add control context initialization on relay startup (hosted serve path initializes control store)
- [x] Add stable relay identity behavior for control mode

## Phase 2 - Owner binding and authz

- [x] Persist owner identity binding in control store
- [x] Enforce owner-only control operations (owner assertion command over serve socket added)
- [x] Add tests for allow/deny behavior (owner bind + mismatch tests)

## Phase 3 - Secret vault and bundle memory

- [ ] Add encrypted secret storage on control host
- [ ] Store provider/workspace/bundle secret references
- [ ] Add redaction rules and no-argv secret handling

## Phase 4 - Cloud provider integration

- [x] Add Sprites provider adapter
- [x] Add launch/stop/resume/destroy lifecycle
- [ ] Add reconciliation loop (provider status + relay connection + persisted state)

## Phase 5 - Workspace setup and agent bootstrap

- [x] Add remote setup protocol messages
- [x] Add setup handlers and progress events
- [ ] Add agent start/status plumbing

## Phase 6 - CLI commands

- [x] Add `gssh cloud status`
- [x] Add `gssh cloud setup`
- [x] Add `gssh cloud launch`
- [x] Add `gssh cloud list`
- [x] Add `gssh cloud stop/resume/destroy`

## Phase 7 - Hardening

- [ ] Add persistence/reconciliation/secret-redaction tests
- [ ] Add orphan cleanup and retry policies
- [ ] Final docs pass and operator runbook
