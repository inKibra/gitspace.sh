# Inference Profiles

> **Status: Draft for review.** Product direction is agreed; implementation details below are proposed. This document does not authorize implementation or deployment.

## 1. Summary

Introduce **Navigate → Inference**, where users manage named inference profiles. Each profile owns its Models settings, Agents settings, and a logically separate credential broker scope. Each project selects exactly one profile; multiple projects may share a profile.

Move Models, Agents, and Providers out of Settings → OMP. Keep Advanced there as shared account configuration. Existing configuration and credentials become the **Default** profile, preserving existing OAuth connections.

```text
Shared OMP Advanced ─────────────────────────────┐
                                                │
Project → selected inference profile             ├→ OMP execution context
          ├── Models                            │
          ├── Agents                            │
          └── Profile-scoped credential broker ──┘
```

A profile is not an inheritance layer or a separate server. It is one ready-to-use inference configuration and its credentials. Use the existing OMP settings machinery and credential broker rather than building another configuration engine or proxying model traffic.

## 2. Problem, goals, and non-goals

Today, OMP inference configuration and broker credentials are account-wide. A client project needs its own provider credentials without changing what unrelated projects use on the same machine.

### Goals

- Configure inference once and reuse it across projects.
- Run projects using different credentials concurrently on one existing machine.
- Preserve multi-account OAuth within each profile.
- Support the same provider with different static API keys in different profiles.
- Keep Advanced shared rather than copying it into every profile.
- Make every GitSpace-managed inference path use the selected profile, including subagents and helpers.
- Fail closed when that profile cannot supply credentials. Never silently use another profile or ambient personal credentials.
- Migrate existing account configuration and stored credentials without requiring fresh OAuth sign-ins.

### Explicit non-goals

- OS, filesystem, shell, container, or network sandboxing. Processes running as the same Linux user retain that user's access.
- Separate tenants, WSL distributions, machine enrollments, or daemons per profile.
- A general policy engine, profile inheritance chains, or per-project settings patches.
- Cross-profile credential sharing, an account-wide credential-selection matrix, or multiple named static keys for one provider within one profile.
- An inference traffic relay, billing proxy, or new usage analytics system.
- A new agent-definition editor. Agents means the settings currently exposed in the Agents tab; workspace agent definitions remain their existing feature.

**Security claim:** profile-bound authorization and runtime configuration separate credentials used by managed inference. They do not prevent an unrestricted shell from reading same-user files or making its own network requests.

## 3. User experience and behavior

### Navigation and editing

Add Inference under Navigate. The page lists profiles and the projects assigned to each. Selecting a profile opens Models, Agents, Providers, and project assignments. Reuse the current editor controls and provider login flows; do not retain duplicate editors in Settings.

Project settings also expose an inference-profile selector. Both surfaces update the same project assignment. Display the selected profile in the workspace's inference/model controls so the credential context is visible before a user sends a turn.

| Action | Behavior |
| --- | --- |
| Initial migration | Create Default from existing account inference configuration and credentials; assign existing projects to it. |
| New project | Assign Default explicitly. |
| Create profile | Give it a name and an independent copy of Default's non-secret inference configuration; its broker starts empty. |
| Duplicate profile | Copy that profile's Models, Agents, and non-secret provider configuration. Do not copy credentials, OAuth tokens, or project assignments. |
| Connect provider | Add or update credentials only inside the selected profile. OAuth may contain multiple distinct accounts. |
| Edit profile | Show affected projects. Save a revision atomically; subsequent executions use it. |
| Reassign project | Existing admitted work keeps its profile; new work uses the new assignment. Do not switch an ongoing turn to different credentials. |
| Delete profile | Default cannot be deleted. An assigned profile cannot be deleted; reassign its projects first. Deletion revokes its broker access and warns about remaining active work. |

Profile IDs are stable; names are editable labels. Default has a reserved identity. A missing/deleted profile is an error, not an instruction to fall back to Default.

An empty broker is valid while configuring a profile, but inference requiring credentials is unavailable. Model choices and provider/account lists must be derived from the profile being viewed, not the account-wide credential inventory. Existing invalid model selections remain visible with an actionable error rather than being silently replaced.

### What a profile owns

- **Models:** model-role assignments and quick-cycle order.
- **Agents:** agent-to-role overrides and the runtime settings currently shown in Agents.
- **Providers:** non-secret provider configuration plus credentials in the profile's broker scope.
- **Advanced:** remains shared and is not stored in the profile.

Define this ownership once in the protocol layer and reuse it for UI grouping, serialization, migration, and runtime resolution. Current UI filters overlap: some Agents runtime settings also appear in Advanced. Resolve that overlap rather than copying its prefix filters into new APIs.

Profiles own complete user-managed inference configuration, not a patch against another profile. Unspecified fields may use OMP schema defaults; they must not inherit another profile's choices. Repository configuration and session model selection cannot widen credential access. Profile-owned fields take precedence over legacy account/repository inference settings; unrelated OMP discovery remains unchanged. Migration must report conflicting repository inference settings rather than silently claiming those settings were preserved.

## 4. Existing mechanisms to reuse

The current source provides these building blocks:

| Existing mechanism | Relevant source | Use in this design |
| --- | --- | --- |
| Models, Agents, Providers editors | `packages/account-web/src/SettingsPage.tsx`, `ProvidersSection.tsx` | Move/reuse controls under Inference. |
| Revisioned account settings and durable change events | `packages/account-worker/src/user-settings.ts` | Keep shared Advanced here; reuse its revision/event patterns for profiles. |
| Canonical project authority | `packages/account-worker/src/project-authority.ts` | Validate project identity/ownership before assigning an inference profile. |
| Encrypted credential storage, OAuth identity matching, refresh leases | `packages/account-worker/src/application.ts` | Keep storage/refresh implementation; partition its operations by profile. |
| Machine enrollment-bound broker bearer | `packages/account-worker/src/account-access.ts` | Reuse signing and enrollment checks for a new profile-bound bearer. |
| Provider login coordinator and local usage reporting | `packages/account-machine/src/provider-auth.ts` | Bind each login/usage operation to a profile, without introducing a remote usage service. |
| Canonical OMP settings synchronization | `packages/account-machine/src/canonical-settings.ts` | Continue synchronizing shared Advanced; stop treating it as the profile editor. |
| Child initialization and session creation | `packages/account-machine/src/omp-runtime.ts`, `packages/account-omp/src/ipc.ts`, `runtime.ts`, `session.ts` | Supply the profile before SDK/auth initialization. |
| Isolated OMP settings and explicit SDK injection | Pinned OMP dependency's `Settings.loadIsolated()` and `createAgentSession()` | Construct effective configuration without changing shared process state. |

A read-only probe against the installed OMP Settings implementation demonstrated isolated overrides, inheritance of untouched settings, and clearing overrides without affecting another instance. That supports reusing its settings machinery; it does **not** prove profile credential isolation or every helper's behavior.

### Important current credential behavior

`uploadCredential()` currently matches static API keys by provider, but matches OAuth credentials by account identity (or refresh token when identity is unavailable). A static-key upload replaces the active key for that provider. Distinct OAuth accounts coexist.

Retain those behaviors **inside each profile**. The same provider can then have one static key in Default and a different static key in Client A without adding account-wide named-key management. Existing OAuth upload behavior also disables static keys for that provider; any retained auth-mode transition must be confined to the selected profile, never applied account-wide.

## 5. Proposed architecture

### 5.1 Canonical records

Keep profiles, their assignments, and their credential scopes together in the existing account `CredentialVaultDO`. This makes assignment and profile deletion one local transaction instead of a distributed coordination problem. Shared Advanced remains in `UserSettingsDO`; project ownership remains in `ProjectAuthorityDO`.

| Record | Authority | Essential contents |
| --- | --- | --- |
| Inference profile | Existing account vault | Stable ID, name, revision, schema version, Models, Agents, non-secret Providers configuration, active/deleted state. |
| Project assignment | Existing account vault | Project ID, profile ID, assignment revision. |
| Profile credential scope | Existing account vault | Profile ID and credential-generation counter. |
| Credential | Existing vault table | Existing encrypted credential identity/revision plus owning profile ID. |

These are conceptual records, not new public API spellings. Define typed request/response schemas in `packages/protocol`; use the existing account RPC authorization and optimistic revision patterns. Configuration writes require the existing account configuration authority. Ordinary agent tools do not gain a profile-management capability.

Do not put secrets into profile JSON, Advanced YAML, project files, logs, browser storage, or ordinary revision events. Raw provider credentials remain in the encrypted vault. Existing credential IDs remain stable across migration.

Validate project ownership through the existing account/project APIs before accepting an assignment. Keep only one canonical assignment map: project views project this value rather than storing another independently writable copy.

Create a profile and its empty scope atomically. Assignment checks profile existence and expected revision in the same local transaction. Deletion checks for assignments, disables the scope, and records a tombstone atomically; assigned profiles cannot be deleted. Project deletion removes its assignment through an idempotent cleanup operation. An interrupted cleanup may temporarily block profile deletion, but cannot grant additional credential access.

This colocates related inference state without introducing another Durable Object or renaming the existing vault architecture. The one-time migration still crosses the account settings/project authorities and therefore uses the explicit retryable steps in Section 6.

### 5.2 One logical credential broker per profile

Keep one account Worker and the existing account vault. Add profile scoping to its credential records and broker operations. There is no extra process, port, machine, or provider-request proxy per profile.

A scoped runtime bearer binds at least account ID, profile ID, machine ID, enrollment generation, and its inference capability. Reuse the existing signing/enrollment mechanisms, but use a distinct token version/purpose so an ordinary machine bearer is not accidentally accepted as a profile bearer.

The trusted machine resolves a project's assignment through canonical authority before requesting its scoped broker access. OMP receives only that scope, not the broad machine credential-management bearer. A profile ID in a URL is routing information, not authorization; token and route scope must agree.

Every credential operation must enforce ownership:

- Snapshot and cache validation return only that profile's active credentials and profile credential generation.
- Refresh by credential ID verifies profile membership before decrypting or refreshing it.
- Upload, disable, logout, and account removal operate only inside the selected profile and require management authorization.
- Machine enrollment revocation invalidates its profile bearers through the existing generation checks.
- Deleting a profile disables its broker scope. Missing or unauthorized credentials fail closed.

Keep the existing broker wire format where practical. Do not add a streaming protocol merely for this feature; the current broker uses snapshot polling.

### 5.3 Provider login, refresh, and usage

Reuse `ProviderAuthCoordinator`, but bind its AuthStorage and login-flow state to a profile. Capture the profile when login starts; switching UI tabs must not redirect the callback into another profile. The browser-side API-key route also requires explicit profile identity and management authorization.

Preserve OAuth identity matching, refresh leases, credential revisions, and uncertainty handling. All searches, updates, and logout operations include the profile predicate. A refresh request must not be authorized merely because its numeric credential ID exists.

Profile duplication never clones OAuth refresh tokens. Connecting the same upstream OAuth account to two profiles is subject to that provider's grant/rotation behavior; this design does not promise independent provider-side grants. Test supported providers before claiming that scenario is safe. Projects that deliberately share credentials should share one profile.

Usage reporting remains local to the OMP/provider integration and is scoped to the profile being viewed. Cache keys must include profile identity so accounts or usage results cannot bleed between profiles. This is scope correction, not a new reporting feature.

### 5.4 Construct one execution context

Before creating, reopening, or admitting work to an OMP session, the machine resolves:

```text
project ID
  → assignment revision + profile ID
  → profile revision + shared Advanced generation
  → profile-scoped broker connection
  → isolated settings + auth storage + model registry
```

Pass this typed context through the private OMP initialization IPC. Bump the IPC compatibility version when the initialization contract changes. Construct settings and auth before SDK model restoration, helper setup, or default-model resolution.

Use existing OMP isolated settings/SDK injection. Do not rewrite the account config file per project, mutate `process.env` when switching projects, or clone whole agent directories. Shared skills and other non-inference assets keep their existing ownership. Any credential or model-registry cache with persistent state must be keyed by profile.

A managed AuthStorage must use only its profile broker. Disable alternate credential sources in this mode: ambient provider variables, AWS profile/metadata fallback, unrelated local auth databases, raw config keys, and fallback resolvers. Supply a child-specific environment without broad broker credentials. Do not rely solely on environment scrubbing: provider code can have other credential sources, and code can pass an explicit key.

Reuse the normal inference dispatch boundary to verify the requested provider/credential belongs to the execution context. If the pinned OMP dependency lacks a sufficient hook, add the smallest maintained patch needed. Do not implement a second transport stack or scatter project-conditionals through every caller. Unsupported auth modes must be visible and blocked, not silently exempted.

Main turns, tasks/subagents, advisors, vision, compaction, title/commit generation, retry candidates, and managed eval completions must receive that same context. Provider settings and custom endpoints belong to the selected profile; restoring a model or choosing a fallback never authorizes a different credential source.

### 5.5 Changes, recovery, and admission boundaries

A user turn and its descendant work are admitted against one immutable profile/configuration binding. A standalone helper or scheduled job is a separate admission and resolves the project's current assignment. Autonomous continuations belong to the original admitted work until it settles; they cannot survive unnoticed as an old-profile background session after reassignment.

Profile edits, Advanced edits, and project reassignment take effect at the next admission, not halfway through admitted work. Queue entries do not pin a profile before they start. At the boundary, compare authoritative revisions, drain/dispose stale children, and reopen the existing session transcript with the new context. Prefer this to live mutation of registries. A restored model incompatible with the new profile is blocked with a clear error.

Use existing change subscriptions to invalidate local views. Recheck canonical assignment/profile readiness before new admission; if it cannot be established, do not start new inference from a stale binding. An already admitted turn can continue within its current scope. Resuming after a process/machine interruption is a new admission, so it resolves the current assignment rather than blindly trusting saved auth state.

Credential removal, provider-side revocation, and profile deletion can cause active work to fail. They never trigger cross-profile fallback. Neither deletion nor logout can unsend an existing provider request or instantly revoke an API key already issued by the provider. The UI must not imply that guarantee.

## 6. Migration, compatibility, and rollout

### Migration contract

1. Create a reserved Default profile by extracting the inference-owned fields from the canonical account OMP document. Preserve unrelated Advanced content and custom role/agent entries.
2. Assign existing credential rows to Default **in place**, retaining encrypted values, IDs, revisions, refresh state, and OAuth accounts. Do not reconnect or re-upload them through the static-key upsert path.
3. Assign existing projects to Default. New projects explicitly receive that assignment.
4. Move any existing raw credential-bearing configuration into Default's vault through an explicit migration path; remove the raw secret from shared configuration only after the destination is durably confirmed. If it cannot be represented safely, stop activation with a remedy rather than dropping it.
5. Detect dependencies on ambient credentials and conflicting repository inference settings. Stored broker credentials migrate automatically; ambient credentials do not. Require connection to Default or resolution of the conflict before affected work resumes under the new rules.
6. After compatible runtimes are active and migration checks pass, expose Inference and remove the old Models/Agents/Providers editors and obsolete account-wide inference write paths.

Use a durable migration version and retryable steps. Expected-generation checks or a brief configuration-write fence prevent concurrent settings/login changes from being lost. Migration is complete only when both configuration and credential scope agree. Default preserves existing stored configuration; it is not a claim that unsafe ambient fallback remains supported.

### Mixed releases and rollback

Deploy the affected Worker, frontend, machine, and OMP targets through the existing coordinated tenant release mechanism. Advertise/check profile support before admission. Do not make non-Default credentials accessible to legacy account-wide broker requests: any temporary legacy route is strictly confined to Default and cannot serve a project assigned elsewhere.

An incompatible machine must refuse profile-managed work and report that an upgrade is needed. It must never interpret an unknown profile as Default. Once the account is cut over, prevent rollback to binaries that lack this check; pause affected inference instead of broadening access.

As implemented, profile support is `inferenceVersion: 1` on executable manifests, the OMP runtime recipe, and staged release records. The launcher stamps a release only when every selected target's own source declares `"gitspace": { "inferenceVersion": 1 }` in its `package.json` (`account-worker`, `account-web`, `account-machine`, `account-omp`), so a new builder cannot certify old workspace source. Admission trusts a machine's acknowledged machine+OMP releases, not its desired selection; after cutover, incompatible machines are refused at `/v1/control` admissions, account RPC proxying, `/v1/relay/authorize`, and every tunnel lease renewal, which drops tunnels opened before cutover within one lease. Account-wide broker bearers are no longer minted; CLI enrollments migrate from config v3 to v4 without the stored bearer, and the host process never inherits `OMP_AUTH_BROKER_*`.

The first cutover deploy is necessarily staged by a pre-profile launcher and Worker, which drop the stamp. The Worker therefore certifies, and persists `inferenceVersion: 1` on, the release whose sha equals its own build stamp: that sha fingerprints the complete source tree (HEAD plus a digest of uncommitted changes), so every artifact staged under it came from source containing these checks.

Retain pre-migration configuration as protected migration recovery data until cutover is verified; never make a secret-bearing backup an ordinary artifact. Do not roll back by merging profile credentials into one account-wide pool. Forward repair or a profile-compatible prior release is the recovery path after users create distinct credential scopes.

This document authorizes no deployment. Implementation and a live rollout require their normal approval boundaries.

## 7. Implementation sequence and affected areas

| Step | Deliverable | Primary areas |
| --- | --- | --- |
| 1. Contracts and canonical state | Typed profile/assignment records, shared field ownership, transactional assignment/deletion, idempotent Default migration. | `packages/protocol`, existing Worker vault, account RPC routing and project ownership validation. |
| 2. Scoped credential broker | Profile-owned credential rows, scoped runtime bearer, scoped login/refresh/logout/usage, negative cross-scope authorization checks. | Worker `application.ts`, `account-access.ts`, `account-cloud-rpc.ts`; machine `provider-auth.ts`. |
| 3. Runtime vertical slice | Two projects on one machine use different profiles; every managed inference path receives its context; no fallback. | Machine canonical settings/session coordinator/OMP launcher; OMP IPC/runtime/session; maintained dependency patches only where needed. |
| 4. Product UI | Inference navigation, reused editors, assignment controls, effective-profile display; remove old inference editors. | Web sidebar/routes/LiveApp, SettingsPage, ProvidersSection, project settings and composer. |
| 5. Migration and release proof | Preserved Default, reconnect/reassignment behavior, old-client rejection, UI smoke verification and coordinated rollout evidence. | Existing package tests and release compatibility checks. |

Prove the runtime/credential boundary before polishing UI. This is one end-to-end feature; the steps are implementation order, not permission to ship a configuration-only shell or a dropdown without enforcement.

## 8. Verification and acceptance criteria

| Scenario | Observable result |
| --- | --- |
| Different profiles, same provider, same machine | Concurrent project requests use their respective credentials; neither profile replaces or sees the other's key. |
| Shared profile | Two projects intentionally use the same configuration and credential scope. |
| OAuth accounts | Distinct accounts coexist within one profile; re-authentication updates the correct identity. Refresh/logout in one profile does not change another. |
| Cross-profile credential ID or route | Snapshot, refresh, upload, and disable requests cannot escape the caller's scope; no credential bytes are returned. |
| Missing credentials with personal environment populated | Main and helper inference fail closed; no provider request uses the personal key or ambient AWS identity. |
| Subagent/helper/retry coverage | Task, advisor, vision, compaction, title/commit, eval completion, and retry paths either use the selected profile or fail before unauthorized inference. |
| Profile duplication | Non-secret configuration is copied independently; credentials and project assignments are absent from the copy. |
| Reassignment while running | Admitted work retains its binding; the next queued/new operation uses the new profile. No hidden old-profile continuation remains available for new work. |
| Resume and workspace movement | The destination machine resolves the current project assignment before restoring inference; saved model selection cannot bypass it. |
| Shared Advanced update | All profiles receive the change at their next admission; their Models/Agents/Providers remain independent. |
| CAS and lifecycle races | Concurrent edits do not overwrite each other; assignment/delete races cannot admit work to a deleted profile. |
| Broker or canonical authority unavailable | No new work starts with an unverified binding; no local/account credential fallback is used. |
| Migration retry | Re-running migration neither duplicates accounts nor replaces credentials; existing OAuth sessions and custom settings remain intact. |
| Incompatible/rolled-back runtime | Admission is blocked clearly; credentials are never flattened into an account-wide pool. |
| Browser smoke | Inference is under Navigate; old inference tabs are absent from Settings; profile editing, assignment, login, and errors are exercised on the actual UI. |

Keep regression tests for security boundaries, refresh identity handling, migration idempotency, and lifecycle transitions. Use existing fixtures and a throwaway runtime probe for straightforward settings composition. Assertions should cover credential actually used, rejected access, and observable behavior—not source text or mocked forwarding. Provider requests used for live verification require explicit authorization; this design-doc task performs none.

## 9. Alternatives and decisions

| Alternative | Decision |
| --- | --- |
| Three independently enabled project override sections | Rejected: unnecessary inheritance and merge semantics for this need. |
| Account-wide vault plus per-profile credential-selection matrix | Rejected: introduces named static keys and sharing rules where profile ownership suffices. |
| Permanently clone full OMP profiles/directories | Rejected: duplicates Advanced, risks copying OAuth tokens, and creates configuration drift. |
| Separate GitSpace tenants/processes or WSL installations | Valid operational alternatives, but unnecessary for the agreed managed-inference boundary and less convenient for shared settings. |
| New broker service or inference proxy per profile | Rejected: logical scopes in the existing service provide the required separation. |
| Hot-swap credentials/settings inside a running turn | Rejected: use explicit admission boundaries and existing session reopen paths. |

## 10. Review questions and implementation risks

The product choices above are settled. These are targeted engineering checks, not invitations to expand scope:

1. **OMP enforcement hook:** identify the smallest common auth/dispatch hook that covers explicit keys, helper calls, and Bedrock's ambient AWS paths. The settings probe does not establish this coverage. Unsupported paths must fail closed before release.
2. **Credential provenance during migration:** inventory broker credentials versus raw config and ambient auth dependencies without logging secret values. Decide any provider-specific conversion only from that evidence.
3. **OAuth grant reuse:** verify supported providers' behavior when the same external account is independently connected in two profiles; never solve it by silently cloning refresh tokens.
4. **Drain/reopen correctness:** exercise descendants, queued turns, and autonomous helpers when a binding changes. No transcript loss and no stale execution context after the boundary.
5. **Mixed-version admission:** prove that both host/OMP compatibility and broker authorization prevent an older runtime from seeing non-Default credentials.

**Ready to implement when:** the record/API contract, scoped authorization, field-ownership map, migration gates, and admission behavior are reviewed. The implementation must then prove the acceptance scenarios above before the isolation claim is presented as available functionality.
