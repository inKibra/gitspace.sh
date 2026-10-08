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

The main Pi composer's text draft is shared by the workspace. It saves after one second of idle time, on blur, and when the page becomes hidden. Other devices receive saved revisions through the workspace watch. Newer unsaved typing stays local until it can be saved; offline edits also stay in browser storage and reconcile on reconnect. An accepted send or **Discard draft** clears the saved text. File attachments are not part of the shared draft.

Moving or restarting a machine does not move the cloud conversation. Default `read`, `edit`, and `write` use the workspace's current Artifacts snapshot, whether or not a machine is attached. Edits publish new working-tree snapshots, preserving HEAD and the index. Staging, branch commits, checkout, and rebase remain deliberate Git commands on a machine. An interrupted unsafe machine effect is not replayed merely because its machine reconnects.

The workspace **Environment** chip opens **Inspector > Environment**, combining setup and machine state. Normal machine attachments are equal caches of the cloud's canonical working tree, with one copy at the standard workspace path on each machine. The default machine is a routing preference, not exclusive ownership. Commands skip machines whose last heartbeat is more than 30 seconds old; an explicitly selected offline machine fails clearly. Runners use a fixed checkpoint; delegates use a separate branch. Their explicit placements do not silently follow a different working copy. Process controls stay on the process's original machine.

Each cache catches up before use. Commands publish their changes on completion; running services and processes publish periodically. Continuous sync lasts through active work and a 15-minute grace period. A human file watcher runs only while a terminal is attached or **Work locally** is enabled, not merely because a browser is viewing the workspace. Idle caches pause, then become eligible for reclaim after 24 hours by default. The workspace cache policy can change that delay. Low disk space can trigger earlier reclaim of an idle cache. Reclaim requires a final acknowledged snapshot and stops for held-back LFS changes or unresolved effects. The next use rebuilds the copy and runs its approved setup again.

Hosted service URLs are private. Opening one redirects to account login and approval, then exchanges a short-lived ticket on that exact hostname for a host-only, HttpOnly, Secure cookie. The same authorization protects HTTP and WebSockets; no parent-domain cookie is issued. Cloud tools use an internal tunnel. Another machine owned by the same account can use a loopback forward over its authenticated device relay. The serving machine checks a signed assertion bound to the tenant, hostname, caller, request, and expiry. `proc` services declared with `ready.port` use the same route and policy.

Services stay on `gssh.dev`. Tenant relays and service hosts currently share one browser site, so `SameSite=Lax` alone does not prevent cross-site use. Every unsafe service request and WebSocket upgrade must carry the exact service Origin; when Origin is absent, `Sec-Fetch-Site` must be `same-origin`. Public `/tunnel/` requests require a signature, not a browser cookie. A `gssh.dev` Public Suffix List entry is planned as a separate change; it is not installed or assumed by these checks.

Device-signed tunnel uploads require `Content-Length` and accept at most 64 MiB. The signed header carries the body SHA-256. The Worker checks the signature, timestamp, and current device authority before reading upload bytes; the relay checks length and digest while streaming. A mismatch cancels the request rather than sending normal EOF. Bytes already forwarded cannot be recalled.

Service sessions expire, follow the approving browser device's authority, and end on `POST /__gitspace/logout`. Revocation and expiry also close open service WebSockets. Application login cookies and Authorization headers pass through; GitSpace strips only its own credentials. Loopback forwards require their per-forward secret, exact loopback Host, and a loopback Origin when one is present. A live service lease cannot be replaced by another machine, and stale generations cannot update or release it.

Account authorization caches the platform's tenant status for 15 seconds. During a platform outage, a known active status remains usable for at most 60 seconds after the last successful check. A failed refresh never extends that deadline. Uninitialized or expired authority fails closed. Existing streams and relay frames use the same checks before disclosing more data; device signatures and revocation remain separate checks.

Model choices retain their default, role, or explicit-model intent. New requests resolve that intent against the current profile and catalog; admitted requests keep their model. If a selected model disappears, the next request records its fallback in the transcript. Catalog reads and admissions refresh published Pi metadata once its four-hour cache expires, using ETags. Bundled Pi models remain the fallback catalog.

Headless browser tools run in cloud Browser Rendering or on an attached machine. Tests, previews, scraping, and tasks that do not need your signed-in accounts use headless, without browser approval in any mode. Both backends reach private workspace services through authenticated internal forwarding. Subagents can use headless only. Machine Chrome uses private inherited pipes, not a localhost debugging port. Its persistent profiles live outside the environment root, under `~/.gitspace-browser-profiles/`, with owner-only directory permissions.

Headless pages do not get ambient access to private services. Only a tool-requested top-level navigation or a request from a verified service document in the same account and workspace may use internal service forwarding. Links, forms, full-page routes, service redirects, and CORS preflights retain that document authority. Same-document navigation, including `pushState`, preserves fetch and XHR access. Browser-supplied navigation headers must match the verified source document; a third-party iframe cannot borrow its parent's authority. Requests from other pages, unknown initiators, and redirects that try to cross this boundary fail closed.

Browser Relay connects your Chrome extensions directly to the account Worker; it needs no attached machine or localhost relay. Pair Chrome profiles through authenticated **Settings > Connections > Browser Relay**. Each extension keeps a non-exportable signing key in IndexedDB; the account stores its public key. Pairing survives machine and browser restarts.
Pairing codes expire after ten minutes. A new key stays pending until you compare its SHA-256 fingerprint in Settings with the extension popup and confirm the match. Pending keys receive no agent work and use a fixed label, not a name supplied by the extension. Pairing, confirmation, project permissions, and forgetting require a user-scoped browser device with `rpc.write`; status and extension download need only `rpc.read`. Forgetting one browser disconnects only that pairing and retires its groups. The extension popup's **Reset identity** deletes its keys and account trust and detaches its sessions; forget the old pairing in Settings before pairing again. Reset does not renew old approvals.
Anonymous extension connections require a live invitation still awaiting a key. Admission limits cover both individual IPv6 /64 or IPv4 /32 networks and broader /48 or /24 networks. Only confirmed keys bypass these anonymous limits.

In **Project Settings**, approve each Chrome for your own use in that project, choose a default, and add names and notes for agents. These personal settings do not live in the shared repository bundle. Approval covers every workspace in that project and applies in every mode, including **yolo**. An agent can discover your approved Chromes and their online status, then use the default or explicitly name another approved Chrome. Offline Chromes remain listed but receive no actions; an offline default does not silently switch to another profile. Revoking a Chrome rejects its grants immediately and closes its project groups, without changing other Chromes or projects. If disconnected, closure retries when the extension reconnects. Reapproval creates fresh authority; old grants stay invalid.

Only the main agent may explicitly request `source: relay`, when it needs your signed-in Chrome session. Each approved Chrome gets a separate coloured tab group for each workspace, named after the workspace. Groups form automatically, without a workspace approval card. The agent can list, open, navigate, act on, evaluate, screenshot, and close tabs only inside that group. Other tabs are invisible to it. Drag an existing tab into the group to share it; drag it out to take it back. There is no tab picker or per-tab lease. Persisted browser actions identify the Chrome that ran them.

Relay host grants live in the committed `.gitspace/bundle.json` under `browser.origins`, for example `["github.com", "*.cloudflare.com"]`. Entries name hosts or host patterns, never paths; `"*"` grants all HTTP(S) hosts. Each entry has its own content hash and approval in **Environment**, using the existing lifecycle-control authority and project or workspace scope. Whole-account API/MCP keys with Write and `lifecycle.control` may approve browser origins; this authority is intentional.

A project approval on base applies only where the workspace's committed bundle lists that origin. Branches created before base added it inherit the grant once they merge or rebase base and include the entry. A branch-only entry needs workspace approval until merged and approved on base. Removing an entry drops its workspace approval; removing it on base also drops its project approval. Re-adding the entry does not restore those approvals.

Revoking a group fences its old grants; the next request creates a new group if that Chrome still has project approval. Navigation and actions within approved hosts need no further prompts; JavaScript and screenshots are included. Origin grants remain shared across approved Chromes and require lifecycle-control approval, including in yolo. When a host is missing, the agent proposes an environment-file edit instead of widening its own access. Relay redirects and a page's own network requests are not intercepted. Navigation waits for Chrome's reply before starting a load wait of up to ten seconds, or less when the dispatch expires sooner. A committed page that has not finished loading returns `loaded: false` only after checking the new document's host and group membership. A missing navigation reply fails at the signed or dispatch deadline; an expired grant, disallowed host, or removed membership still fails. Use separate personal projects, with their own grants, for personal browser goals.

The runtime and extension verify a reusable signed grant for the workspace, tab group, approved origins, and expiry. They check current group membership and the tab's current host before access. The account-rooted certificate and transport attempt/replay checks remain in place. Browser tools, MCP callers, and other machines use the same authority path. Use **Inspector > Environment** to manage account browser groups and recovery records; these groups do not represent machine attachments. An uncertain effect stays fenced rather than replaying.
Issuance timestamps may be up to two minutes ahead of the local clock; expiry is never extended. Larger differences produce a clock-skew error. An identityless process claim stays uncertain unless its recorded boot ID proves it belongs to an earlier boot.

Browser text is paged and bounded to 32 KiB per result. Screenshots are scaled, JPEG-encoded, and capped at 512 kB, with form fields masked. Larger outputs use scoped, memory-only artifacts capped at 2 MB that expire after ten minutes or when their runtime owner restarts. Browser observations, images, and evaluation results can enter saved agent history. Redaction reduces exposure but cannot guarantee a page contains no sensitive information.
Shell commands run as the machine user; browser controls do not isolate them from that user's files or accounts. Codemode runs in a cloud Worker isolate with no direct network access, no raw sockets, no injected environment bindings, and no Node compatibility. Nested tool calls follow normal routing, approval, hooks, and grants. Capability calls and durable child calls have separate budgets, including MCP fan-out. A script may catch a definitive child failure and finish; an unknown durable outcome remains fenced against replay. Codemode is unavailable to subagents.

Transient supervised processes do not retain logs or recovery records. Detached processes require explicit `persist: true`, retain their records, use file-backed output without a PTY or stdin, and survive supervisor shutdown. Requests combining `detached: true` with `persist: false` fail with `DETACHED_REQUIRES_PERSISTENCE` before starting or replacing a process.

Session history loads only when you open it. The explorer reads up to 200 entries before and after the selected entry along its branch, with a 256 KiB page limit and a fixed traversal budget. Older and newer windows replace the current window; branch choices load separately. Filtering searches only the loaded prompts. Selecting an entry inspects its neighborhood without changing the running agent. **Resume from here** changes the agent's branch. Closing history releases the loaded window; the full conversation remains saved.

Cloud machines are temporary. In **Settings > Machines**, **Stop** saves supported workspace state before stopping the machine. If saving fails, the machine stays online. **Start** runs a fresh machine environment and restores saved workspaces, not the old machine disk.

Workspace checkpoints save the Git branch, commits, staged and unstaged tracked changes, non-ignored untracked files, and GitSpace artifacts, with references to the durable cloud conversation. Uncommitted LFS changes are an exception: they stay on the machine until committed, even during a move or detach. Checkpoints do not save installed packages, machine-local configuration, ignored files, or arbitrary files elsewhere on the machine, including its home directory. Ask a normal workspace agent to install tools as needed; those changes are temporary. Code repositories use Artifacts; encrypted `local://` evidence remains a separate store.

Projects created from scratch by GitSpace start with a real initial commit. Imported empty repositories can remain unborn: checkpoints preserve their symbolic branch, staged and unstaged files, and portable untracked files without inventing a HEAD commit. Cloud edits and machine handoffs preserve that state. The first real commit becomes HEAD in the next checkpoint.

Artifacts stores LFS pointers but has no LFS endpoint. Snapshots upload newly committed local LFS objects to encrypted account R2 storage, once per oid. They never push to origin. Each repository keeps its normal LFS remote, including `lfs.url` in `.lfsconfig`; a deliberate `git push` uses git-lfs's normal pre-push hook.

HEAD's `.gitattributes` controls checkpoint LFS tracking. Editing attributes in the working copy does not change it. Staged or unstaged LFS content whose object is not already off the machine stays behind: the snapshot keeps the committed pointer, or omits a new path. Deletes and renames of already-committed LFS files carry over. Capture never changes the real index or working tree.

Inspector's working comparison marks these paths **Only on this machine** and explains **LFS changes leave this machine only after a commit**. The saved checkpoint supplies the list, including while the machine is offline. Move and detach confirmation offers **Commit first** or **Continue without them**. After a move, the agent receives the list of files restored to committed versions or omitted.

Restore looks for LFS content in the local cache, then R2, then the confirmed origin endpoint. Downloads stream into a temporary file beside the cache. Restore stops on excess bytes and requires the exact size and SHA-256 before an atomic rename; failures and aborts remove the temporary file. R2 transfers process fixed 32 MiB encryption chunks rather than buffering a complete multi-chunk object. Missing objects fail explicitly. Cloud file reads have an 8 MiB limit and can return verified R2 content within that limit; larger or origin-only files require a machine. Cloud edits and writes to LFS-tracked paths require a machine and a commit.

R2 retention is project-scoped. In-use snapshots include the current checkpoint and portable revision of a nonarchived workspace (including a closed workspace), active attachment checkpoints, and pending publication predecessors. Historical rows alone are not restore roots. Publication pins do not expire on a timer. Archiving or deleting a workspace releases its snapshot owners, not live attachment or publication pins.

With an external origin, R2 eviction requires a successful authenticated LFS batch `download` confirmation for the exact oid and size. Snapshot metadata records the confirmed endpoint before deletion; stale remote-tracking refs are not evidence. Without an external origin, objects reachable through any branch or tag in the canonical project and workspace Artifacts repositories remain protected. Collection fails closed when it cannot inspect those roots. Deletion fences new publications until it finishes.

Committed pointer inventories are cached on disk by HEAD. Unchanged captures reuse the inventory; forward history scans stop at the saved ancestor. Capture checks newly discovered objects against origin and remembers negative results. Later-push checks run in bounded maintenance batches, not on each snapshot. A rewritten history requires one rescan.

Origin receipts and snapshot endpoint metadata contain no URL userinfo, query, or fragment. Restore gets endpoint credentials from matching machine Git configuration or credential helpers. Accepted runtime and portable snapshots persist the real uploader's publication identity; their retention outbox releases that pin after retention succeeds, even if the machine never receives the response.

Closing a workspace, stopping a cloud machine, and destroying a machine are different operations. Controlled workspace close, Stop, and provider replacement publish durable checkpoints before releasing ownership. After an unexpected interruption, the last completed checkpoint is the recovery limit; uncheckpointed work may be lost. Automatic recovery from unclean disk loss and a returning-machine recovery ZIP are not implemented yet.

## Security

The account root authorizes browser devices. An account-wide delegating browser can approve a separate machine identity. Requests carry device signatures; artifact/checkpoint blobs are encrypted and machine credentials are sealed to machine keys.

The production RPC path is not fully end-to-end encrypted. Treat the account Worker, relay, and machine hosts as part of the documented trust boundary. See [Security boundaries](https://gitspace.sh/docs/security/remote-access).

## Development

The implementation lives in `packages/`. A source checkout is for development, not installation. Root commands build and check the current packages.

Use Bun and Node.js 22 for development checks. Browser and Worker tests use Vitest on Node; machine and runtime-core tests use isolated Bun processes.

Default `grep` searches a ready machine cache only when its observed checkout matches the current snapshot. It runs the pinned ripgrep 14.1.1 against immutable Git content, not uncommitted cache files. Otherwise it uses an incremental cloud index of that snapshot, with the same Rust regex and path-filter semantics. Index updates read changed blobs, and query candidates are checked against cached content. Source runs and search integration tests download and verify the same pinned binary; no system ripgrep installation or `PATH` entry is needed.

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

Machine execution uses a separate protocol negotiation at enrollment and connection. An older machine can still create or open workspaces, build, and launch releases. The account selects its pinned native release for that machine's platform; the existing verified host updater applies it. Older clients can identify their platform through a published runtime generation. Unrecognized generations or missing native artifacts show a concrete update blocker rather than guessing a platform. Only new agent effects wait for a compatible machine; receipt and recovery operations remain available.

Inference activation still waits until the platform's active Worker version matches the running Worker. This keeps the irreversible credential migration behind deployment health checks and automatic rollback. The Inference page and workspace composer show **Verifying the new release…** with **Check again** while that check is pending. The composer cannot send until its inference profile is available.

Platform maintainers assemble new-account defaults with `packages/deployment/src/default-release-cli.ts`. One manifest pins the Worker bundle and metadata, account UI, cloud image digest, and four native platform artifacts to the same commit. The script requires a clean checkout and published native outputs from the existing distribution workflow. It checks the bundle's embedded Worker version, hashes, and provenance before atomically replacing the default pointer; rollback restores the previous complete set. Build and publication run together with `build --publish`; saved-directory `publish --from` is not supported. This does not replace account **Launch**.

Tenant pins contain the release commit and manifest SHA-256. Existing tenants without a pin use the current verified default for native updates and default-image cloud machines; their next deploy records that pin. Pinned accounts keep their selected UI and image when the default changes. Invalid pins or changed manifest bytes fail closed rather than selecting another release. Native generation lookups use the published index first; historical lookup results, including misses, are cached per tenant and generation for 60 seconds, with at most 256 entries per Worker isolate.

Run the default-release flow with local fakes, without publishing:

```sh
bun packages/deployment/src/default-release-cli.ts --fake
```

Use `--help` for build, native-input, `--publish`, and rollback options. A real build pushes its cloud image; publication and rollback require separate platform authorization.

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

The owner ran this check in the `gitspace-live-check` scratch namespace in the InKibra Corp account. Binding `readCommit`, `readTree`, `readFile`, `readBlob`, and `info` worked. Snapshot publication preserved the source HEAD, index, and branch, used the expected parent, and exposed the new ref through Git `ls-remote`. Artifacts' LFS batch endpoint returned 404; Artifacts has no LFS payload store.

Run this check under **Node 24**, not Bun. Wrangler's remote bindings proxy hangs under Bun. Offline help from the repository root: `node packages/runtime-workspace-do/live-check/entry.mjs --help`.

After separate owner authorization, run `node packages/runtime-workspace-do/live-check/entry.mjs --authorize-live --input /absolute/path/authorization.json`. The input must contain `authorize: "create-disposable-fork-and-push-snapshot"`, the namespace, source repository, a distinct new fork repository name, the full canonical checkpoint, an existing probe path, and its expected SHA-256. Use existing Wrangler authentication or account/API-token environment credentials. Repository handles use explicit disposal compatible with the proxy and workerd. The check leaves the source repository and workspace DO unchanged, prints evidence and scrubbed failure reasons without tokens or credential-bearing URLs, and retains the disposable fork for owner-directed cleanup.

The binding resolves bare branch names and commit IDs in `repo.log({ ref })`. Use `repo.log()` without a ref for HEAD. Literal `HEAD`, `refs/heads/main`, `heads/main`, and custom checkpoint refs return empty results even when Git can see those refs. Production branch lookup translates full branch refs; snapshot reads use commit IDs stored by the DO. The live check verifies checkpoint refs through Git rather than binding lookup and does not exercise the separate R2 LFS store.

The owner reran the unmodified check under Node 24 for Pass 10 using fork `probe-fork-20261005035600-c`. Direct `ArtifactsCodeStore` checks passed for full and bare branch names, HEAD, feature branches, commit IDs, missing branches, and `readFile`. They rejected custom checkpoint refs and returned no initial checkpoint for a populated repository whose requested branch was missing. Pass 11 adds the same no-ref history guard when reusing a matching-description scratch repository; it does not seed a missing branch in a populated repository.

For Pass 12, the owner reports that the real-service lookup checks and live check still pass with fork `probe-fork-20261005035600-d`. This is owner-provided evidence; the local review fixes do not rerun or extend that live check.

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

Local runtime checks do not prove a live deployment. Artifacts bindings are remote-only; the Worker test configuration disables remote bindings. The owner's binding-read and snapshot-publication findings above are live evidence, not evidence of tenant activation or the new R2 LFS path. Real provider egress, R2 LFS operation, FUSE behavior, native predecessor migration, tenant activation, and sustained-operation checks need their own authorized environment and observed results.

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
