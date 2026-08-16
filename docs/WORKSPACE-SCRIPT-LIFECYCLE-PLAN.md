# Workspace Script Lifecycle / Bundle Readiness Plan

## Problem statement

Workspace lifecycle scripts currently fire from the wrong UI event and have weak persisted idempotence semantics:

- Switching between already-open workspaces in the Workspace Detail top strip runs setup/select through the web `mode: 'open'` path.
- `select` always runs in `runWorkspaceScripts`, even when the same bundle/script/config inputs already succeeded.
- `setup` reruns automatically after an unchanged failure because only `setup.status === 'success'` suppresses setup.
- Bundle refresh can save a required secret, then immediate workspace entry still reports the secret missing because bundle readiness reads stale process-local secret cache.
- Bottom/status bar script output is a flat latest-phase view. Phase boundaries and individual script names are not streamed into the task transcript, so earlier script output appears hidden by later output.
- `mode: 'open'` can fall back to explicit rerun behavior, which makes passive open equivalent to manual setup-select rerun on unsupported backends.

## Desired invariant

Opening/activating a workspace is different from viewing/selecting an already-open workspace.

- Passive UI navigation, including Workspace Detail top-strip A -> B switching, must not run scripts.
- Automatic lifecycle checks must be idempotent and driven by persisted lock/fingerprint state.
- Explicit user commands such as "Run Workspace Scripts" must remain able to rerun selected phases.
- Bundle readiness must use fresh secret state after refresh/config updates.
- Status/task transcript must show all script phases/scripts that actually ran.

---

## Review-required amendments incorporated

The review panel found no disagreement with the broad direction, but required these constraints before implementation:

1. **Fresh secret tests must reproduce cross-process staleness.** A same-process `setProjectSecret()` test is insufficient because `setProjectSecret()` refreshes and updates the current cache. Tests must mutate the backing test secret store outside the current module cache or use separate writer/reader processes, then assert plan/config/readiness sees the saved secret without `clearSecretsCache()`.
2. **Fresh secret reads must preserve legacy fallback.** `fresh: true` must run the same unified-blob, legacy project-blob, and legacy per-secret fallback/migration logic as normal reads, but starting from a freshly loaded unified blob.
3. **No raw secret fingerprints in `gitspace.lock`.** Do not store deterministic hashes/truncated hashes of secret values. For this iteration, use **presence-only secret invalidation** for lifecycle fingerprints: required secret key present vs missing participates in setup/select fingerprints; secret value changes alone do not auto-invalidate scripts unless a later design adds non-synced per-secret generation/HMAC metadata. Tests must assert lock/log/operation output never contains secret values or raw unsalted secret hashes.
4. **Phase fingerprints must be concrete.** Add one centralized script-manifest fingerprint builder that matches actual discovery semantics: phase name, phase directory absent/present/empty state, sorted executable script relative paths, executable bit/eligibility, and file content hashes. Do not use mtimes.
5. **Write attempted fingerprints on success and failure.** Setup/select lock entries must record the attempted fingerprint for both successful and failed runs, including explicit reruns. Unchanged failure suppression depends on this.
6. **Define automatic lifecycle outcomes and cut over API/RPC contracts.** `SessionBackend.runWorkspaceOpenScripts`, local backend, remote client/server protocol, and remote operation handling must carry a discriminated outcome: `ran`, `skipped-current`, `blocked-previous-failure`, or `failed`, with phases run/blocked. Passive UI must not create a bottom-bar task/toast/modal for `skipped-current` or `blocked-previous-failure`. Remote `run_workspace_open_scripts` must not create/persist a `workspace.scripts` operation, emit `operation_accepted`, or feed `workspaceOperationsToRemovalTasks` for no-op/blocked passive outcomes; operation acceptance starts only once scripts actually run, or task mapping explicitly suppresses no-op operation records.
7. **Setup/select dependency must be explicit.** If setup reruns or setup fingerprint changes, select must be invalidated by including setup fingerprint/status in the select fingerprint or by forcing select after changed setup. Automatic select must not run when required setup is failed/missing.
8. **Define setup-required semantics.** Tests must cover no setup scripts, `noSetup: true`, setup failure with no select scripts, and setup failure with select scripts.
9. **Passive unsupported open is no-op.** If a passive open caller has no `runWorkspaceOpenScripts`, it must not call rerun, create a task, toast, or modal. Explicit user commands may report unsupported.
10. **Bottom-bar output routing must use workspace/task identity.** Do not append script output to every running task. Preserve/use `workspaceId` or operation id so concurrent tasks cannot receive each other’s logs.
11. **Durable remote operation transcript is the source of truth when present.** Live script output and operation snapshots must not duplicate logs for the same remote operation. Reconnect/snapshot tests must show phase/script banners persist in `outputBase64`.
12. **Top-strip regression must exercise the actual UI path.** A helper-only test is not enough; test the Workspace Detail strip selection/callback chain or an extracted wrapper that proves no `runWorkspaceOpenScripts`/task start occurs.

---

## Phase 1: Fresh secret reads for bundle readiness

### Scope

Fix bundle refresh / missing secret disagreement before changing lifecycle gating.

### Current code paths

- Refresh submission:
  - `src/core/bundle-refresh.ts`
  - `applyBundleRefreshSubmission(...)`
  - `refreshBundle(...)`
  - `applyBundleConfigSubmission(...)`
  - writes via `setProjectSecret(...)`.
- Readiness check:
  - `src/core/workspace-lifecycle.ts`
  - `ensureBundleReady(...)`
  - calls `getBundleRefreshPlan(...)` when bundle hash matches baseline.
- Plan/config-state checks:
  - `src/core/bundle-refresh.ts`
  - `getBundleRefreshPlan(...)`
  - `getBundleConfigState(...)`.
- Secrets cache:
  - `src/utils/secrets.ts`
  - `getProjectSecrets(...)` uses cached unified blob.
  - script runner manually calls `clearSecretsCache()` before reading script secrets.

### Implementation plan

1. Add an explicit fresh-read option to project secret reads. Fresh mode must begin from a freshly loaded unified blob and still execute the existing legacy project-blob and per-secret fallback/migration path:
   - `getProjectSecret(projectName, key, options?: { fresh?: boolean })`
   - `getProjectSecrets(projectName, keys, options?: { fresh?: boolean })`
   - Internally use `loadProjectSecretsBlob(projectName, { fresh: options?.fresh })` or equivalent.
2. Update bundle requirement checks to use fresh reads:
   - `getBundleRefreshPlan(...)` when checking secret steps.
   - `getBundleConfigState(...)` when displaying existing/missing secret state.
   - Any helper under `bundle-refresh.ts` that computes required secret steps.
3. Avoid scattering `clearSecretsCache()` calls unless unavoidable; prefer explicit fresh read at the requirement boundary.
4. Preserve existing script-runner `clearSecretsCache()` behavior for script env assembly.

### Tests

Add/adjust tests in `src/core/__tests__/bundle-refresh.test.ts` and/or `src/utils/__tests__/secrets.test.ts`:

- Plan sees a secret saved by an external writer after a stale cached read:
  1. prime/read missing secret state in the reader process/module,
  2. mutate the backing test secrets store outside that reader cache or write from a separate process,
  3. call `getBundleRefreshPlan` without `clearSecretsCache()`,
  4. assert the required secret step is gone and details no longer mention it.
- Config state sees a freshly saved secret.
- Existing legacy secret migration behavior still works with `fresh: true`.

### Phase definition of done

- After entering a required secret through bundle refresh/config update, immediate readiness/plan checks do not report it missing.
- `getBundleRefreshPlan` and `getBundleConfigState` agree with script env secret lookup.
- No test relies on manually clearing the cache to make bundle readiness pass.
- Existing bundle refresh tests still pass.

### Phase review rubric

- Correctness: required secret detection uses fresh persisted state, not stale process cache.
- Compatibility: existing callers that want cached reads still work.
- Safety: fresh reads do not drop legacy fallback/migration behavior.
- Maintainability: fresh-read semantics are explicit in function options, not hidden side effects.

---

## Phase 2: Bottom-bar script transcript visibility

### Scope

Improve the status/bottom-bar transcript without changing lifecycle execution policy yet.

### Current code paths

- Script process execution:
  - `src/utils/run-scripts.ts`
  - `runScripts(...)`
  - currently logs script start through `logger.dim`, but does not stream that line to `onOutput`.
- Workspace script orchestration:
  - `src/utils/run-workspace-scripts.ts`
  - `onPhaseStart` exists at lifecycle layer.
- Local backend output:
  - `src/session/backends/local-session-backend.ts`
  - emits zero-byte `script_output` on phase start.
- Remote backend/session handler output:
  - `src/lib/remote-session/session-handler.ts`
  - sends zero-byte `script_output` on phase start and appends raw output to operation buffer.
- Web task bar:
  - `src/app.web.tsx` maps `scriptState` phase to task phase.
  - `src/app/react/useWorkspaceRemovalTasks.ts` stores flat `logLines`.
  - `src/components/WorkspaceRemovalTaskBar.web.tsx` renders `ScriptTerminalPanel` with flat logs.

### Implementation plan

1. Route script output by workspace/task identity. `appendOutput` calls must use `workspaceId` or operation id, never broadcast to every running task.
2. Stream phase banners into the same output channel used by task logs:
   - On phase start, append a visible line such as `==> setup scripts...`.
   - Do this for local open/rerun/attach paths and remote operation paths.
3. Stream individual script start lines from `runScripts(...)`:
   - Before spawning each script, if `nonInteractive` and `onOutput` exists, send a line like `$ script-name workspace-name repository`.
   - Keep `logger.dim(...)` as is.
   - Do not include secret values.
4. Keep existing flat `logLines` model initially.
   - The minimal fix is explicit boundaries, not a new structured log schema.
5. Ensure remote operation `outputBase64` includes banners as well as raw stdout/stderr so durable operation tasks show the full transcript after reconnect.
6. Avoid double banners and duplicate live/snapshot logs:
   - If both lifecycle layer and backend layer emit phase banners, pick one source of truth.
   - Prefer the backend/session handler phase-start point because it already owns UI `script_output` events.
   - When a durable remote operation task exists, treat the operation snapshot/outputBase64 as the source of truth for that task.

### Tests

- `src/session/__tests__/local-session-backend.test.ts`:
  - phase-start events produce visible banner output before phase script output.
  - multiple phases preserve previous phase output in event/log sequence.
- `src/session/__tests__/remote-session-backend.test.ts` and/or `src/lib/remote-session/__tests__/session-handler.test.ts`:
  - remote script events include phase banners and script output order.
- `src/app/react/useWorkspaceRemovalTasks` tests if present, otherwise add focused test:
  - appending output preserves previous lines when phase changes.

### Phase definition of done

- Bottom bar shows visible phase boundaries for pre/setup/select/remove.
- If two scripts run, both script start lines and outputs are visible in order.
- Previous phase/script output remains visible after phase changes.
- Local and remote operation task transcripts match semantically.

### Phase review rubric

- Transcript completeness: no phase or script start is invisible.
- No sensitive data: banners never include env/secret values.
- No duplicate noise: phase banners appear once per actual phase start.
- Durability: remote operation-derived tasks show the same transcript after reconnect/snapshot.

---

## Phase 3: Remove passive detail/top-strip script trigger

### Scope

Stop the specific web behavior where Workspace Detail top-strip switching runs scripts.

### Current code paths

- Top strip selection:
  - `src/components/WorkspaceDetailPane.web.tsx`
  - `src/app/shared/workspace-detail/useWorkspaceDetailModel.ts`
  - `src/app.web.tsx` `handleSelectWorkspaceFromDetail(...)`
  - `handleBoardSelectWorkspace(...)`.
- Script trigger:
  - `src/app.web.tsx` effect using `visibleSelectionKey`
  - calls `runWorkspaceBundleScripts(currentDetailWorkspace, { mode: 'open' })`.

### Implementation plan

1. Remove or disable the `visibleSelectionKey` effect that runs open scripts purely because the visible detail workspace changed.
2. Preserve pure navigation behavior:
   - top-strip click changes selected/detail workspace.
   - no lifecycle task starts.
   - no backend `runWorkspaceOpenScripts` call happens from that click alone.
3. Keep any explicit user-triggered script actions intact:
   - Run setup/select from menu/button still calls explicit selection/rerun path.
4. If there is a true inactive -> active/open action elsewhere, identify it separately and do not conflate it with detail visibility.

### Tests

- UI-path regression test:
  - selecting workspace B from the Workspace Detail top strip or an extracted wrapper that exercises the same `detailActions.selectWorkspace(...)` -> `handleSelectWorkspaceFromDetail(...)` -> `handleBoardSelectWorkspace(...)` chain does not call `runWorkspaceOpenScripts` / `runWorkspaceBundleScripts`, does not start a task, and does not show a toast/modal.
- A helper-only test is acceptable only if the extracted wrapper covers that callback chain and side-effect assertions; testing a standalone boolean helper is insufficient.

### Phase definition of done

- Clicking between already-open workspaces in the detail top strip does not start setup/select or create a bottom-bar lifecycle task.
- Selecting a workspace for viewing remains functional.
- Explicit script run controls still work.

### Phase review rubric

- UX: passive navigation is side-effect free.
- Scope: no unrelated workspace selection/navigation behavior changes.
- Safety: removing this trigger does not remove explicit script command paths.
- Observability: tests would fail if top-strip selection starts scripts again.

---

## Phase 4: Idempotent setup/select lock gating

### Scope

Make lifecycle script decisions correct even if some caller invokes `runWorkspaceOpenScripts` automatically.

### Current code paths

- Lock state:
  - `src/utils/workspace-state.ts`
  - workspace root `gitspace.lock`.
- Current setup guard:
  - `src/utils/run-workspace-scripts.ts`
  - `shouldRunSetup(...)` skips only successful setup with matching state.
- Current select behavior:
  - `src/utils/run-workspace-scripts.ts`
  - select always runs on auto path.
  - `lockState.select.status` is recorded but not used for skipping.
- Explicit rerun:
  - `rerunWorkspaceScripts(...)`
  - should bypass automatic idempotence for requested phase(s).

### Implementation plan

1. Define a centralized lifecycle decision/result contract. Automatic open returns one of: `ran`, `skipped-current`, `blocked-previous-failure`, or `failed`, with `phasesRun`, `blockedPhase`, and prior error metadata where relevant. Local/remote backends propagate this result; passive UI creates a task only after actual `ran` output begins.
2. Define phase fingerprints and persist attempted fingerprints on success and failure.
   - Setup fingerprint should include:
     - current bundle hash/scope/bundle source where available,
     - centralized pre/setup script manifest fingerprints: phase name, directory absent/present/empty state, sorted executable relative paths, executable bit/eligibility, and file content hashes,
     - relevant bundle values/select values,
     - required secret key presence marker only; no raw secret values, no deterministic unsalted secret hashes, and no value-change invalidation in this iteration,
     - required confirm fingerprints/results.
   - Select fingerprint should include:
     - current bundle hash/scope/bundle source where available,
     - centralized select script manifest fingerprint: phase name, directory absent/present/empty state, sorted executable relative paths, executable bit/eligibility, and file content hashes,
     - relevant bundle values/select values/secret presence/confirm state passed to select; secret value changes alone do not invalidate select in this iteration,
     - current setup fingerprint/status when setup is required so changed setup invalidates select.
3. Extend lock-state decision helpers:
   - `shouldRunSetupAuto(...)`
   - `shouldRunSelectAuto(...)`
   - or equivalent names.
4. Automatic open/attach policy:
   - setup success + matching fingerprint => skip setup.
   - setup failure + matching fingerprint => do not auto-retry setup; return a failure/needs-action result without rerunning.
   - setup missing or fingerprint changed => run setup once.
   - select success + matching fingerprint => skip select.
   - select failure + matching fingerprint => do not auto-retry select; return failure/needs-action without rerunning.
   - select missing or fingerprint changed => run select once.
   - if setup is required and not valid for current fingerprint, do not run select.
5. Explicit rerun policy:
   - `rerunWorkspaceScripts(selection)` bypasses auto skip/failure suppression for selected phases.
   - After explicit rerun succeeds/fails, update the same lock state so future auto opens know the outcome.
6. Old lock compatibility:
   - Missing new fingerprint fields should be treated as unknown/stale, not crash.
   - Existing successful setup state should still skip when current old fields prove it is valid, if possible.
7. Make phase result explicit enough for UI:
   - no-op/current result should not emit fake running script task.
   - unchanged failed result should surface prior failure in a deliberate way if needed.

### Tests

Add/extend `src/utils/__tests__/run-workspace-scripts.test.ts` and workspace lifecycle tests:

- Auto setup success current => skip setup.
- Auto setup failure current => no rerun; returns `blocked-previous-failure` from lock state and creates no passive bottom-bar task.
- Auto setup failure stale/fingerprint changed => reruns setup.
- Auto select success current => skip select.
- Auto select failure current => no rerun; returns `blocked-previous-failure` and creates no passive bottom-bar task.
- Auto select failure stale/fingerprint changed => reruns select.
- Select failure does not invalidate/rerun setup.
- Setup content/manifest changed + prior select success invalidates select via setup fingerprint dependency.
- Script content edit, executable script add/remove, and executable-bit change invalidate exactly the affected phase.
- No setup scripts + select scripts, `noSetup: true`, setup failure with no select, and setup failure with select present are covered.
- Setup failure prevents select on automatic path.
- Explicit `selection: 'setup'` reruns setup despite current failure/success.
- Explicit `selection: 'select'` reruns select despite current failure/success.
- Explicit `selection: 'setup-select'` runs requested phases and updates lock.
- Old lock shape does not crash.

### Phase definition of done

- Automatic lifecycle does not repeat unchanged setup/select failures.
- Automatic lifecycle does not repeat unchanged setup/select successes.
- Setup/select invalidation is fingerprint-driven.
- Select failure never causes setup rerun.
- Setup invalid/missing/failure blocks automatic select when required.
- Explicit script commands still rerun requested phases.

### Phase review rubric

- Correctness: auto and explicit policies are distinct and test-covered.
- Persistence: decisions survive process restart because they use `gitspace.lock`.
- Minimality: no secret values are stored in lock fingerprints.
- Compatibility: old locks degrade safely.
- Separation: setup and select validity are independent except select may depend on setup validity.

---

## Phase 5: Remove unsafe open-mode rerun fallback

### Scope

Ensure passive open can never become explicit rerun on unsupported backend.

### Current code path

- `src/app.web.tsx`
- `runWorkspaceBundleScripts(...)`
- If `mode === 'open'` and backend lacks `runWorkspaceOpenScripts`, current behavior can fall back to `rerunWorkspaceScripts`.

### Implementation plan

1. Remove open-mode fallback to explicit rerun.
2. For passive `mode: 'open'`:
   - if backend supports `runWorkspaceOpenScripts`, call it only from an intentional lifecycle-open path, not top-strip/detail selection.
   - if unsupported, no-op silently with no task/toast/modal.
   - explicit user commands remain allowed to show unsupported errors.
3. Keep explicit run commands using `runWorkspaceScriptSelection` / `rerunWorkspaceScripts`.
4. Add guard/test that `mode: 'open'` never invokes explicit rerun method.

### Tests

- App/session hook test or extracted helper test:
  - backend with no `runWorkspaceOpenScripts` but with `rerunWorkspaceScripts`; `mode: 'open'` does not call rerun.
  - explicit setup/select still calls rerun/selection path.

### Phase definition of done

- Passive open cannot trigger setup-select rerun through fallback.
- Explicit script commands still work on backends that support rerun.
- Unsupported open lifecycle behavior is deterministic and non-destructive.

### Phase review rubric

- No hidden destructive fallback.
- Backend capability checks are explicit.
- User-visible errors only appear for explicit user actions, not passive navigation.

---

## Phase 6: Non-executable script visibility

### Scope

Make ignored script-looking files visible so missing executable bits do not masquerade as ordering bugs or swallowed failures.

### Current behavior

- `src/utils/run-scripts.ts` `discoverScripts(...)` only returns files with any executable bit set.
- Non-executable files in `.gitspace/scripts/<phase>/` are silently ignored.
- In core workspaces this caused `00-install-deps.sh` and `01-setup-pulumi-stack.sh` to be skipped while `02-setup-env.sh` ran, making it look like scripts were out of order.

### Implementation plan

1. Extend script discovery to detect ignored script-looking files separately from runnable scripts.
   - script-looking means regular files in the phase directory, especially files with shebangs or common script extensions such as `.sh`.
   - runnable scripts remain exactly files with executable bits, sorted lexicographically.
2. Surface non-executable script-looking files before running a phase.
   - For automatic lifecycle paths, treat these as a setup/select/pre error rather than silently skipping them.
   - Error should name each ignored file and say it is not executable.
   - Suggested fix in message: `chmod +x .gitspace/scripts/<phase>/<file>`.
3. Include non-executable state in the script-manifest fingerprint from Phase 4.
   - Executable-bit changes must invalidate phase decisions.
   - A previously blocked phase because of non-executable script becomes runnable after chmod.
4. Stream the diagnostic to bottom-bar transcript when the phase is attempted.

### Tests

- `discoverScripts` still returns executable scripts sorted lexicographically.
- Non-executable `00-foo.sh` in a phase causes a clear error before later executable scripts run.
- Changing `00-foo.sh` from 0644 to executable allows it to run before `01-*`.
- Non-executable ordinary non-script files that are intentionally docs/config do not produce false positives if outside the script-looking heuristic.
- Fingerprint invalidates when executable bit changes.

### Phase definition of done

- GitSpace no longer silently ignores script-looking files in `.gitspace/scripts/<phase>/` because of missing executable bit.
- Users see a clear error with exact file path and chmod guidance.
- Script ordering remains serial lexicographic among executable scripts.
- Executable-bit changes participate in lifecycle invalidation.

### Phase review rubric

- No silent skips of likely scripts.
- No broad false positives for non-script assets.
- Error points to the exact fix.
- Discovery semantics stay deterministic.

---

## Final work product definition of done

The full change is complete when all of these are true:

1. Bundle refresh/readiness
   - Required secrets saved through refresh/config are visible to immediate readiness checks.
   - The stale secret cache repro is covered by tests.

2. UI navigation
   - Workspace Detail top-strip A -> B switching does not run setup/select.
   - Viewing an already-open workspace does not create a bottom-bar script task.

3. Lifecycle idempotence
   - Automatic open/attach does not repeat unchanged setup/select successes.
   - Automatic open/attach does not repeat unchanged setup/select failures.
   - Changed bundle/script/config/secret/confirm fingerprints invalidate the appropriate phase.
   - Select failure does not invalidate setup.
   - Setup invalid/failure blocks automatic select when setup is required.

4. Explicit commands
   - Manual Run Workspace Scripts still reruns selected phases.
   - Explicit rerun updates lock state for future automatic decisions.

5. Output UX
   - Bottom bar transcript shows phase boundaries and individual script start lines.
   - Earlier script output remains visible after later scripts/phases run.
   - Local and remote transcripts are semantically equivalent.

6. Non-executable script visibility
   - Script-looking files in `.gitspace/scripts/<phase>/` are not silently skipped when missing executable bits.
   - Error messages name the files and the chmod fix.

7. Architecture
   - Frontend suppression is not the only guard; core/backend policy is authoritative.
   - Browser code does not import server-only script/process modules.
   - No secret values are written into lock files/logs/banners.

8. Verification
   - Targeted unit tests for bundle refresh, run-workspace-scripts, workspace lifecycle, local/remote script output, and app/open fallback pass.
   - `bun run typecheck` passes.
   - `bun run build:web` passes if web-facing files changed.

## Final review rubric

### Correctness

- Can any passive UI navigation still run scripts?
- Can stale secret cache still make a just-saved secret look missing?
- Are setup/select decisions based on persisted current fingerprints?
- Are auto and explicit paths clearly separated?

### Reliability

- Are failed unchanged scripts suppressed from automatic retry loops?
- Do changed inputs cause exactly one new automatic attempt?
- Do local and remote backends agree?
- Does behavior survive process restart?

### Security / privacy

- No secret values in lock state, task logs, banners, operation snapshots, or tests.
- Secret presence/fingerprint markers cannot leak values.

### UX

- User sees complete script transcript.
- No bottom-bar churn for no-op checks.
- Prior failures are surfaced intentionally, not by rerunning unexpectedly.
- Explicit retry remains available.

### Maintainability

- Lock-state helpers are named around policy, not UI behavior.
- Fingerprint construction is centralized/tested.
- The web layer is not the sole enforcement point.
- Unsupported backend behavior is explicit.
