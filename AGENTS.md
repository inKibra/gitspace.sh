# GitSpace Development Guide

GitSpace is a browser workspace for coding agents across local and cloud machines. The current implementation lives in `packages/`.

## Current CLI and agent interfaces

- The current CLI is **`gitspace`**, implemented in `packages/cli/src/index.ts` and exposed by `packages/cli/package.json` and `bin/gitspace`.
- The old `gssh` product has been removed. Its command tree and configuration paths are not supported by the current CLI.
- Embedded Pi agents use the cloud runtime's typed tools, including `environment`, `space_workspace`, retained workflow tools, and project-granted MCP connections. Check their current schemas and matching skills rather than translating old CLI commands into invented APIs.
- Verify commands against `packages/cli/src/index.ts`, `gitspace --help`, and [the current CLI reference](packages/docs/src/cli-reference.mdx). Label proposed commands as proposals until implemented.
- [README.md](README.md) describes current onboarding and development. User documentation lives in `packages/docs/src/`.

## Hot tenant deployments

GitSpace supports hot tenant deployments as a first-class development workflow.
Before deployment work or advice, MUST read
[the tenant deployment skill](.agents/skills/gitspace-tenant-deployment/SKILL.md).
This account release flow governs tenant source deployments.

- Use the canonical tenant launch flow, not manual process restarts, deployment
  pointer edits, or host/image replacement.
- Shared-contract changes determine the compatible release target set. Apply
  that set through the normal launch flow; do not treat it as a separate
  deployment project or a reason to stop at a compatibility warning.
- Honor deployment authorization already given for the current tenant and
  task without asking again. Code-only or documentation-only requests do not
  authorize a live launch. Do not bypass product approval gates or expand the
  authorized scope to other tenants, platform releases, or destructive actions.
- Follow launch progress through activation or failure. Report the tenant,
  source workspace, release, targets, and observed result. A successful build
  or accepted launch is not proof that the tenant runs the new code.

## Browser-first workflow

Create and recover accounts at [gitspace.sh](https://gitspace.sh). Manage projects, workspaces, agents, and releases in the browser. Cloud-only use requires no local CLI.

To connect a computer, use **Settings > Machines > Add a computer** and the browser-generated pairing command:

```sh
gitspace machine setup --pair <token>
```

The client downloads the verified account-managed runtime. It does not require a source checkout or separately installed Bun. Local machine commands include:

```sh
gitspace machine status
gitspace machine start
gitspace machine stop
gitspace doctor
gitspace open
```

These commands operate a linked machine; they are not the agent's workspace-management API. See the CLI reference for options and restrictions.

## Current source map

| Area | Source |
| --- | --- |
| Local client | `packages/cli/` |
| Account browser app | `packages/account-web/` |
| Tenant control plane and durable authorities | `packages/account-worker/` |
| Machine attachments, lifecycle runner, workspace recovery | `packages/account-machine/` |
| Cloud Pi harness and durable workspace runtime | `packages/runtime-core/`, `packages/runtime-workspace-do/` |
| Signed machine effects and process supervision | `packages/runtime-machine/`, `packages/supervisor/` |
| Runtime contracts, provider authentication and model catalog | `packages/protocol-runtime/`, `packages/provider-auth/`, `packages/catalog/` |
| Shared RPC and credential contracts | `packages/protocol/` |
| Agent, environment, workspace, and synchronization contracts | `packages/protocol-agent/`, `packages/protocol-environment/`, `packages/protocol-workspace/`, `packages/protocol-sync/` |
| Core persistence | `packages/core/` |
| UI and transcript blocks | `packages/ui/`, `packages/blocks/` |
| MCP server | `packages/mcp-server/` |
| Release tooling | `packages/deployment/` |
| Platform, operator, and cloud provider services | `packages/platform/`, `packages/operator-worker/`, `packages/operator-web/`, `packages/sandbox-worker/` |
| Current user documentation | `packages/docs/src/` |

Follow existing package boundaries and typed contracts.

## Lifecycle, sessions, and artifacts

- Before repository setup or lifecycle work, read the `workspace-lifecycle` skill. Use `.gitspace/bundle.json` and the existing `.gitspace/lifecycle/` phases, not the old pre/setup/select/remove hooks.
- Preserve content approvals, durable run identities, machine/placement fencing, cancellation, and uncertain-effect recovery. Authentication or user input does not approve code or authorize a cloud rerun.
- Checkpoints preserve supported Git changes, references to cloud conversation state, and GitSpace evidence. Code repositories use Artifacts; encrypted `local://` evidence is separate. Checkpoints do not preserve installed packages, ignored files, arbitrary home-directory state, or machine credentials.
- Do not assume a workspace move copies the machine disk. Keep project state separate from disposable machine state.
- Use the `workspace-services` skill for services and `space-artifacts` for artifact publication. Do not substitute legacy CLI commands for these interfaces.
- Pi session state, inference, login, refresh and account selection belong to the cloud. Machines execute authorized effects; do not add a machine inference fallback. Preserve bounded history and durable recovery when modifying these paths.

## Security

The current production RPC path is not fully end-to-end encrypted. Account Worker, relay, and machine hosts are part of the documented trust boundary. Do not repeat the legacy claim that the relay cannot decrypt any application traffic.

Device signatures authorize requests. Artifact/checkpoint blobs are encrypted and machine credentials are sealed to machine keys. Check the actual capability and project/workspace scope for each operation; transport encryption alone is not authorization.

See the current [security documentation](https://gitspace.sh/docs/security/remote-access). The local client stores identity/runtime state under `~/.config/gitspace/`; use current code and docs for specific paths rather than the old `~/gitspace/.identity/` layout.

## Development and verification

From a development checkout:

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck
```

Root build, test, and typecheck commands target the current packages. Use package-local scripts for focused checks.

Bun module mocks leak between test files in a shared process. Use isolated processes for trusted results, for example:

```sh
bun scripts/test-isolated.ts packages/account-machine/test packages/core/test
```

A single `bun test <one.test.ts>` is also valid. Worker packages use their own Vitest/Cloudflare test commands. Do not treat a broad bare `bun test` run as reliable.

For CLI changes, exercise the actual current entrypoint, for example `bun packages/cli/src/index.ts --help`. For UI changes, verify the actual browser surface. Do not run setup, lifecycle, or deployment effects merely to inspect them.

Use TypeScript ESM and existing package-local error, logging, authorization, and validation patterns. Check current manifests for dependencies instead of copying assumptions from the legacy root implementation. For all TypeScript work, read [the type-system skill](.agents/skills/type-system/SKILL.md): owner-connected types, zod at boundaries, `better-result` errors, no laundering casts, and `*.typecheck.ts` type tests.

## Documentation

- [README.md](README.md): current onboarding, development, deployment boundaries, and recovery limits.
- [CLI reference](packages/docs/src/cli-reference.mdx): supported client commands.
- [Workspace lifecycle](packages/docs/src/workspace-lifecycle.mdx) and [lifecycle reference](packages/docs/src/lifecycle-reference.mdx): environment behavior and approval contracts.
- [Fleet architecture](docs/FLEET.md): native runtime and fleet details.
- Relevant skills provide task-specific agent interfaces. Keep this file short; do not duplicate a large command reference that can drift from its implementation.
