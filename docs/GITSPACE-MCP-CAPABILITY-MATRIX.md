# GitSpace MCP capability matrix

Status: implementation in this checkout. No live deployment is authorized by this document. The matrix records operation coverage and the checks required before release.

## Goal and coverage

An authenticated MCP client can inspect and control GitSpace through the same in-scope operations as an authorized browser user, within the dedicated backing API client's grant. Bootstrap, enrollment, account recovery, OAuth flows, and protected authentication terminal streams are excluded. Workspace lifecycle recovery remains in scope.

The original inventory contained **195 procedures: 56 queries, 18 subscriptions, and 121 mutations**. The current contract contains **205 procedures: 59 queries, 19 subscriptions, and 127 mutations**, including the browser-only protected terminal subscription. JSON descriptions preserve the existing codec implementations and validation semantics. The separate authority change versions five Inspector codecs to record authenticated client actors; it changes six existing procedure signatures: `inspector.view`, `inspector.overview`, `inspector.workflow.put`, `inspector.workflow.waiveGate`, `inspector.rubric.put`, and `inspector.rubric.appendJudgment`. These changes and the added procedures change the contract fingerprint and require compatible frontend, Worker, and machine builds. Offline availability remains operation-specific.

Existing foundations:

- [Canonical RPC contract](../packages/protocol/src/rpc-contract.ts#L2024): schemas, result types, procedure kinds, and routes.
- [Typed client](../packages/protocol/src/client.ts): signed requests and placement-aware routing. Its package is currently private; this is not yet a published external SDK.
- [Workspace code-mode adapter](../packages/account-machine/src/space-eval-sdk.ts): an existing scoped agent surface, not the whole account API.
- [Frontend actions](../packages/account-web/src/LiveApp.tsx) and [settings](../packages/account-web/src/SettingsPage.tsx): current browser behavior.

## Reading the matrix

R = `readOnlyHint`; D = `destructiveHint`; I = `idempotentHint`; O = `openWorldHint`. T/F are explicit booleans. A dash means D/I is inapplicable to a read-only tool and is omitted. The values mirror the reviewed [annotation table](../packages/mcp-server/src/annotations.ts), audited against each handler's behavior rather than its RPC kind. They are hints, not a substitute for backend authorization.

- **Tool:** named MCP operation backed by the existing signed SDK.
- **Bounded:** finite page, bounded wait, or resource adapter; never an endless ordinary tool result.
- **Split:** existing query has caller-visible effects. MCP requires write authority and advertises those effects rather than claiming read-only behavior.
- **Excluded:** identity bootstrap/enrollment/account recovery, OAuth, or browser-only protected authentication streams.
- **Provenance:** approval authority and actor identity must come from the authenticated grant, not tool arguments.
- **Internal:** transport/context operations retained where needed for frontend parity.

MCP annotations are hints, not an authorization system; see the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations). The annotation table applies these policies:

- **Read-only** means no caller-visible change. Internal housekeeping such as cache refresh, lease renewal, reconciliation toward recorded desired state, or one-time initialization and migration does not count, so `machines`, `project.list`, `inference.list`, `inference.events`, and `providers.list` are R=T. A mutation RPC can also be R=T (`browserRelay.test`, `inspector.guide.analyze`); it keeps its `rpc.write` requirement.
- **Destructive** means the call can overwrite, delete, or interrupt existing state. Anything that runs an agent turn or arbitrary code is D=T and O=T because of its possible downstream effects. Reversible selections and toggles (model, thinking level, workspace phase, active profile) and purely additive records are D=F.
- **Open-world** means the call can reach third parties: Git remotes, model and OAuth providers, external MCP servers, or Composio. GitSpace's own Worker, machines, and Cloudflare infrastructure are not open-world.
- **Idempotent** means repeating the same request is expected to leave the same end state as one call, for example deleting a record, stopping a process, or accepting an environment run with the same space/run identity. I=F means **no safe-retry promise is advertised**, not that every repeated call necessarily changes state. Do not infer I=T from a PUT-like name, an expected revision, an operation ID field, a busy check, or nonce replay protection. An optimistic-concurrency failure after a successful write is not an instruction to fetch a new revision and repeat the mutation.

## Permissions and scope

The permission column reports the **current base backend capability**, not a proposed new permission. [`requiredCapability`](../packages/protocol/src/device-grant.ts#L329) supplies it. All requests also require valid authenticated identity, tenant ownership, and scope checks. Tool discovery must hide unauthorized tools, and calls must independently enforce permission even when a caller knows the name.

| Current capability | Meaning and additional checks |
|---|---|
| `rpc.read` | Current query/subscription permission. It does not establish semantic read-only behavior; the Split row is a counterexample. |
| `rpc.write` | Broad ordinary mutation permission. It currently includes sensitive settings, secrets, integration grants, terminal operations, and approval-related inputs. Do not describe it as a narrow workspace-edit permission. |
| `session.prompt` | Required for prompting and answering agent questions. A prompt may cause arbitrary tool execution. |
| `fleet.control` | Machine mutations other than image operations. Explicit image selection on sandbox creation additionally requires `deployment.control`. |
| `deployment.control` | GitSpace release changes and machine image mutations. It does not grant platform administration. |
| `devices.manage` | Device revocation and device-management policy. Delegating a new credential also requires a valid delegation chain. |
| `account.admin` | Explicit API-client authority for account administration previously restricted to browser identity. Requires account scope and `rpc.write`. |
| `lifecycle.control` | Explicit API/MCP-client authority for lifecycle approval, including browser origins, revocation, cancellation, recovery, and cloud destruction. Requires account scope and `rpc.write`. Project origin approval applies only where the workspace's committed bundle lists that origin. |

Scope rules and gaps:

- Account-cloud authorization currently requires an account/user-scoped device. Do not promise that a project-scoped key can call every cloud-backed project/Inspector operation. See [account device authorization](../packages/account-worker/src/application.ts) and [cloud routing](../packages/account-worker/src/account-cloud-rpc.ts#L497).
- Machine-side authorization resolves top-level, nested Inspector, and session-only targets to their canonical project/workspace before comparing the grant. Unknown or foreign targets fail closed. A workspace grant cannot write project/global configuration. See [signed RPC](../packages/account-machine/src/signed-rpc.ts).
- The MCP adapter never replaces a narrow backing grant with an account-wide credential. Cloud-backed operations that require account scope remain unavailable to narrow grants.
- Actor labels, reviewer IDs, `actorKind: human`, resource IDs, and workspace paths are input data, not proof of authority. Bind provenance to authenticated identity.
- MCP uses a separate bearer access key on the front and a dedicated existing GitSpace API-client signing key on the back. The signing key stays in protected server storage.
- A read-only backing key cannot invoke queries annotated as non-read-only (currently `mcp.discover`); MCP requires additional write authority for them. `machines` additionally requires fleet control in MCP because listing reconciles the fleet. Read-only mutation RPCs keep their `rpc.write` requirement. Safety annotations do not grant permission.

## Authentication and connection

```text
Standard MCP client + MCP bearer key
  -> tenant /mcp endpoint verifies access and current backing grant
  -> MCP server invokes the existing GitSpace SDK
  -> SDK signs RPC requests with a dedicated API-client key
  -> existing account/machine handlers enforce permissions and execute
```

The endpoint uses the official TypeScript MCP SDK and Streamable HTTP. Clients do not install a GitSpace-specific operation SDK.

### Enable MCP

In **Settings > Connections**, choose **Enable MCP** and select the backing client's scope, permissions, and lifetime. An account-scoped browser with device-management and delegation authority must approve setup.

The browser signs a dedicated API-client invitation. The account vault generates the signing key, enrolls the client, and stores the key encrypted. It also generates a random 32-byte bearer token and stores only its SHA-256 hash. Setup does not expose the signing key to the browser or MCP client.

Copy the bearer token when setup completes. It appears once, alongside a copyable client configuration:

```text
Transport: Streamable HTTP
URL: https://<account>.gitspace.sh/mcp
Authorization: Bearer <generated-token>
```

The bearer token is the MCP access key. There is no token exchange, OAuth login, or GitSpace-specific SDK to install in the MCP client. Keep the token out of repository files, logs, and shared conversations.

All callers using this token share the dedicated API client's authority and audit identity. This is not a multi-user privilege broker. Full in-scope account control requires `rpc.read`, `rpc.write`, `session.prompt`, `fleet.control`, `devices.manage`, `deployment.control`, `account.admin`, and `lifecycle.control`. Administrative permissions remain opt-in. A narrow grant does not gain account authority.

**Rotate token** generates a replacement and immediately invalidates the old token for new requests. Copy the replacement once. Rotation keeps the signing client and its permissions. If you lose a token, rotate it; the server cannot retrieve its original value.

**Disable MCP** invalidates access, revokes the dedicated signing client, and removes the stored signing key and bearer hash. Revoking the client or any issuer in its grant chain also prevents MCP access. The endpoint checks the current backing grant on every request, including discovery. Requests already executing are subject to their existing cancellation and authorization behavior.

Status reads reveal metadata only. Setup, rotation, and disable use signed browser-only endpoints outside the MCP tool catalog. Revision checks reject stale changes instead of silently replacing another browser's token. After an ambiguous setup or rotation failure, refresh status and rotate deliberately rather than retrying automatically.

### Deployment

MCP ships inside the tenant Worker through the normal GitSpace source launch. Compatible Worker, frontend, and machine builds are required for the shared contract changes. The browser's **Launch GitSpace from here** action launches all four targets.

Deployment never enables MCP or grants permissions. The first enable is an explicit browser action after activation. Configuration lives in the account credential vault and survives Worker restarts and source releases. No MCP environment variables, manually installed Worker secrets, separate service, or platform release are required.

The signing key intentionally lives on the MCP server. A server compromise exposes that key's authority, so use a dedicated revocable grant with the shortest practical lifetime and scope. No root key, browser private key, or new Worker impersonation authority is needed.

Do not retry a mutation automatically after an ambiguous timeout. Query its state or durable run ID first.

## Capability matrix

Each dotted path below is an RPC identifier. MCP tool names use prefix `gitspace_`, replace dots with underscores, and convert camelCase to snake_case: `workspace.setPhase` becomes `gitspace_workspace_set_phase`. The full-capability catalog contains 193 tools: the 205 contract procedures minus five excluded OAuth procedures, the browser-only protected terminal stream, and six finite streams (`transcript`, `subagents.transcript`, `inspector.transcript`, `inspector.repository.tree`, `inspector.artifacts.read`, `inspector.resources.read`) that MCP serves only through their page tools. Discovery filters tools by the backing grant, and execution checks authority again. There is no generic method dispatcher or unrestricted eval tool.

Every exposed operation has a reviewed entry in the [annotation table](../packages/mcp-server/src/annotations.ts) and an explicit description in the [tool guidance catalog](../packages/mcp-server/src/descriptions.ts); the server throws rather than registering a tool without either, so there is no fallback annotation. Descriptions explain purpose, returned data, distinctions from related tools, and relevant effects or follow-up reads. Resource templates describe how to encode input and continue content reads. Shared server instructions explain result envelopes, permission filtering, and completion semantics; they do not replace operation-specific guidance.

### Sessions and transcript

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `space.view`<br>`transcriptPage`<br>`transcriptContent`<br>`subagents.page`<br>`subagents.content`<br>`placements`<br>`session.history`<br>`session.locate`<br>`session.control`<br>`session.usage`<br>`session.agents` | `rpc.read` | T | - | - | F | Tool | Bounded inspection; preserve resource ownership and generation checks. Never implicitly open a space or start its runtime. `session.control` reports `renderState` and `activity`; `activity.active` is false once the turn has finished. |
| `subagents.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |
| `session.create`<br>`session.createProject` | `rpc.write` | F | F | T | F | Tool | Starts or recovers the main agent runtime, reusing a live session when one exists. Returns lifecycle and activity state; no work runs until a prompt is sent. |
| `session.prompt`<br>`session.answerAsk` | `session.prompt` | F | T | F | T | Tool | May execute or release arbitrary code/model work, including destructive tools. Never auto-retry prompts, terminal input, or queue promotion. |
| `session.compact` | `rpc.write` | F | T | F | T | Tool | Runs a model inference over the agent context and replaces it with a summary. Never auto-retry. |
| `session.promoteQueuedMessage`<br>`session.setGoal` | `rpc.write` | F | T | T | T | Tool | Moves queued input to steering priority, or enables, replaces, or disables runtime Goal mode; either can release agent work, including destructive tools. Queue promotion is index-based; read current controls first. |
| `session.saveAgent`<br>`session.clearQueue`<br>`session.removeQueuedMessage`<br>`session.stop` | `rpc.write` | F | T | T | F | Tool | Overwrites agent definitions, discards queued input, or interrupts the active turn. Preserve current revision/identity; queue removal is index-based. Stopping does not undo work already performed. |
| `session.setApproval` | `rpc.write` + `account.admin` for clients | F | T | T | F | Provenance | Changes future agent permission policy. API clients require account scope and explicit administration authority. |
| `session.setThinking`<br>`session.setFast`<br>`session.setModel`<br>`session.navigateTree` | `rpc.write` | F | F | T | F | Tool | Reversible selections of session controls or the active conversation-tree branch. Refresh transcript pages after navigating. |
| `session.cycleRole` | `rpc.write` | F | F | F | F | Tool | Steps through the configured role cycle; each call moves again, so it is not idempotent. Read current controls before cycling. |

### machine

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `machines` | `rpc.read` + `fleet.control` in MCP | T | - | - | F | Tool | Listing reconciles managed machines toward their recorded desired state; that housekeeping changes no caller-visible desired state, so the tool is advertised read-only. MCP still requires fleet control. Follow `machine.events` instead of polling. |
| `machine.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |
| `machine.updateNotes` | `fleet.control` | F | T | T | F | Tool | Replaces a machine's notes; power state and image are unchanged. |
| `machine.sleep`<br>`machine.destroy` | `fleet.control` | F | T | T | F | Tool | Checkpoints and stops, or removes, a managed machine. Destroy requires no open spaces and no active image operation; an already absent machine reports removal. |
| `machine.createSandbox`<br>`machine.resume` | `fleet.control` | F | F | F | F | Tool | Provisions a new sandbox or brings a machine online. Returns while provisioning continues; accepted is not ready. Sandbox creation with image selection also requires deployment.control. |
| `machine.image.list`<br>`machine.image.defaults.get` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `machine.image.events` | `rpc.read` | T | - | - | F | Bounded | Observe an existing operation; do not start or advance it. Bound the wait and recheck access. |
| `machine.image.set`<br>`machine.image.cancel` | `deployment.control` | F | T | T | T | Tool | Replaces a machine image or cancels its image operation; preserve operation IDs and lifecycle gates. Accepted is not activated. |
| `machine.image.recover` | `deployment.control` | F | T | T | T | Tool | Recovery may discard an uncheckpointed candidate. The recorded approving identity is the authenticated device; it is not proof of a human browser. |
| `machine.image.retry` | `deployment.control` | F | F | F | T | Tool | Resumes a stalled image operation under its existing machine and operation IDs; a finished operation stays finished. Follow image events. |
| `machine.image.defaults.set` | `deployment.control` | F | F | F | F | Tool | Replaces the account default for future provisioning, not existing machine images. |

### settings

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `settings.get`<br>`settings.git.get`<br>`settings.omp.get` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `settings.update`<br>`settings.reserveHandle` | `rpc.write` | F | T | T | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |
| `settings.omp.set` | `rpc.write` | F | T | F | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |
| `settings.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |

### inference

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `inference.list` | `rpc.read` | T | - | - | F | Tool | Returns profiles and assignments without credential values. The read can initialize or migrate canonical inference state; that one-time housekeeping is not a caller-visible change. |
| `inference.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. Starting the stream can initialize or migrate inference state as housekeeping. |
| `inference.update`<br>`inference.delete` | `rpc.write` + `account.admin` for clients | F | T | T | F | Tool | Replaces or deletes a profile. Account-scoped API clients need explicit administration authority. Existing browser administration remains supported. |
| `inference.assign` | `rpc.write` + `account.admin` for clients | F | F | T | F | Tool | Reversible selection of a project's profile. Account-scoped API clients need explicit administration authority. |
| `inference.create` | `rpc.write` + `account.admin` for clients | F | F | F | F | Tool | Creates a profile copied from another; credentials are not copied. Account-scoped API clients need explicit administration authority. |

### providers

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `providers.list` | `rpc.read` | T | - | - | F | Tool | Provider snapshots can initialize or refresh managed provider context as housekeeping; no secret values are returned. |
| `providers.login.start`<br>`providers.login.respond`<br>`providers.login.cancel` | `rpc.write` | F | T | F | T | Excluded | Interactive provider authorization is outside this effort. Existing browser behavior is unchanged. |
| `providers.login.events` | `rpc.read` | T | - | - | F | Excluded | Part of the excluded provider authorization workflow. |
| `providers.logout` | `rpc.write` + `account.admin` for clients | F | T | F | F | Tool | Explicit account administration authority; a repeated call removes an already disabled credential; credential values must not enter responses or logs. |
| `providers.apiKey.set` | `rpc.write` + `account.admin` for clients | F | T | F | F | Tool | Explicit account administration authority; credential values must not enter responses or logs. |
| `providers.usage` | `rpc.read` | T | - | - | T | Tool | Reads may contact external provider/catalog APIs; retain filtering, byte limits and safe output handling. |
| `providers.models` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |

### devices

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `devices.list` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `devices.revoke` | `devices.manage` | F | T | T | F | Tool | Revokes access, potentially including delegated descendants. Require devices.manage and explicit target. |

### deployment

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `deployment.status` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `deployment.launch`<br>`deployment.revert` | `deployment.control` | F | T | F | F | Tool | Builds or reverts running GitSpace release targets; preserve launch IDs and the target set. Accepted is not activated. |

### secrets

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `secrets.list`<br>`secrets.account.list` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `secrets.put`<br>`secrets.account.put` | `rpc.write` | F | T | F | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |
| `secrets.delete`<br>`secrets.account.delete`<br>`secrets.account.revoke` | `rpc.write` | F | T | T | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |
| `secrets.account.grant` | `rpc.write` | F | F | T | F | Tool | Lets a project use an existing account secret without disclosing its value. Non-destructive does not mean safe to auto-approve: it widens secret access. |

### configuration

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `configuration.values.get` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `configuration.values.put`<br>`configuration.values.delete` | `rpc.write` | F | T | T | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |

### environment

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `environment.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |
| `environment.get`<br>`environment.runLog` | `rpc.read` | T | - | - | F | Tool | Bounded inspection; preserve resource ownership and generation checks. Never implicitly open a space or start its runtime. |
| `environment.putBundle`<br>`environment.putValue`<br>`environment.deleteValue` | `rpc.write` | F | T | T | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |
| `environment.setProfile` | `rpc.write` | F | F | T | F | Tool | Reversible selection of the workspace environment profile; changes configuration without starting checks or provisioning resources. |
| `environment.approve`<br>`environment.revokeApproval` | `rpc.write` + `lifecycle.control` for clients | F | F | T | F | Tool | Records or withdraws approval for exact execution content or browser-origin hashes without running or cancelling anything. API/MCP keys with `lifecycle.control` may approve browser origins. Project origin approval applies only where the workspace's committed bundle lists that origin. Content-hash preconditions remain required. |
| `environment.recoverRun` | `rpc.write` + `lifecycle.control` for clients | F | T | T | F | Tool | Releases a stranded lifecycle claim after its runner machine was destroyed, abandoning the old run. Account recovery is excluded; workspace run recovery is not. |
| `environment.runChecks`<br>`environment.runPhase` | `rpc.write` | F | T | T | T | Tool | Same spaceId/runId is deduplicated by durable acceptance; preserve identical inputs and reconcile results. `cloud/destroy` additionally requires lifecycle authority. |
| `environment.cancelRun` | `rpc.write` + `lifecycle.control` for clients | F | T | T | T | Tool | Records cancellation, not proof of process exit. Poll the durable run to terminal state. |

### mcp

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `mcp.connections.list`<br>`mcp.connections.status`<br>`mcp.composio.setup.get`<br>`mcp.grants.list` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `mcp.connections.create` | `rpc.write` | F | F | F | T | Tool | Registers a new integration connection without granting it to projects or proving a handshake. Granted connections can launch or contact external servers. |
| `mcp.connections.update`<br>`mcp.connections.delete` | `rpc.write` | F | T | T | T | Tool | Changes executable integration configuration; machine path can reload live sessions. Account persistence alone does not bound transitive runtime effects. |
| `mcp.grants.put`<br>`mcp.grants.delete` | `rpc.write` | F | T | T | F | Tool | Creates, replaces, or removes a project's access grant to an existing connection; machine path can reload live sessions. |
| `mcp.composio.setup.put`<br>`mcp.composio.updateTools`<br>`mcp.composio.disconnect` | `rpc.write` | F | T | T | T | Tool | Changes integration credentials, Composio tool policies (group settings plus per-tool exceptions), or connection state; external calls and live-session refresh may occur. |
| `mcp.composio.setup.delete` | `rpc.write` | F | T | T | F | Tool | Removes the account Composio API key; a platform fallback can keep setup configured. Does not disconnect external accounts. |
| `mcp.composio.refresh` | `rpc.write` | F | T | F | T | Tool | Refreshes authorization status from the external connected account and persists it. |
| `mcp.composio.catalog`<br>`mcp.composio.tools` | `rpc.read` | T | - | - | T | Tool | Reads may contact external provider/catalog APIs; retain filtering, byte limits and safe output handling. |
| `mcp.composio.authorize` | `rpc.write` | F | T | F | T | Excluded | External provider consent is outside the agreed scope. |
| `mcp.discover` | `rpc.read` + `rpc.write` in MCP | F | T | F | T | Split | Reloads a live integration session or creates a temporary one. Configured stdio integrations may launch processes, so it is treated like other code execution: destructive and open-world. |

### browserRelay

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `browserRelay.status` | `rpc.read` | T | - | - | F | Excluded | Read relay status and paired-key fingerprint, not logged-in tabs. Browser Relay routes are not MCP tools. |
| `browserRelay.test` | `rpc.write` | T | - | - | F | Excluded | Checks the relay's browser connection only; keeps its mutation permission. |
| `browserRelay.setup`<br>`browserRelay.start`<br>`browserRelay.stop` | `rpc.write` | F | T | T | F | Excluded | Installs/configures/starts/stops browser tooling. Browser control requires a separate workspace grant and user consent. |
| `browserRelay.unpair` | `rpc.write`, account-scoped browser | F | T | F | F | Excluded | Human-only Forget paired browser action. Deletes the saved public key, disconnects the old identity, and issues fresh pairing details. Client devices and agent callers cannot invoke this route. |

### crons

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `crons.list`<br>`crons.history` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `crons.create` | `rpc.write` | F | F | F | F | Tool | Adds a scheduled agent job; its later runs can modify the workspace and external systems. |
| `crons.update`<br>`crons.delete` | `rpc.write` | F | T | T | F | Tool | Replaces or removes a schedule, changing delayed effects. Deleting a schedule does not imply a running job stopped. |
| `crons.runNow` | `rpc.write` | F | T | F | T | Tool | Queues a manual agent run that can modify the workspace and external systems. Returns a run record, not completed output. |
| `crons.cancelRun` | `rpc.write` | F | T | T | F | Tool | Withdraws only the selected queued submission. If the cron has started, requires `confirmStopWorkspaceAgent: true` to stop the shared workspace agent and its children. Never auto-confirm after a queue-to-running race. |

Only one run per cron may be queued or running. Queue time does not count as execution time. A queued run expires after the shorter of its schedule interval and 24 hours; the scheduler withdraws that submission and records “Skipped: workspace busy.” After one hour of execution, it records an overdue notice in history and the workspace transcript without stopping the agent. The eventual terminal receipt supplies the final outcome.

### skills

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `skills.list` | `rpc.read` | T | - | - | F | Tool | Read saved state or metadata. Secrets/private keys must not enter outputs; status is not a live probe unless explicitly documented. |
| `skills.update` | `rpc.write` | F | T | T | F | Tool | Changes, replaces, or removes saved state/permissions. Revision checks are not a general retry guarantee. Configuration can affect later execution; describe that effect. |

### inspector

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `inspector.view`<br>`inspector.transcriptPage`<br>`inspector.transcriptContent`<br>`inspector.availability`<br>`inspector.overview`<br>`inspector.journal.list`<br>`inspector.review.list`<br>`inspector.repository.status`<br>`inspector.repository.file`<br>`inspector.repository.diff`<br>`inspector.artifacts.list`<br>`inspector.artifacts.shares.list`<br>`inspector.services.list` | `rpc.read` | T | - | - | F | Tool | Bounded inspection; preserve resource ownership and generation checks. Never implicitly open a space or start its runtime. |
| `inspector.repository.treePage`<br>`inspector.resources.readPage`<br>`inspector.artifacts.readPage` | `rpc.read` | T | - | - | F | Tool | Native finite-source pages with `cursor` and `limit` (1-16 frames). Cursors bind resource identity and snapshot content. A changed source rejects continuation; restart with null. Existing repository/artifact readers materialize the source on each call, but no RPC stream prefix is replayed. |
| `inspector.goal.put`<br>`inspector.workflow.put`<br>`inspector.rubric.put`<br>`inspector.guide.put`<br>`inspector.guide.submit`<br>`inspector.artifacts.write` | `rpc.write` | F | T | F | F | Tool | Replaces state or writes content. Preserve revision/hash/actor provenance; no generic retry promise. |
| `inspector.artifacts.copyToProject`<br>`inspector.artifacts.shares.revoke` | `rpc.write` | F | T | T | F | Tool | Copies artifact versions into project scope against expected destination hashes, or revokes a share. |
| `inspector.goal.attachEvidence`<br>`inspector.journal.append`<br>`inspector.review.create`<br>`inspector.review.reply` | `rpc.write` | F | F | F | F | Tool | Additive evidence/journal/message records only; no command execution. Duplicate submission can create additional records, so do not retry blindly. |
| `inspector.guide.markSectionRead`<br>`inspector.review.resolve` | `rpc.write` | F | F | F | F | Tool | Records reviewer read state, or resolves/reopens a review thread. Neither approves the Change Guide. |
| `inspector.journal.startPhase`<br>`inspector.journal.endPhase` | `rpc.write` | F | F | F | F | Tool | Opens or closes a journal phase and records its boundary entry; not merely appending free text. Supply unique phase-run and entry IDs. |
| `inspector.artifacts.uploadBegin` | `rpc.write` | F | F | F | F | Tool | Starts a chunked upload of one file (1 byte to 1 GiB) into `uploads/` of the space's writable artifact mount (`workspace` for worktrees, `base` for project spaces). Requires a live holder machine. Reserves the name (` (n)` before the extension on collision, never overwriting) and returns `chunkBytes` (256 KiB, sized for the 1 MiB client and 512 KiB Worker request caps). Uploads idle for 30 minutes are discarded. |
| `inspector.artifacts.uploadChunk`<br>`inspector.artifacts.uploadCommit` | `rpc.write` | F | F | T | F | Tool | Chunks are base64 with a per-chunk SHA-256 and strictly sequential offsets; only resending the last stored chunk is a no-op. Commit registers the file through the normal artifact store and publishes to the cloud in the background; nothing is posted to the agent transcript. |
| `inspector.artifacts.uploadAbort` | `rpc.write` | F | T | T | F | Tool | Discards an uncommitted upload's staged bytes; a committed or unknown upload reports `aborted: false`. |
| `inspector.workflow.waiveGate`<br>`inspector.rubric.appendJudgment`<br>`inspector.guide.setApproval` | `rpc.write` + `account.admin` for clients | F | F | F | F | Provenance | The server derives actor/reviewer identity from the verified device. Client decisions are recorded as client decisions. Agent code mode cannot claim human approval; recording a judgment does not execute its command or model. |
| `inspector.guide.analyze` | `rpc.write` | T | - | - | F | Tool | Read-like worksheet computation despite mutation RPC kind. Keep existing rpc.write requirement until contract/auth deliberately changes. |
| `inspector.artifacts.shares.create` | `rpc.write` | F | F | F | F | Tool | Creates a disclosure capability for stored content. Non-destructive does not mean safe to auto-approve; require explicit sharing authority and expiry. |
| `inspector.services.start` | `rpc.write` | F | T | F | T | Tool | May execute or release arbitrary code/model work, including destructive tools. Never auto-retry prompts, terminal input, or queue promotion. |
| `inspector.services.stop` | `rpc.write` | F | T | F | T | Tool | Interrupts active processes. Repeated calls can affect later work under the same name; do not promise idempotence without a target process generation. |

### project

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `project.events`<br>`project.directoryEvents` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |
| `project.list` | `rpc.read` | T | - | - | F | Tool | The cloud read may create the built-in GitSpace project record before listing; that one-time setup is housekeeping, so the tool is advertised read-only. |
| `project.create` | `rpc.write` | F | F | F | T | Tool | Creates a project from a remote or new managed repository plus its canonical agent. Returns lifecycle and operation records, not proof of readiness. |
| `project.open` | `rpc.write` | F | F | T | T | Tool | Materializes a cloud-only project's repository on a machine; returns null when no operation is needed. |
| `project.ensureGitSpace`<br>`project.restore` | `rpc.write` | F | F | T | F | Tool | Ensures the built-in project exists, or returns an archived project to active lifecycle without restoring workspace runtimes. |
| `project.setBaseBranch` | `rpc.write` | F | T | T | T | Tool | Replaces an active user project's base branch and switches its clean base checkout, fetching from the Git remote when one exists. Existing workspaces keep their branches; requires the current project revision and the base space open on its holder. |
| `project.archive`<br>`project.delete` | `rpc.write` | F | T | T | F | Tool | Can stop work, checkpoint, remove materialization, or delete records. Preserve revisions/generations and distinguish archive from permanent deletion. |

### space

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `space.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |
| `space.close` | `rpc.write` | F | T | T | F | Tool | Can stop work, checkpoint, remove materialization, or delete records. Preserve revisions/generations and distinguish archive from permanent deletion. |
| `space.reopen` | `rpc.write` | F | F | T | T | Tool | Opens a closed space from saved state or recovers its canonical agent on the matching holder. Returns lifecycle state and generation, not completed-work claims. |

### workspace

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `workspace.create` | `rpc.write` | F | F | F | T | Tool | Creates a branch workspace and starts its canonical agent. Return accepted operation identity, not completed-work claims. |
| `workspace.retryCreate` | `rpc.write` | F | F | T | T | Tool | Resumes a failed or interrupted creation at its first incomplete step, reusing the kept checkout, local projection and this machine's placement, then starts or resumes the canonical agent. |
| `workspace.restore` | `rpc.write` | F | F | T | T | Tool | Reactivates an archived workspace and opens its saved checkout and canonical agent. |
| `workspace.archive`<br>`workspace.delete` | `rpc.write` | F | T | T | F | Tool | Can stop work, checkpoint, remove materialization, or delete records. Preserve revisions/generations and distinguish archive from permanent deletion. |
| `workspace.setPhase`<br>`workspace.setRelations` | `rpc.write` | F | F | T | F | Tool | Reversible phase/dependency selections, subject to dependency phase constraints. The agent is informed of phase changes. |
| `workspace.stackStatus` | `rpc.read` | T | - | - | F | Tool | Bounded inspection; preserve resource ownership and generation checks. Never implicitly open a space or start its runtime. |

### terminals

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `terminals.events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |
| `terminals.live` | Browser session + `rpc.read` | T | - | - | F | Excluded | Protected lifecycle output is live-only, with no persistent log or replay. Never expose authentication output to MCP. |
| `terminals.list`<br>`terminals.read` | `rpc.read` | T | - | - | F | Tool | Bounded inspection; preserve resource ownership and generation checks. Never implicitly open a space or start its runtime. |
| `terminals.create` | `rpc.write` | F | F | F | F | Tool | Starts a new shell; nothing runs until input is sent. |
| `terminals.send` | `rpc.write` | F | T | F | T | Tool | May execute or release arbitrary code/model work. Protected lifecycle input additionally requires a browser session. Never auto-retry terminal input after uncertain delivery. |
| `terminals.stop` | `rpc.write`; lifecycle cancellation also requires `lifecycle.control` | F | T | T | F | Tool | Lifecycle terminals route through durable environment cancellation; stopping a terminal is not permission to bypass run ownership. Ordinary terminals stop their supervised process. |

### incidents

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `incidents.record` | `rpc.write` | F | F | T | F | Internal | Appends a diagnostic incident or recovery record; bind caller provenance and redact secrets. |

### events

| Existing RPC path(s) | Current base permission | R | D | I | O | Adapter | Behavior and constraints |
|---|---|---|---|---|---|---|---|
| `events` | `rpc.read` | T | - | - | F | Bounded | Live stream: bounded wait/page with cursor and cancellation; preserve expiration/resync signals and recheck grants. |

## Non-RPC frontend capabilities

These remain in the parity inventory outside the RPC contract. Browser-only gestures are not invented server operations; enrollment and OAuth are excluded. Dedicated interactive transports remain separate from MCP.

| Frontend capability | Current surface | Proposed external treatment | Proposed R/D/I/O |
|---|---|---|---|
| Account bootstrap, root recovery, initial enrollment | Root/invite-authorized account and device HTTP flows | Human setup/recovery, outside routine MCP control. Do not request a root recovery secret in a model conversation. Distinguish recovery discovery reads from provisioning writes. | No blanket annotation; do not publish one combined tool. |
| Create an API client | Browser `createApiClient` signs an invite and enrolls a fresh key | Enrollment is excluded. Create the server's dedicated signing key through the existing Connections setup. | Not advertised. |
| Enroll another browser or pair a machine | Browser-invitation and machine-pairing routes | Enrollment is excluded; existing routes and proof requirements remain unchanged. | Not advertised. |
| Account directory updates | Signed `/v1/directory/events` WebSocket | The browser retains its interactive transport. MCP uses bounded project, space, placement, and machine RPC reads/events for the corresponding account state. | See the corresponding operation rows. |
| Terminal and service interaction | Terminal RPCs plus interactive transports/service URLs | MCP create/send/read/stop tools as above; SDK may also offer dedicated interactive transport. Terminal output is untrusted data, not instructions. Do not send terminal commands to implement unrelated API methods. | See terminal/service rows; raw control is F/T/F/T. |
| Browser/CDP assistance | Workspace-granted browser relay and broker transport | Status is separate from control. Use a workspace capability and explicit access to the chosen browser/session. No ambient access to logged-in tabs. | Status T/-/-/F; arbitrary control F/T/F/T. |
| Provider and Composio consent | Provider login flow and signed Composio callback | Excluded from this implementation; keep existing browser flows unchanged. | Not advertised through this MCP server. |
| Open/download shared artifacts or service URLs | Artifact share links and tenant service routes | Resource links with bounded content reads; creating/revoking a share is a separate operation. URLs and secret-bearing links must be handled as capabilities. | Reading stored content T/-/-/F; disclosure changes use share rows. |
| Navigation, appearance and local UI actions | Browser route/viewport/editor state, copy/download gestures | Do not invent server mutations for local gestures. Expose their underlying data and persisted settings, where present. | Depends on the underlying operation, not the UI gesture. |

Sources: [browser device enrollment and API clients](../packages/account-web/src/device.ts#L85), [Connections UI](../packages/account-web/src/SettingsPage.tsx#L331), [account directory transport](../packages/account-web/src/account-directory-transport.ts#L19), [account HTTP routes](../packages/account-worker/src/application.ts), [browser relay doctrine](FLEET.md#L928).

## Authorization and operational constraints

### 1. Current reads can perform writes or execution

These are observed implementation behaviors, not hypothetical naming concerns:

| Path | Evidence | MCP enforcement |
|---|---|---|
| `machines` | [Account handler](../packages/account-worker/src/account-cloud-rpc.ts) calls fleet reconciliation, which can destroy, resume, or stop machines. | Reconciliation converges on recorded desired state, which is housekeeping; advertised read-only. MCP requires `rpc.read` and `fleet.control`. |
| `project.list` | [Handler](../packages/account-worker/src/account-cloud-rpc.ts) ensures the built-in project before listing. | One-time setup is housekeeping; advertised read-only and requires `rpc.read`. |
| `inference.list`, `inference.events`, `providers.list` | [Inference and provider handlers](../packages/account-worker/src/account-cloud-rpc.ts) can initialize or migrate inference state. | One-time initialization and migration are housekeeping; advertised read-only and require `rpc.read`, including for bounded events. |
| `mcp.discover` | [Discovery](../packages/account-machine/src/local-mcp.ts) reloads a live session or creates a temporary one. Stdio integrations may launch processes. | Requires read and write authority; advertised as non-read-only, destructive, and open-world. |

The annotation table classifies these by caller-visible effect: one-time initialization, migration, and reconciliation toward recorded desired state stay read-only, while reloading or launching integrations on the caller's behalf (`mcp.discover`) does not. Inspect the complete effect chain, including event-driven work and delayed cron execution, before changing an annotation.

### 2. Human provenance is not an input enum

**Explicit delegated administration:** account-scoped API clients may perform account administration with `account.admin` and lifecycle approval, cancellation, recovery, and destruction with `lifecycle.control`. Both require `rpc.write`. API/MCP keys with `lifecycle.control` may approve browser origins. Project origin approval applies only where the workspace's committed bundle lists that origin; older branches gain it after merging or rebasing the base branch. Existing clients gain no new authority automatically. The lifecycle actor records its actual kind and verified control authority instead of claiming `human: true`.

**Excluded flows:** provider OAuth and Composio consent, identity bootstrap, enrollment, and account recovery retain their existing paths and authorization.

**Image recovery:** `approvedBy` identifies the actual authenticated device. Do not describe an API-client decision as human attestation.

**Inspector provenance:** cloud and machine adapters derive waiver actors, guide reviewers, and judgment actors from the verified device. API clients need account administration authority and are recorded as clients. Agent code mode rejects human approval claims and records permitted command/LLM judgments as agent evidence. Existing stored human records remain readable; the cloud waiver table migrates to accept client actors.

`session.setApproval` requires `account.admin` for an API client, plus account scope and `rpc.write`. Broad ordinary write access does not grant this policy authority.

### 3. Scope and permission granularity need an explicit contract

Machine dispatch resolves nested and session-only targets before enforcing project/workspace scope. Cloud dispatch still requires account scope for cloud-backed account/Inspector operations; a narrow grant does not imply complete cloud parity.

Ordinary `rpc.write` remains broad: it includes terminal execution, integrations, secrets, and sharing. Account administration and lifecycle control are explicit additional permissions, not automatic upgrades to existing clients.

### 4. Retries and completion must be truthful

- [Environment acceptance](../packages/account-machine/src/workspace-environment.ts#L198) returns the existing run for a reused space/run ID; the [lifecycle claim](../packages/protocol-environment/src/lifecycle.ts#L255) rejects identity collisions and reports an existing claim without re-executing it. Preserve that behavior and identical inputs in the adapter. A new run ID authorizes a new attempt.
- Do not add automatic retries to prompts, terminal input, queue edits, creates, deployments, or other I=false operations after an ambiguous timeout. Read state and reconcile first. RPC anti-replay nonces are not business-operation deduplication.
- Return accepted/running/completed/failed distinctly. A deployment launch is not activation; cancellation acceptance is not process exit; log EOF is not execution success.
- Any new I=true claim requires an end-to-end invariant and a repeated-request test, including response loss. Do not promote a hint based solely on an input field name.

### 5. Streams, schemas and secrets need explicit MCP adapters

- Reuse the canonical handlers and authorization. Generate MCP input/output descriptions from one reviewed catalog, with explicit mappings for custom codecs, dates, bytes, tagged errors, and resource references. A private TypeScript package or result-rpc wire codec is not automatically an installable SDK or valid MCP JSON Schema.
- For finite streams, retain completeness and cancellation semantics. If a bounded response is partial, say so and return a continuation/reference; never label truncated content a complete transcript, file, or repository tree.
- For live streams, bound wait time, output bytes and event count; provide cursors and resync behavior. Cancel upstream work when the client disconnects. A standard MCP client must not need an indefinitely open tools/call to inspect progress.
- Return structured results and declared errors in a stable MCP-compatible form. Keep authentication/protocol errors distinct from operation failures, and sanitize undeclared failures without turning them into success.
- Secret reads remain metadata-only. Secrets passed into credential-management operations must not be echoed or logged. OAuth credentials and recovery material belong in protected human setup, not ordinary model-visible tool calls.
- `destructiveHint: false` does not grant consent to publish data. Artifact sharing, secret grants and credential delegation need explicit disclosure/authority policy.

## MCP results and continuations

- Ordinary tool results use `{ result: ... }` in structured content and matching JSON text.
- Live reads return `{ items, nextInput, complete, reason, gap }`. They stop at 64 items, 1 MiB of encoded items, or the wait deadline. `_mcp.waitMs` defaults to 5 seconds and accepts 1–20,000 milliseconds. Follow `nextInput`; `complete: false` is not EOF. A gap requires resynchronization.
- Finite transcript, subagent, repository-tree, artifact, and retained-resource subscriptions use native page queries. Preserve generation and cursor fields. Inspector snapshot pages contain at most 16 frames and 900 KiB of frame JSON. They hash the current source and identity; changed snapshots reject continuation rather than splice different versions together. Existing readers still materialize the source on each call.
- Resource templates cover files, artifacts, retained resources, goals, transcripts, transcript content, session history, and subagent transcripts. Their path parameter is percent-encoded JSON matching the corresponding tool input.
- Enabled built-in skills are actual shared skill source at `gitspace://skills/{id}`. These are the instructions installed for GitSpace agents; their injected `space` code-mode namespace is not an MCP client API. MCP callers use named tools instead.
- The installed official SDK is `@modelcontextprotocol/sdk` 1.30.1. This server advertises tools and resources, not a native Skills or Tasks extension. Long-running work returns GitSpace's existing operation handles.
- JSON-native values remain ordinary JSON. Non-JSON values use explicit `$gitspace` tags; binary values, cycles, shared references, and tag collisions use the existing result-rpc serialization envelope. The published schemas describe the representation, and decoding still runs the original codec validation. Declared errors retain safe tagged data; undeclared failures are generic. Mutations are never automatically retried.
- Authentication/protocol errors remain distinct from tool failures. The endpoint rejects missing configuration, invalid bearer keys, wrong tenant/origin, expired or revoked signing grants, and request bodies above 1 MiB. GET event streams are not supported.

## Verification

Verified in this checkout, without deploying:

1. All workspace package typechecks pass.
2. Protocol, MCP stream/credential, lifecycle, and focused machine authorization tests pass in isolated processes.
3. The official MCP client talks to the actual Worker and Durable Objects in Cloudflare's test runtime: full tool discovery/schema compilation, signed configuration write/read, built-in skill resource read, bounded settings events, declared error data, read-only write denial, bad bearer rejection, and revoked backing-grant rejection.
4. Existing cloud tests cover delegated lifecycle authority, preserved content review, authenticated reviewer identity, and stopped-workspace reads. Inspector storage tests cover client provenance.
5. Browser verification renders the actual Settings controls with local-only callbacks: enable with selected permissions, one-time token/configuration display, token removal after closing and remounting, confirmed rotation, and confirmed disable. Administrative switches start off, the scope shows Whole account explicitly, and dialogs scroll within the viewport. No live credential is minted.
6. The initial MCP implementation's pre-change contract comparison found the six intentional Inspector signature changes and three added page queries. The current contract also includes the four artifact-upload operations.
7. The durable setup run passes 11 MCP boundary tests and 33 account-cloud tests. Coverage includes signed browser setup, token rotation and disable, issuer revocation, forbidden delegation, stale concurrent enables without orphan grants, metadata-only status, encrypted storage, and vault reconstruction. All package typechecks and lockfile synchronization pass.
8. Standard MCP client discovery returned all 197 operation-specific descriptions and nine resource templates, with no missing entries or references to nonexistent tool names, before the six paged streams were removed from the tool catalog. Package typechecks and all 11 Worker MCP integration tests pass after the description update. No wording snapshots were added to the test suite.

## Source map and verification

- [Account router](../packages/account-worker/src/account-cloud-rpc.ts), [configuration/MCP/crons](../packages/account-worker/src/account-configuration-rpc.ts), [Inspector](../packages/account-worker/src/account-inspector-rpc.ts), [typed Inspector authority](../packages/account-worker/src/space-context.ts).
- [Machine router](../packages/account-machine/src/rpc-router.ts), [environment runtime](../packages/account-machine/src/workspace-environment.ts), [integration runtime](../packages/account-machine/src/local-mcp.ts).
- [Device capabilities and scopes](../packages/protocol/src/device-grant.ts), [signed machine dispatch](../packages/account-machine/src/signed-rpc.ts), [Inspector input schemas](../packages/protocol/src/inspector-contract.ts).
- [Original SDK design](FLEET.md#L906) and [parity roadmap](FLEET.md#L1043).

Coverage is an inventory plus targeted runtime evidence, not a claim that every operation was executed against every live provider. No tenant has been deployed or configured by this work. Enable MCP in Connections after deploying the compatible source release.
