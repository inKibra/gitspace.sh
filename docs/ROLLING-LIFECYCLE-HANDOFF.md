# Rolling lifecycle repair handoff

Recorded 2026-09-15. Intended recipient: the existing agent for this GitSpace source workspace.

## Status and scope

The original WalGit multipart work and the later native publication repair are complete. The extended cloud-image proof was stopped at the user's direction. Both disposable cloud machines and all three disposable proof projects were deleted. Source-level rolling lifecycle defects were then repaired and verified locally, without recreating cloud machines or testing against real workspaces.

**The lifecycle repair is committed and pushed, but not deployed.** Persisted logging was enabled separately on the existing tenant Worker through a settings-only API update. Do not confuse that configuration change with deployment of the new diagnostic code.

The user explicitly objected to scope drift, repeated broad builds/rollouts, and time spent recovering disposable tests. Keep subsequent work focused. This handoff asks you to absorb the state, not to start another rollout or cloud experiment.

## Repository and workspace

- Repository: `inKibra/gitspace.sh`.
- Branch: `fix/session-recovery-bounded-history`; not merged into the default branch.
- Repair commit: [`ab0329de4f860a378fb61e40103ff1874c58d9f7`](https://github.com/inKibra/gitspace.sh/commit/ab0329de4f860a378fb61e40103ff1874c58d9f7), **Fix rolling replacement boundaries and persist lifecycle diagnostics**.
- Previous publication-repair HEAD: `0dca75ac29742f8f31ed2cd3320b09e747cd34ba`.
- Project: `gitspace-source-172feb8f-a1db-4d6f-a592-1c98407ade35`.
- Workspace: `session-recovery-and-bounded-history-d12cdb7f`.
- Checkout: `/home/bradleat/gitspace/spaces/gitspace-source-172feb8f-a1db-4d6f-a592-1c98407ade35/session-recovery-and-bounded-history-d12cdb7f`.
- Existing workspace agent session: `21e1bbcd-9f24-48a1-8e2f-63f6b404aba3`.

The repair commit contains only its 14 named source/test/documentation files. Unrelated, uncommitted compaction changes were deliberately excluded. They include OMP patches/session code, account-web shell/live app, core handlers/status tests, protocol activity/execution/status/RPC contracts, workflow documentation, and new compaction tests. Preserve them; do not reset or blanket-stage the checkout.

## What changed

### Native process replacement

Primary implementation: `packages/account-machine/src/replacement-environment.ts`.

1. Replacement now requires `/__control/retire` to return a valid `stopMode: "replace"` acknowledgement before SIGTERM. Previously errors and non-success responses could be ignored even though ordinary runtime shutdown releases workspace ownership. A retirement refusal leaves the predecessor alive and restores its RPC admissions.
2. The host's `DeploymentJournal` now lives in `deployment.db`, outside the runtime database rollback set. Previously it held a WAL connection to `gitspace.db` while that file was copied and later unlinked during rollback.
3. Existing deployment run and step records migrate to the new journal. Destination records commit before legacy tables are dropped; repeated migration does not overwrite newer destination recovery state. Interrupted/finalizing records are preserved.
4. Runtime snapshots use SQLite `VACUUM INTO`, including committed WAL pages. Busy or snapshot errors propagate rather than silently producing an incomplete checkpoint.
5. A candidate that exits, closes stdout, or misses readiness is reaped before database rollback. No untracked failed candidate may keep writing the shared runtime database during restore.
6. Readiness is bounded at 120 seconds, retirement and health HTTP requests at 30 seconds, and graceful shutdown at 120 seconds. Shutdown timeout does **not** force-kill the predecessor. It retains the tracked child and keeps admissions fenced; checkpoint/start/restore cannot proceed while the old writer may still be alive. Retrying does not re-retire or re-signal an already-stopping child.

Additional native files:

- `src/runtime.ts`: generation, ownership, checkout-presence, and replacement-fence diagnostics; stale projection safety checks remain intact.
- `src/cloud-space-authority.ts` and `src/cloud-request-diagnostics.ts`: bounded public-error decoding and correlation for failed object downloads, including machine, object key, request nonce, and validated Cloudflare Ray ID. Existing decoder limits are 8 KiB and a one-second error-body deadline. Do not log signing material, arbitrary extra response fields, or credentials.

### Cloud VM/provider lifecycle

Implementation: `packages/sandbox-worker/src/index.ts`.

Cloudflare VM stop is an ephemeral-disk-loss boundary, unlike swapping a native child process. Official reference: https://developers.cloudflare.com/containers/concepts/architecture/#persistent-disk.

- Running VM sleep requires `checkpointPrepared`, except a never-started staged image. Already-stopped sleep remains idempotent. Explicit destruction/discard remains separate and does not require a checkpoint.
- Enrollment retries cannot bypass the prepared-source restart fence; enforcement is in the shared launch path.
- Preparation and cancellation use direct container TCP fetch, not SDK `containerFetch`, which can start a stopped VM and replay requests. A stopped VM is rejected without booting a fresh disk. Direct control has a five-minute deadline and no automatic retry.
- Cancellation must acknowledge `prepared: false` for the enrolled machine before clearing the fence.
- A health response arriving after observed VM stop cannot publish that machine online.
- A never-started inherited image retains preparation authority through sleep, so a later enrollment export remains valid.
- Structured `sandbox.lifecycle` records cover operation boundaries, VM readiness/stops/errors, stop/destroy requests and confirmations, host process state, and native generation readiness. SDK port-ready is not labeled proof of a newly created VM. Diagnostics metadata-read failures do not fail the lifecycle operation.

The existing confirmed-stop acknowledgement, per-machine immutable image selection, and account workspace-restoration admission barriers remain in place.

### Tenant orchestration and logging configuration

- `packages/account-worker/src/sandbox-rollout.ts`: `cloud_image_operation` and `cloud_image_provider_request` events identify phases, barriers, resumed workspace IDs, request IDs, HTTP status, elapsed time, and CF Ray where available. Provider bodies and enrollment credentials are not logged.
- `packages/platform/src/deployer.ts`: tenant Worker upload metadata now explicitly enables persisted invocation/application logs and query-string redaction.
- `packages/platform/src/compute-images.ts`: immutable provider Worker upload metadata includes the same observability configuration. Observability is part of its content-addressed identity so old cached providers are not silently reused as if they had the new configuration.
- `README.md` and `packages/docs/src/concepts.mdx`: document native versus VM replacement, independent per-machine image selection, checkpoint boundaries, and diagnostic event names.

## Live changes already made

### Disposable cleanup — completed and read back

Destroyed through supported signed account control APIs:

- `sandbox-0b7d5278` — proof A.
- `sandbox-62523e14` — proof B.

Deleted through supported project deletion:

- `tenant-image-b-diagnostics-7456e5d6-a0d656e6`.
- `tenant-image-live-proof-a-f18be16e-fd5001a9`.
- `tenant-image-live-proof-b-41573d58-168a3c9d`.

Pre-deletion inventory verified those machines held only the disposable projects. Post-deletion readback showed no proof machines or projects. Remaining machine: **Darktop**, `m-021d0c06-bf17-41de-ace7-4779e2ab5e9b`. Remaining projects: the real GitSpace source project and `inkibra-core-af58c70d`. No disposable data recovery was attempted. Cached image/provider resources were not indiscriminately removed.

### Persisted tenant Worker logs — enabled now

- Account origin: `https://bradleat.gitspace.sh`.
- Dispatch namespace: `gitspace-rebuild-20260913`.
- Script: `gitspace-rebuild-20260913-tenant-bradleat`.
- Before the change, the deployed script's `observability` was null despite enabled logging in local Wrangler configuration.
- A settings-only PATCH enabled observability, full sampling, persisted invocation/application logs, and query-string redaction.
- GET readback confirmed the configuration and all **33 bindings unchanged**. No Worker code upload or container rollout occurred.

API reference: https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/subresources/settings/methods/edit/.

New source-level lifecycle events will only appear after their owning components are deployed. Logging configuration on the current tenant Worker is not evidence that the new native/provider code is live.

## Verification performed

All results below passed against the repair source. The tests use local fixtures and real child processes where noted, not real cloud proof machines.

- Four native test files, each in its own Bun process:
  - `packages/account-machine/test/replacement-environment.test.ts`.
  - `packages/account-machine/test/cloud-space-authority.test.ts`.
  - `packages/account-machine/test/runtime-bootstrap.test.ts`.
  - `packages/account-machine/test/release-follower.test.ts`.
- Final replacement-environment suite: **11 tests passed**. It exercises real spawned children for successful replacement, failed-candidate database rollback followed by a successful subsequent commit, retirement refusal preserving predecessor reachability, and reaping a live candidate that closes stdout. The shutdown-timeout regression shortens the timer while retaining real processes; it proves the predecessor remains alive and fenced. WAL snapshot and interrupted-journal migration invariants are covered.
- Sandbox provider lifecycle: **21 tests passed**.
- Account cloud-image rollout: **9 tests passed**, including independent-machine behavior and keeping admission closed when workspace restoration fails.
- Platform image/deployment tests: **20 tests passed**. The deployment test now checks tenant binding/migration contracts rather than pinning the entire incidental upload metadata object.
- `tsgo --noEmit` passed for `account-machine`, `sandbox-worker`, `account-worker`, and `platform`.

Native isolated command:

```sh
bun scripts/test-isolated.ts packages/account-machine/test/replacement-environment.test.ts packages/account-machine/test/cloud-space-authority.test.ts packages/account-machine/test/runtime-bootstrap.test.ts packages/account-machine/test/release-follower.test.ts
```

Worker verification used Vitest under a verified Node 24.21.0 binary. Node was absent from PATH; the temporary binary and verification directory were removed afterward. Do not reuse the deleted temporary path or substitute Bun to run Wrangler-backed tests: earlier Bun-hosted Wrangler preview behavior was unreliable. Use a supported Node runtime and the package's Vitest configuration.

No new cloud end-to-end acceptance test was performed. No claim of live rollout success follows from the local results.

## Earlier completed work — do not restart it

- WalGit is pinned to upstream revision `6465bf578d0bc9686019bc6d4537861ab162ee6a`; the maintained multipart repair was integrated into native and container build paths. The native repair had already reached the physical machine.
- The original retained inkibra workspace, `typia-narrow-combined-compiler-programs-c809efc0`, retained all **6,261 files**, Git HEAD/status, and Goal; its checkpoint was published and recovery errors cleared. It is not a test fixture.
- The native publisher hang was repaired separately: abortable bounded S3 operations, multipart cleanup, platform publication deadline, and CI job deadline. All four `native-2f7eca2` publications completed using retained artifacts, without rebuilding or activating the stable channel. Successful action runs were `34930716987` and `34930826978`.
- Do not rebuild or republish unchanged artifacts merely to repeat that proof.

## Remaining uncertainty and deployment boundary

The historical cause of proof B's missing `/workspace/spaces` and cloud generation 3 versus local generation 0 is **not established**. The discovered WAL and lifecycle defects are real, but are not proof of why its checkout files disappeared. Likewise, the original native artifact HTTP 400 lacks enough retained server detail to identify its exact cause. New diagnostics are intended to make subsequent failures attributable.

The last inspected physical runtime before this source-only repair was `2f7eca284647df3e4a540df7af126f8f9d06660a-dirty.8fbec9881f97`, native generation `sha256:3baff75db9c6529ddbf43a2c62c8195c356666593a3c1e05fd16474511c2b2d0`. Treat this as historical inspected state, not a fresh fleet assertion.

The account/application control plane is already separate from platform infrastructure. Do not restart a broad thin-platform redesign. Per-machine provider-image replacement and native runtime replacement are separate operations with different disk semantics.

If deployment is subsequently authorized:

1. Preserve the user's unrelated work and inspect the current selected releases/holders before touching them.
2. Use the existing tenant/application deployment authority for account-owned targets. Shared platform deployment is separate; the metadata-upload fixes live in platform code.
3. Provider lifecycle changes require the corrected provider Worker implementation to be selected through the existing immutable provider-image preparation path. Do not mutate a shared app under unrelated machines.
4. Verify the exact changed boundary with correlated logs. Check native readiness **and** restoration of the operation's recorded workspace set before treating a cloud image update as complete.
5. Do not create another broad cloud proof fleet, recover deleted fixtures, or roll Darktop as part of merely reading this handoff. Obtain a concrete deployment/validation instruction first.

## Durable journal evidence

This workspace's typed journal records the transition and verified outcome:

- Sequence **45**: extended cloud-image proof ended explicitly incomplete; disposable cleanup recorded.
- Sequence **46**: local rolling lifecycle repair started.
- Sequence **47**, entry `4b33f187-566c-4073-9d93-f04071de6d4e`: repair ended with commit identity, cleanup/logging changes, verification, and remaining uncertainty.
- Sequence **48**: this handoff phase started.

Read this document as the handoff snapshot. The journal is the durable narrative of what was actually done; neither it nor this document authorizes additional infrastructure mutations.
