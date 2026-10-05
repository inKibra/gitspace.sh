# GitSpace

GitSpace is a browser workspace for coding agents across your own computers and cloud machines. Workspaces keep their code, agent conversation, goals, review evidence, artifacts, and services together.

You or an agent can modify GitSpace from a workspace and hot-deploy changes through the account's release system. Worker, frontend, and machine are separate account-governed targets. Use **Launch GitSpace from here** in the source workspace menu; the release system handles activation rather than a manual server restart. See the [hot tenant deployment procedure](.agents/skills/gitspace-tenant-deployment/SKILL.md) for target selection, progress, and verification.

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
- Run Pi conversations, inference, and repository file edits in the cloud; attach machines for processes and Git commands.
- Answer structured questions and inspect diffs in the browser.
- Keep review threads, journals, evidence, and change guides with the work.
- Manage services, events, crons, secrets, plugins, and releases from their account or workspace surfaces.

The cloud workspace follows committed conversations, tasks, questions, and documents through Chord snapshots and deltas. The existing workspace shell and Inspector read that state. Watch streams reconnect from the last accepted cursor and replace local state when the server reports a gap. Transcript pages load older history beyond the bounded live snapshot. **Saved OMP history** provides read-only access to supported historical conversations, not a machine runtime fallback.

Moving or restarting a machine does not move the cloud conversation. Without a primary machine, `read`, `edit`, and `write` use the workspace's current Artifacts snapshot. Edits publish new working-tree snapshots, preserving HEAD and the index. Staging, branch commits, checkout, and rebase remain deliberate Git commands on a machine. An interrupted unsafe machine effect is not replayed merely because its machine reconnects.

The workspace **Machines** panel manages attachments. A primary attachment holds the single-writer lease and receives repository file tools. The cloud holds that lease when no primary is attached. Attaching checks out the latest snapshot; detaching fences new execution, flushes a final snapshot, and waits for cleanup before releasing the lease. The cloud continues from that snapshot. Runners use a fixed checkpoint; delegates use a separate branch. Their explicit placements do not silently follow a different working copy.

Model choices retain their default, role, or explicit-model intent. New requests resolve that intent against the current profile and catalog; admitted requests keep their model. If a selected model disappears, the next request records its fallback in the transcript. Catalog reads and admissions refresh published Pi metadata once its four-hour cache expires, using ETags. Bundled Pi models remain the fallback catalog.

Browser tools default to local headless Chromium on an attached executor. Tests, previews, scraping, and tasks that do not need your signed-in accounts use headless, without browser approval in any mode. Subagents can use headless only. Headless Chrome uses private inherited pipes, not a localhost debugging port. Its persistent profiles live outside the environment root, under `~/.gitspace-browser-profiles/`, with owner-only directory permissions.

Browser Relay connects to your Chrome through an extension installed under `~/.gitspace-browser-relay/`, outside the environment root. The native runtime checks its files before accepting a connection. Pair through authenticated **Settings > Connections > Browser Relay** once. The extension keeps a non-exportable signing key in IndexedDB; the native runtime stores only its public key in an owner-only file. Pairing survives native and browser restarts. The localhost relay is not a public CDP endpoint and holds no browser authority by itself.
Settings and the extension popup show the public key's SHA-256 fingerprint. Compare them after pairing; they should match. After reinstalling the extension, use **Forget paired browser** in the setup guide, then get fresh pairing JSON. Forget removes the machine's saved public key and disconnects the old identity. The extension popup's **Reset identity** deletes its private/public key and account trust and detaches its sessions; use Forget in Settings before pairing the new identity. Reset does not erase replay protection or renew old approvals.

Only the main agent may explicitly request `source: relay`, when it needs your signed-in Chrome session. Each workspace gets one coloured tab group named after the workspace. The agent can list, open, navigate, act on, evaluate, screenshot, and close tabs only inside that group. Other tabs are invisible to it. Drag an existing tab into the group to share it; drag it out to take it back. There is no tab picker or per-tab lease.

Relay host grants live in the committed `.gitspace/bundle.json` under `browser.origins`, for example `["github.com", "*.cloudflare.com"]`. Entries name hosts or host patterns, never paths; `"*"` grants all HTTP(S) hosts. Each entry has its own content hash and approval in **Environment**, using the existing lifecycle-control authority and project or workspace scope. Whole-account API/MCP keys with Write and `lifecycle.control` may approve browser origins; this authority is intentional.

A project approval on base applies only where the workspace's committed bundle lists that origin. Branches created before base added it inherit the grant once they merge or rebase base and include the entry. A branch-only entry needs workspace approval until merged and approved on base. Removing an entry drops its workspace approval; removing it on base also drops its project approval. Re-adding the entry does not restore those approvals.

Creating a relay group needs approval outside **yolo** and happens automatically in yolo. Revoking a group fences its old grants; the next request creates a new group under the same approval rule. Once a group exists, navigation and actions within approved hosts need no further prompts; JavaScript and screenshots are included. Origin grants require lifecycle-control approval, including in yolo. When a host is missing, the agent proposes an environment-file edit instead of widening its own access. Redirects and a page's own network requests are not intercepted. Navigation waits for Chrome's reply before starting a load wait of up to ten seconds, or less when the dispatch expires sooner. A committed page that has not finished loading returns `loaded: false` only after checking the new document's host and group membership. A missing navigation reply fails at the signed or dispatch deadline; an expired grant, disallowed host, or removed membership still fails. Use separate personal projects, with their own grants, for personal browser goals.

The machine and extension verify a reusable signed grant for the workspace, tab group, approved origins, and expiry. They check current group membership and the tab's current host before access. The account-rooted certificate and transport attempt/replay checks remain in place. Browser tools, MCP callers, and other machines use the same authority path. Use **Workspace machines** to revoke group access or reconcile recovery records. An uncertain effect stays fenced rather than replaying.
Issuance timestamps may be up to two minutes ahead of the local clock; expiry is never extended. Larger differences produce a clock-skew error. An identityless process claim stays uncertain unless its recorded boot ID proves it belongs to an earlier boot.

Browser text is paged and bounded to 32 KiB per result. Screenshots are scaled, JPEG-encoded, and capped at 512 kB, with form fields masked. Larger outputs use scoped, memory-only artifacts capped at 2 MB that expire after ten minutes or a machine restart. Browser observations, images, and evaluation results can enter saved agent history. Redaction reduces exposure but cannot guarantee a page contains no sensitive information.
Shell and codemode access run as the machine user and are trusted as that user; browser controls do not isolate them or restrict what same-user code can access.

Transient supervised processes do not retain logs or recovery records. Detached processes require explicit `persist: true`, retain their records, use file-backed output without a PTY or stdin, and survive supervisor shutdown. Requests combining `detached: true` with `persist: false` fail with `DETACHED_REQUIRES_PERSISTENCE` before starting or replacing a process.

Session history loads only when you open it. The explorer reads up to 200 entries before and after the selected entry along its branch, with a 256 KiB page limit and a fixed traversal budget. Older and newer windows replace the current window; branch choices load separately. Filtering searches only the loaded prompts. Selecting an entry inspects its neighborhood without changing the running agent. **Resume from here** changes the agent's branch. Closing history releases the loaded window; the full conversation remains saved.

Cloud machines are temporary. In **Settings > Machines**, **Stop** saves supported workspace state before stopping the machine. If saving fails, the machine stays online. **Start** runs a fresh machine environment and restores saved workspaces, not the old machine disk.

Workspace checkpoints save the Git branch, commits, staged and unstaged tracked changes, non-ignored untracked files, and GitSpace artifacts, with references to the durable cloud conversation. They do not save installed packages, machine-local configuration, ignored files, or arbitrary files elsewhere on the machine, including its home directory. Ask a normal workspace agent to install tools as needed; those changes are temporary. Code repositories use Artifacts; encrypted `local://` evidence remains a separate store.

Projects created from scratch by GitSpace start with a real initial commit. Imported empty repositories can remain unborn: checkpoints preserve their symbolic branch, staged and unstaged files, and portable untracked files without inventing a HEAD commit. Cloud edits and machine handoffs preserve that state. The first real commit becomes HEAD in the next checkpoint.

Closing a workspace, stopping a cloud machine, and destroying a machine are different operations. Controlled workspace close, Stop, and provider replacement publish durable checkpoints before releasing ownership. After an unexpected interruption, the last completed checkpoint is the recovery limit; uncheckpointed work may be lost. Automatic recovery from unclean disk loss and a returning-machine recovery ZIP are not implemented yet.

## Security

The account root authorizes browser devices. An account-wide delegating browser can approve a separate machine identity. Requests carry device signatures; artifact/checkpoint blobs are encrypted and machine credentials are sealed to machine keys.

The production RPC path is not fully end-to-end encrypted. Treat the account Worker, relay, and machine hosts as part of the documented trust boundary. See [Security boundaries](https://gitspace.sh/docs/security/remote-access).

## Development

The implementation lives in `packages/`. A source checkout is for development, not installation. Root commands build and check the current packages.

Use Bun and Node.js 22 for development checks. Browser and Worker tests use Vitest on Node; machine and runtime-core tests use isolated Bun processes.

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck
```

`bun run dev` starts the self-development environment. Release builds use the pinned toolchain and native platform workflow in `.github/workflows/publish-distribution.yml`.

### Choose the deployment authority

Use the product's deployment entrypoints, not a new upload or activation script.

| Change | Supported path |
|---|---|
| A user's GitSpace account, such as `bradleat.gitspace.sh` | In the GitSpace source workspace's menu, choose **Launch GitSpace from here**. This calls `deployment.launch({ workspaceId, targets })`. `DeploymentLauncher` owns install, build, upload, staging, launch, and project progress events. The release follower and runtime hosts own activation. |
| Platform/operator-managed releases | Use the existing platform/operator deployment workflow for that component. Tenant Worker deploys and reverts use the authenticated `/__platform/operator/tenants/:tenant/deploy` and `/revert` routes. Native distributions and cloud images use their existing GitHub publication and rollout workflows. |

The active account targets are `worker` (the tenant Worker and Pi runtime), `machine` (tool execution), and `frontend`. Historical OMP release fields remain readable but are not launch targets. Shared-contract changes require a compatible set of these targets. The shared operator/control Worker is not the account's `worker` target.

Account deployment progress comes from `DeploymentLauncher` through `deployment.status` and project `deployment` events. The client uses these for its Source indicator and launch progress sheet. Direct calls to builders, blob storage, or desired-release APIs bypass that progress flow.

Do not manually write runtime-selection files or call `/__environment/launch` as an alternate deployment procedure. Those are implementation details of the product's replacement path. If the supported path fails, diagnose that failure and fix the path rather than bypassing it. **Back to stable** uses the account's `deployment.revert` operation.

Native-v1 hosts reject native-v2 machine artifacts before draining. Upgrade the verifying host through authenticated bootstrap/recovery before activating such a release; selecting new source does not make an old host understand its manifest.

For source recovery on a compatible host, use the CLI's product entrypoint:

```bash
gitspace machine recover --source /path/to/held/gitspace-checkout --workspace <workspace-id>
# The same product command from an installed source checkout:
bun packages/cli/src/index.ts machine recover --source . --workspace <workspace-id>
```

Run recovery from a native shell or linked provider console, not a managed terminal that replacement will drain. It uses the source checkout's builders and the ordinary authenticated deployment transaction. It is not permission to edit runtime-selection files, bypass approvals, or replace another tenant. Current native packaging includes the authenticated executable inventory and pinned Git LFS; it does not build WalGit or an OMP installation.

Cloud container images build on GitHub through `.github/workflows/publish-container.yml`. Push a `container-*` tag to build and publish that commit.

- Set the repository variable `CLOUDFLARE_ACCOUNT_ID`.
- Set `CLOUDFLARE_API_TOKEN` with registry write access. For a one-off run, fresh `CLOUDFLARE_REGISTRY_USERNAME` and `CLOUDFLARE_REGISTRY_PASSWORD` secrets also work; these credentials expire.
- The workflow checks packaged Bun and the authenticated machine executable inventory, including Git LFS, before uploading. Its `cloud-container-reference` artifact records the immutable image digest and source commit.
- Publication does not change running machines. Select the digest through the account's cloud-machine image controls. Each machine checkpoints and transfers independently; changing one machine's image does not roll the others.

Bun's module mocks leak between test files in a shared process. Use isolated processes for trusted machine/core results, for example:

```sh
bun scripts/test-isolated.ts packages/account-machine/test packages/core/test
```

Worker packages use their own Vitest/Cloudflare test commands.

Package typechecks include the runtime and account test sources, including the Workerd smoke fixtures and compile-time ID checks. `bun run typecheck:coverage` checks that every source and test file in those packages belongs to a configured typecheck program. The **Runtime safety** CI job runs package typechecks and tests, including `catalog` and `provider-auth`. Catalog regressions compare overrides with the installed Pi catalog; models already present upstream are not copied into local overrides.

Run the retained Pi/workerd regression smoke without provider credentials or a linked machine:

```sh
bun run --cwd packages/runtime-workspace-do smoke
```

It runs Pi/workerd SQLite with a deterministic provider and a private local executor and supervisor. It checks questions, approvals, bounded history, durable model-fallback notices, signed receipt recovery after lost replies and acknowledgements, and large Unicode output after an offline restart. Receipt checks require both acknowledgement and committed history/task materialization before collecting duplicate payloads. Full output remains readable through its history reference. Job checks cover immediate handles, live logs, scoped cancellation, and durable completion delivery to idle or busy conversations. The fixture rejects external network calls.

The normal `runtime-workspace-do` test command runs this smoke. `protocol-runtime` checks wire contracts and branded IDs. `runtime-core` checks actual TTSR discard-and-continue behavior, cold recovery, deferred cancellation, and the distinction between missing evidence and a proven launch fence. `runtime-machine` checks queued cancellation, unknown-effect fencing, runner cleanup, and journaled AST proposals. Multi-file AST apply is recoverable, not atomic.

### Opt-in live Artifacts check

The live check is prepared but has not been run. It is not part of `bun run test`. It checks binding `readFile`, `readTree`, `readCommit`, and `log`, pushes a snapshot on top of an existing one in a disposable fork, and verifies a real LFS upload/download by SHA-256 and byte length. It leaves the source repository and workspace DO unchanged. Missing LFS support is a failure, not a skipped check.

Offline help: `bun run --cwd packages/runtime-workspace-do check:artifacts:live --help`.

After separate owner authorization, the command is `bun run --cwd packages/runtime-workspace-do check:artifacts:live --authorize-live --input /absolute/path/authorization.json`. The input must contain `authorize: "create-disposable-fork-and-upload-lfs"`, the namespace, source repository, a distinct new fork repository name, the full canonical checkpoint, an existing probe path, and its expected SHA-256. Use existing Wrangler authentication or account/API-token environment credentials. The check prints evidence and the retained fork's identity, never tokens; the owner decides when to delete the fork.

Cloudflare's current [binding reference](https://developers.cloudflare.com/artifacts/api/workers-binding/) documents file reads, while its [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) says the binding cannot read files. Binding-read compatibility and LFS payload support remain unverified until this authorized check runs. Local tests verify Git object, pointer, and snapshot behavior without contacting Artifacts.

Two opt-in browser checks use private local Chrome profiles, not your logged-in browser. Set `GITSPACE_BROWSER_PROOF_EXECUTABLE` to a Chrome executable and run:

```sh
GITSPACE_BROWSER_PROOF_ISOLATED=1 bun run --cwd packages/runtime-machine test:browser:headless
```

The generated-extension check requires `CHROME_PATH` to point to a Chrome build that supports loading unpacked extensions:

```sh
GITSPACE_BROWSER_RELAY_INTEGRATION=1 bun run --cwd packages/account-machine test:browser-relay:integration
```

These checks exercise real headless control, profile recovery, masked output, and the installed extension's pairing and target boundaries. They reject unauthorized local clients and a fake relay server. Neither check launches a tenant release or calls a model provider.

Recovery requires authenticated terminal output or matching evidence from a single supervised command. A missing receipt does not authorize another unsafe launch. Rule-triggered continuations and background Job completions retain inference admission; stopping a conversation does not start a replacement generation.

Local runtime checks do not prove a live deployment. Artifacts bindings are remote-only; the Worker test configuration disables remote bindings. Real provider egress, Artifacts repository/LFS/FUSE behavior, native predecessor migration, tenant activation, and sustained-operation checks require their own authorized environment and observed results.

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
