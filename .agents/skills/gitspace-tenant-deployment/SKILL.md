---
name: gitspace-tenant-deployment
description: Use when deploying GitSpace changes to a tenant, selecting release targets, checking activation, reverting a release, or discussing how to ship a workspace's changes. Hot tenant deployment is the normal product workflow, not a manual server restart.
---

# Hot tenant deployment

GitSpace can build itself from a workspace and launch the result into the account that owns it. Use the existing account release system. Machine releases include the host and updater; do not replace either by hand.

## Scope and authority

- Resolve the account/tenant, source workspace ID, and checkout from the current workspace and authenticated product state. Do not guess from a browser tab title or a branch name.
- A tenant launch changes account-owned target selections, not just the source workspace. Inspect the current fleet before describing its impact.
- Honor deployment authorization already given for this tenant and task. Do not repeatedly ask for the same permission. A request to deploy or launch authorizes the normal product flow within that scope, including its health gates and automatic rollback.
- A code-only or documentation-only request does not authorize a live launch. Never expand an authorized tenant launch into a platform release, another tenant, infrastructure replacement, or destructive migration. Honor any human approval gate the product requires.

## Choose the targets

The release targets are `worker`, `frontend`, `machine`, and `omp`. Inspect the complete selected checkout, including pending changes, rather than assuming a build contains only the latest fix.

- Frontend-only changes can target `frontend`; machine implementation changes can target `machine` when their contracts remain compatible.
- A `machine` release replaces the complete machine application, including host activation code. Its temporary updater drains the old application, checkpoints state, starts and checks the replacement, then exits. Failed activation restores the predecessor. Expect a short disconnect.
- OMP runtime, dependency, or patch changes target `omp`. Include other targets when their compatibility contracts change too.
- Shared RPC/schema changes require the compatible set of producers and consumers. Strict custom codec changes need a new codec identity because validation functions do not participate in the contract digest. For a contract shared by frontend, worker, and machine, include all three.
- Compatibility determines the target set within the normal tenant launch. It is not a reason to invent a separate rollout procedure or stop at a warning about a coordinated deployment.

## Launch through GitSpace

### Browser

1. Open the source workspace in the account's GitSpace source project.
2. Use the workspace menu's **Launch GitSpace from here** action. This action launches all four targets; do not describe it as a selected-target launch.
3. Follow launch progress. The sidebar's **Source** entry opens **Settings > Source**, which shows selections, releases, and running machines.

### Authenticated API

Use the existing product client or an available, authorized integration. These are RPC procedure names, not shell commands or assumed harness tools:

- `deployment.status({})`: current selections, release records, running machine state, and the latest launch on the answering machine.
- `deployment.launch({ workspaceId, targets })`: start the source build and launch. It returns progress immediately, not proof of activation.
- Progress arrives through `deployment` fact events and `deployment.status({}).launch`.
- `deployment.revert({})`: return account selections to the stable/channel build. The browser labels this **Back to stable**; it is not a rollback to an arbitrary previous source release.

Use the authenticated browser if no suitable API integration is available. Do not scrape credentials, edit deployment pointers or databases, or invent a `gitspace deploy` command.

## Verify completion

1. Record the `launchId`, source `workspaceId`, targets, and resulting release `sha`. Follow that launch, not another concurrent launch on a different machine.
2. Inspect build/launch failures and per-target release status. An accepted request or uploaded bundle does not prove activation.
3. Compare `desired` selections with `current` worker and fleet machine state, plus `thisMachine` state. Account for each target independently, including `ompSha` and `ompDraining`. Report machines still converging rather than declaring fleet-wide success.
   Machine status must follow the committed complete host, not just the first machine child started during an old-host upgrade. The updater must finish before the release counts as applied.
4. For frontend changes, verify the served build and reload the browser after activation. Reloading unchanged assets does not fix a wire mismatch. Exercise the changed behavior on the deployed surface.
5. Report the tenant, source workspace, release SHA, selected targets, observed activation result, and remaining convergence or failure. Distinguish locally verified code from deployed code.

Hot deployment does not promise zero interruption. Let the product manage drain, health checks, generation switches, reconnects, and rollback. Do not manually stop healthy processes to force convergence.

## Recovery is exceptional

`gitspace machine recover --source <checkout> --workspace <id>` stages a machine release when the running launcher cannot build the required source upgrade. It is not the ordinary deployment entry point. The release follows the same complete-machine activation and rollback path. Read the recovery prerequisites in [FLEET.md](../../../docs/FLEET.md) before using it; run outside a session the machine will drain. A machine-only recovery cannot apply a multi-target protocol change safely by itself.

Do not substitute `bun run dev`, a standalone Vite server, a service restart, or a host/image replacement for a tenant launch. Those actions do not establish the account's selected release.

Channel builds that predate complete-host packaging cannot serve as complete machine replacements. The updater rejects them before draining; do not bypass this check or combine an old machine with a newer host and call it stable.

## Source references

- [RPC contracts](../../../packages/protocol/src/rpc-contract.ts): `deploymentStatusContract`, `deploymentLaunchContract`, `deploymentRevertContract`.
- [Browser launch wiring](../../../packages/account-web/src/LiveApp.tsx): `launchInto`, deployment progress, and status queries.
- [Workspace launch menu](../../../packages/account-web/src/AppSidebar.tsx): `SpaceMenu` and `SourcePill`.
- [Source settings](../../../packages/account-web/src/SettingsPage.tsx): `SourceSettings`.
- [Convergence rules](../../../packages/account-web/src/release.ts): independent machine and OMP selections.
- [Architecture and recovery constraints](../../../docs/FLEET.md).
