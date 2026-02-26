# Owner-Only Relay Sync Cutover Plan

Status: locked implementation guide.

This document is the canonical guide for implementing the single-owner relay sync model. If code, CLI behavior, or docs conflict with this plan, change the code/docs to match this plan.

---

## 1) Frozen Execution Plan (Do Not Drift)

1. Freeze the new single-owner contract.
2. Remove multi-user surfaces end-to-end.
3. Add owner config vault model on relay.
4. Implement sync protocol/runtime.
5. Migrate local config/secrets/preference writers.
6. Switch project creation to git-first.
7. Keep GitHub as optional integration.
8. Run compatibility + migration pass.
9. Complete tests + docs sweep.

Implementation order remains:

- Step A: spec + protocol/types scaffolding
- Step B: relay/server auth simplification
- Step C: vault storage + crypto envelope integration
- Step D: sync runtime + lock/revision behavior
- Step E: caller integrations (config/secrets/prefs)
- Step F: git-first lifecycle + UI/API flow
- Step G: migration/tests/docs

---

## 2) Hard Constraints

- Owner-only access model. No collaborator ACL behavior at runtime.
- Invite scope is machine enrollment only (`relay-machine`).
- Four sync categories are required:
  - `fundamental`
  - `integrations`
  - `project/workspace`
  - `preferences`
- Relay records must include metadata:
  - `revision`
  - `updatedAt`
  - `writerId`
  - `checksum`
- Conflict policy is deterministic last-write by timestamp per key.
- Locking model for V1:
  - global lock
  - expected-revision guard on write

---

## 3) Commit-by-Commit Checklist (Strict)

Each commit below has explicit acceptance criteria and a required verification pass.

### C01 - Freeze contract and specs

- Scope
  - Update `docs/REMOTE-DESIGN.md`, `docs/RELAY.md`, `docs/PROTOCOL.md` to owner-only contract.
  - Keep this file as the canonical implementation checklist.
- Acceptance criteria
  - No collaborator ACL language remains in the target docs.
  - Invite language documents `relay-machine` as the only invite type.
  - Four category model and record metadata are documented.
- Verification
  - Manual doc grep confirms removal of `relay-user` and `machine-user` in the updated docs.

### C02 - Remove multi-user CLI surface area

- Scope
  - Remove/retire collaborator grant flows from:
    - `src/cli/commands/relay.ts`
    - `src/cli/commands/machine.ts`
    - `src/cli/commands/invite.ts`
    - `src/cli/commands/user.ts`
    - `src/cli/index.ts`
  - Remove command implementations no longer valid:
    - `src/commands/relay.ts`
    - `src/commands/machine-access.ts`
    - collaborator parts of `src/commands/invite.ts`
- Acceptance criteria
  - No command can add/list/remove human collaborator relay/machine ACL grants.
  - CLI help output does not advertise removed collaborator flows.
  - Enrollment path still exists (`machine enroll --invite`).
- Verification
  - CLI command help snapshots or command tests updated and passing.

### C03 - Relay/server owner-only auth simplification

- Scope
  - Replace ACL-based user authorization in:
    - `src/relay/server.ts`
    - `src/relay/protocol.ts`
    - `src/relay/registries.ts`
  - Remove collaborator persistence in:
    - `src/relay/auth/store.ts`
    - `src/relay/auth/types.ts`
- Acceptance criteria
  - Owner identity can access own machine paths.
  - Non-owner user identities are denied for direct access paths.
  - Protocol no longer accepts collaborator ACL operations.
- Verification
  - `src/relay/server.test.ts` updated for owner allow/non-owner deny.

### C04 - Invite narrowing to machine enrollment only

- Scope
  - Keep only `relay-machine` issue/validate/revoke/list paths in:
    - `src/lib/tmux-lite/crypto/root-invites.ts`
    - `src/commands/invite.ts`
    - `src/relay/server.ts`
  - Remove `relay-user` and `machine-user` handling.
- Acceptance criteria
  - Invite parsing and validation reject removed invite types.
  - Machine enrollment with valid `relay-machine` token still works.
- Verification
  - Invite tests cover valid enrollment invite and invalid old invite types.

### C05 - Handshake and serve authorization cutover

- Scope
  - Remove non-owner callback paths from:
    - `src/lib/tmux-lite/handshake-handler.ts`
    - `src/serve/client-session-manager.ts`
    - `src/serve/types.ts`
    - `src/commands/serve.ts`
    - `src/session/adapters/node-remote.ts`
- Acceptance criteria
  - Runtime authorization decisions are owner-only.
  - `checkUserRootAccess`-style collaborator hooks are removed.
- Verification
  - Remote session attach/connect tests pass for owner paths.

### C06 - Add relay owner vault category model

- Scope
  - Implement category record schema and persistence in:
    - `src/relay/control/schema.ts`
    - `src/relay/control/types.ts`
    - `src/relay/control/store.ts`
    - `src/relay/vault.ts`
- Acceptance criteria
  - Category records are encrypted owner envelopes.
  - Metadata fields exist and are persisted (`revision`, `updatedAt`, `writerId`, `checksum`).
  - Read/write API supports all four categories.
- Verification
  - Unit tests for encrypt/decrypt and CRUD per category.

### C07 - Implement sync runtime (pull/push/compare/lock/unlock)

- Scope
  - Add sync operations and revision guards in relay/session runtime (new modules if needed).
  - Implement `pull`, `push`, `compare`, `lock`, and `unlock` operations.
  - Implement V1 global lock and expected-revision write guard.
  - Implement deterministic conflict merge: last-write timestamp per key.
- Acceptance criteria
  - Client can compare current state, pull, and push with revision checks.
  - Stale expected revision is rejected with retry-safe error.
  - Lock and unlock behavior are enforced in write paths.
- Verification
  - Runtime tests for lock contention, stale revision, and merge behavior.

### C08 - Wire local writers to sync categories

- Scope
  - Map current writers to category sync adapters:
    - `fundamental`: auth and git credential material
    - `integrations`: GitHub/Linear/Sprites settings
    - `project/workspace`: project/workspace bundle/config/secrets
    - `preferences`: CLI and web preference stores
  - Primary touchpoints:
    - `src/core/config.ts`
    - `src/utils/secrets.ts`
    - `src/core/preferences-service.ts`
    - `src/lib/preferences-service.web.ts`
    - `src/commands/auth.ts`
- Acceptance criteria
  - Writes in these flows update local cache and relay sync state.
  - Pull-on-start/connect hydrates local state from relay.
  - Offline startup still works from local cache.
- Verification
  - Integration tests for write-through sync and startup hydration.

### C09 - Switch project lifecycle to git-first (no hard gh dependency)

- Scope
  - Replace GitHub-first repo creation/list assumptions with direct remote URL flow in:
    - `src/commands/add.ts`
    - `src/core/session-lifecycle.ts`
    - `src/lib/remote-session/protocol.ts`
    - `src/lib/remote-session/session-handler.ts`
    - `src/session/backends/local-session-backend.ts`
    - `src/session/backends/remote-session-backend.ts`
  - Remove hard runtime dependency on `gh`/`jq` from core flow:
    - `src/utils/deps.ts`
    - `src/utils/deps.test.ts`
- Acceptance criteria
  - `project add` works with direct git remote URL without GitHub auth.
  - Session lifecycle no longer requires `owner/repo` naming assumptions.
  - GitHub remains available only as optional integration settings.
- Verification
  - End-to-end add/list/remove with non-GitHub git remote passes.

### C10 - Migration and compatibility pass

- Scope
  - Add one-way migration from legacy local keys/state into category vault records.
  - Mark migration complete to avoid repeated import.
  - Ensure old collaborator ACL data does not break startup.
- Acceptance criteria
  - Existing users migrate with no data loss in supported local settings.
  - Old ACL artifacts are ignored or pruned safely.
  - User-facing upgrade messaging is clear.
- Verification
  - Migration tests: first-run migration, idempotent rerun, partial legacy state.

### C11 - UI copy and final docs/tests sweep

- Scope
  - Remove collaborator guidance from:
    - `src/app.web.tsx`
    - `src/app.tui.tsx`
    - `src/components/MachineList.web.tsx`
    - `src/components/MachineList.tui.tsx`
  - Final doc cleanup in:
    - `README.md`
    - `docs/GETTING-STARTED.md`
    - `docs/RELAY.md`
    - `docs/PROTOCOL.md`
    - `docs/REMOTE-DESIGN.md`
- Acceptance criteria
  - No stale collaborator command examples remain in UI or docs.
  - Help text/docs align with owner-only model and git-first flow.
- Verification
  - `bun run typecheck` passes.
  - targeted and full tests run green (or failures are documented separately).

---

## 4) Definition of Done (Must All Be True)

- Owner can bootstrap on a new device, decrypt synced state, and operate without local manual setup.
- No collaborator/multi-user command or relay path remains active.
- Project add works from direct git remote URL (CLI + web path) without `gh`.
- Existing users migrate forward without data loss.

If any single item above is false, the cutover is not done.

---

## 5) Completion Gate Checklist

- [ ] C01 complete and merged.
- [ ] C02 complete and merged.
- [ ] C03 complete and merged.
- [ ] C04 complete and merged.
- [ ] C05 complete and merged.
- [ ] C06 complete and merged.
- [ ] C07 complete and merged.
- [ ] C08 complete and merged.
- [ ] C09 complete and merged.
- [ ] C10 complete and merged.
- [ ] C11 complete and merged.
- [ ] All Definition of Done statements validated with evidence.

---

## 6) Current Branch Progress (Unmerged)

- [x] C01 implemented locally (docs frozen to owner-only contract).
- [x] C02 implemented locally (CLI collaborator grant surfaces removed).
- [x] C03 implemented locally and validated.
- [x] C04 implemented locally and validated.
- [x] C05 implemented locally and validated.
- [x] C06 implemented locally and validated.
- [x] C07 implemented locally and validated.
- [ ] C08 implemented locally and validated.
- [x] C09 implemented locally and validated.
- [ ] C10 implemented locally and validated.
- [ ] C11 implemented locally and validated.

Known temporary gaps on current branch:

- C08-C11 work remains (writer integration, migration, final docs/UI sweep).

---

## 7) Build Rule While Executing This Plan

Do not add compatibility branches that preserve collaborator ACL runtime behavior. Remove old behavior and move forward to the owner-only sync model.
