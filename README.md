# GitSpace

GitSpace is a browser workspace for coding agents across your own computers and cloud machines. Workspaces keep their code, agent conversation, goals, review evidence, artifacts, and services together.

You or an agent can modify GitSpace from a workspace and hot-deploy changes through the account's release system. Worker, frontend, machine, and OMP are separate account-governed targets. Use **Launch GitSpace from here** in the source workspace menu; the release system handles activation rather than a manual server restart. See the [hot tenant deployment procedure](.agents/skills/gitspace-tenant-deployment/SKILL.md) for target selection, progress, and verification.

## Start in the browser

1. Open [gitspace.sh](https://gitspace.sh) with an invitation and choose your permanent account handle.
2. Save the recovery key in a password manager and confirm it before creating the account.
3. Choose **Open GitSpace** to enroll the browser and enter your account.
4. Create a cloud machine or choose **Settings > Machines > Add a computer**.
5. Connect an agent provider, create a project and workspace, and try a small task.

No local installation is required for account creation or cloud-only use. The [getting-started guide](https://gitspace.sh/docs/getting-started) walks through both paths.

## Connect your own computer

Install Git and the OpenSSH client on the computer first. Then follow the account's **Add a computer** walkthrough:

```sh
curl -fsSL https://gitspace.sh/install | sh
```

The installer selects a published platform build and verifies its checksum. GitSpace supplies its own runtime; no source checkout, separately installed Bun, or local build is needed.

Generate a short-lived pairing command in the browser and run it on that computer:

```sh
gitspace machine setup --pair <token>
```

Compare the signing key shown in the terminal and browser before approving the computer. Setup downloads the verified runtime and starts it. The computer receives its own machine identity, not your account root private key.

Local commands operate that machine:

```sh
gitspace machine status
gitspace doctor
gitspace machine stop
gitspace machine start
gitspace open
```

The account release system manages runtime changes. There is no separate local update command. See the [CLI reference](https://gitspace.sh/docs/cli-reference).

## Workspace workflow

- Plan with goals, requirements, workflows, and durable notes.
- Run OMP agents on the machine that owns the workspace.
- Answer structured questions and inspect diffs in the browser.
- Keep review threads, journals, evidence, and change guides with the work.
- Manage services, events, crons, secrets, plugins, and releases from their account or workspace surfaces.

The transcript groups updates for the same background job, process run, or subagent into one card. Expand it to read the original calls and complete output inline; older history loads in pages. Separate launches and process restarts keep separate cards, even when a name or job ID is reused.

Grouping uses recorded execution identities, not matching command text. Calls with unrelated output or insufficient identity stay visible rather than being folded into the wrong history.

After a runtime handoff, recovery ends when the resumed agent starts executing on an available, owned runtime. Its task can keep running or waiting without locking message input for the rest of the turn.

Session history loads only when you open it. The explorer reads up to 200 entries before and after the selected entry along its branch, with a 256 KiB page limit and a fixed traversal budget. Older and newer windows replace the current window; branch choices load separately. Filtering searches only the loaded prompts. Selecting an entry inspects its neighborhood without changing the running agent. **Resume from here** changes the agent's branch. Closing history releases the loaded window; the full conversation remains saved.

Cloud machines are temporary. In **Settings > Machines**, **Stop** saves supported workspace state before stopping the machine. If saving fails, the machine stays online. **Start** runs a fresh machine environment and restores saved workspaces, not the old machine disk.

Workspace checkpoints save the Git branch, commits, staged and unstaged tracked changes, non-ignored untracked files, agent conversation, and GitSpace artifacts. They do not save installed packages, machine-local configuration, ignored files, or arbitrary files elsewhere on the machine, including its home directory. Ask a normal workspace agent to install tools as needed; those changes are temporary.

Closing a workspace, stopping a cloud machine, and destroying a machine are different operations. Controlled workspace close, Stop, and provider replacement publish durable checkpoints before releasing ownership. After an unexpected interruption, the last completed checkpoint is the recovery limit; uncheckpointed work may be lost. Automatic recovery from unclean disk loss and a returning-machine recovery ZIP are not implemented yet.

## Security

The account root authorizes browser devices. An account-wide delegating browser can approve a separate machine identity. Requests carry device signatures; artifact/checkpoint blobs are encrypted and machine credentials are sealed to machine keys.

The production RPC path is not fully end-to-end encrypted. Treat the account Worker, relay, and machine hosts as part of the documented trust boundary. See [Security boundaries](https://gitspace.sh/docs/security/remote-access).

## Development

The v1 implementation lives in `packages/`. A source checkout is for development, not installation. Existing root `src/` and npm `gssh` entrypoints belong to the older product and are not the v1 onboarding path.

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck:packages
```

`bun run dev` starts the self-development environment. Release builds use the pinned toolchain and native platform workflow in `.github/workflows/publish-distribution.yml`.

### Choose the deployment authority

Use the product's deployment entrypoints, not a new upload or activation script.

| Change | Supported path |
|---|---|
| A user's GitSpace account, such as `bradleat.gitspace.sh` | In the GitSpace source workspace's menu, choose **Launch GitSpace from here**. This calls `deployment.launch({ workspaceId, targets })`. `DeploymentLauncher` owns install, build, upload, staging, launch, and project progress events. The release follower and runtime hosts own activation. |
| Platform/operator-managed releases | Use the existing platform/operator deployment workflow for that component. Tenant Worker deploys and reverts use the authenticated `/__platform/operator/tenants/:tenant/deploy` and `/revert` routes. Native distributions and cloud images use their existing GitHub publication and rollout workflows. |

The account targets are `worker` (the tenant Worker), `machine`, `omp`, and `frontend`. The shared operator/control Worker is not the account's `worker` target. Treat changes to shared platform services as a separate platform deployment.

Account deployment progress comes from `DeploymentLauncher` through `deployment.status` and project `deployment` events. The client uses these for its Source indicator and launch progress sheet. Direct calls to builders, blob storage, or desired-release APIs bypass that progress flow.

Do not manually write runtime-selection files or call `/__environment/launch` as an alternate deployment procedure. Those are implementation details of the product's replacement path. If the supported path fails, diagnose that failure and fix the path rather than bypassing it. **Back to stable** uses the account's `deployment.revert` operation.

For the first upgrade from a machine whose launcher predates native packaging,
keep its existing host running and use the CLI's source-recovery entrypoint
**before** replacing the host or cloud image:

```bash
gitspace machine recover --source /path/to/held/gitspace-checkout --workspace <workspace-id>
# The same product command from an installed source checkout:
bun packages/cli/src/index.ts machine recover --source . --workspace <workspace-id>
```

Run it from a native shell or linked provider console, not a managed terminal
that replacement will drain. Recovery reads the current workspace database in
readonly mode, then runs the ordinary `DeploymentLauncher` build/upload/stage/
launch transaction with the source checkout's own builders. It stages only the
tenant's machine target and waits for the old host's normal health/rollback
result; it does not change host/runtime selections, stop the host, or replace
tenant code with stock code. The first native build needs the real pinned
toolchain or verified build cache described in [FLEET.md](docs/FLEET.md), not an
untracked or older global WalGit binary. After success, ordinary **Launch GitSpace
from here** handles subsequent native changes through workspace-owned builds.

Cloud container images build on GitHub through `.github/workflows/publish-container.yml`. Push a `container-*` tag to build and publish that commit.

- Set the repository variable `CLOUDFLARE_ACCOUNT_ID`.
- Set `CLOUDFLARE_API_TOKEN` with registry write access. For a one-off run, fresh `CLOUDFLARE_REGISTRY_USERNAME` and `CLOUDFLARE_REGISTRY_PASSWORD` secrets also work; these credentials expire.
- The workflow checks packaged Bun, walgit, and OMP before uploading. Its `cloud-container-reference` artifact records the immutable image digest and source commit.
- Publication does not change running machines. Select the digest through the account's cloud-machine image controls. Each machine checkpoints and transfers independently; changing one machine's image does not roll the others.

Bun's module mocks leak between test files in a shared process. Use isolated processes for trusted machine/core results, for example:

```sh
bun scripts/test-isolated.ts packages/account-machine/test packages/core/test
```

Worker packages use their own Vitest/Cloudflare test commands.

### Rolling runtime diagnostics

Native replacement requires the old process to acknowledge retained workspace ownership before termination. The host keeps its deployment journal in `deployment.db`, outside the runtime database rollback set; runtime snapshots include committed SQLite WAL pages. Failed candidate startup must stop before the old database is restored.

Cloud VM stop and image replacement discard the ephemeral disk. Running machines must acknowledge a checkpoint before Stop; explicit destructive removal remains separate. Inspection and checkpoint control do not automatically boot a stopped VM.

Worker uploads enable persisted invocation and application logs with query-string redaction. Follow `cloud_image_operation` and `cloud_image_provider_request` in the tenant Worker, `sandbox.lifecycle` in the selected provider Worker, and `native_replacement` in the machine host. Correlate machine, image operation, native generation, request ID, and Cloudflare Ray ID where available. A native readiness event is not proof that every workspace restored; the cloud image admission barrier remains until the recorded workspaces reopen.

### Artifact sync diagnostics

The machine emits `artifact_sync_attempt` and `artifact_sync_request` JSON records to its logs. Find a failed attempt by `sessionId`, then use its `attemptId` to follow the control and blob requests. Each `requestId` is the signed request's nonce.

For these requests, the account Worker emits `artifact_sync_worker_request` records with the same attempt and request IDs. Its final record describes response construction, not delivery to the machine. The machine records failures before headers, while reading the response body, or during HTTP, application, and integrity checks. Records include UTC start time, elapsed milliseconds, and HTTP status and Cloudflare Ray ID when available.

Both machine and Worker releases must include these diagnostics for cross-side correlation. They do not log request payloads, credentials, artifact paths or contents, or raw exception messages. They do not add retries or change sync outcomes.

## Documentation and license

- [User documentation](https://gitspace.sh/docs)
- [Agent workflow](https://gitspace.sh/docs/agent-workflow)
- [Fleet architecture](docs/FLEET.md)
- [License](LICENSE), including its non-compete clause

Contributions are welcome through pull requests.
