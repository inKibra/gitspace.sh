# FLEET.md — GitSpace 1.0 architecture

Status: DRAFT for approval. Originally captured 2026-08-10; rewritten
2026-08-27 after the OMP 18 migration, cross-machine session move, skinny-event
work, and Cloudflare platform design. This is the anchor document: change the
decision here before filing or implementing work that depends on it.

---

## 1. Thesis

**Don't hide machines. Name them, and make crossing between them cheap.**

Seven primitives:

1. **Possession** — one writer per thing (workspace tree, goal folder, session,
   deployment environment). Movement is explicit, never ambient.
2. **Git** — code, declarations, goals, reviews, specs, and release refs live
   in repositories the user owns.
3. **Encrypted blobs** — artifacts, session mirrors, reports, and large payloads
   are client-sealed before R2. Cloud storage owns bytes, never plaintext.
4. **Transactional state** — one local SQLite database per machine; one
   coordination database per cloud atom (RelayDO SQLite, platform control DB).
   Mutable application state does not sprawl across JSON files.
5. **Signals** — the relay routes live ciphertext, tunnel streams, enrollment,
   and coordination events. It is a stateful rendezvous, not a data authority.
6. **Names** — work lands on an explicit machine, environment, process,
   deployment, and user-owned relay.
7. **Facts → agent; promotion → user** — the system measures and presents
   facts. Agents may replace isolated development environments. A user signs
   promotion into the environment they currently depend on.

GitSpace 1.0 is the first stable architecture; 0.x is the prototype. Clean
cutovers are the default. Compatibility exists only where a current,
evidence-backed consumer requires it.

## 2. Rejected alternatives (do not relitigate without new evidence)

| Rejected | Why |
|---|---|
| Network filesystem mounts for code | Metadata-storm syscall tax; owner death bricks consumers; watchers and SQLite semantics do not cross safely |
| Ambient multi-master state sync | Conflict soup; possession plus namespaced replication gives durability without merges |
| Migrating a mid-turn process | Kernel/model/tool state is not serializable; drain at a boundary, persist, reopen |
| Per-command remote execution product | Whole-environment placement + declared checks covers the need without a second shell product |
| A meta-project type for self-development | GitSpace is a normal project with normal package scripts |
| Separate development and production replacement engines | Dev would prove the wrong mechanism; both must share artifacts, drains, health, migrations, and rollback |
| A platform-owned fixed relay | Users must be able to modify their protocol, tunnel behavior, Worker, and RelayDO |
| WfP-only or standalone-only relay code | One portable relay artifact supports both deployment envelopes |
| A full product CLI | Humans use web; agents use code mode. Keep only bootstrap, setup, recovery, diagnostics, and headless hosting |
| SDK-to-CLI fallbacks and deprecation shims | They preserve dead parsing/formatting surfaces and hide incomplete cutovers |
| One global Durable Object | Wrong coordination atom and cross-tenant bottleneck |
| Shared raw cloud bindings separated by key prefixes | Prefixes organize data; they do not isolate malicious user code |
| Hiding relay/security code | Account owners can inspect deployed code; security must come from crypto and capability isolation |
| Treating compatibility as a product value by itself | Preserve identities/data only when the current user journey needs them; otherwise rebuild, rescan, or cut over |

## 3. Audited 0.x facts (replacement inputs, not 1.0 promises)

- One Bun daemon (`src/lib/tmux-lite/server.ts`) owns PTYs (in-process
  `Bun.Terminal` fds), agent workers (anonymous IPC + ppid watchdog kill),
  and `proc:` service sessions. Everything dies with it. (#126's premise.)
- **Worker** = `agent-worker.ts`, OUR code, hosting the OMP SDK in-process
  (`LocalSessionHost`, cwd = workspacePath, agentDir = `<root>/.pi`).
- **OMP hub has two halves**: the process broker (project-scoped Unix socket,
  crosses workers) and messaging/jobs (`IrcBus`/`AgentRegistry` per-process
  singletons — do NOT cross workers). One-worker-per-agent means no
  agent↔agent hub chat today.
- **OMP broker** (`launch/broker.ts`): PTY/pipe/detached modes, readiness
  (log regex + port poll, sticky readyAt), restart w/ backoff (generation-
  guarded), log rotation + cursors + PTY re-render, killTree signals, atomic
  meta persist, `#recoverRecords` re-adopts live detached daemons across
  broker restarts, idle self-shutdown, broker lease. It already implements
  the #126 ownership-inversion pattern at process scope.
- **Dead code**: `startProcessScheduler` / `autostartProcesses` have no
  production callers → `restart.policy` in processes.json never fires.
- **local://** binds to `artifactsScope(cwd).rootDir` — the artifacts mount
  (`<workspace>/.gitspace/artifacts`), goal subfolder when a goal exists.
  The `.sessions/<sid>` machinery (exclude, walk-skip, classify-guard, GC)
  exists but nothing binds to it. Header comment in `makeLocalProtocolOptions`
  is stale (says `.sessions`), contradicts its own body.
- **Script phases**: `pre` is formally deprecated in code (warning at
  `run-workspace-scripts.ts:223`). `select` is fingerprinted like setup
  (manifest + setupFingerprint + setupStatus) — NOT attach-scoped; its only
  real value is "re-run the cheap tail," better expressed by effect targets.
- **OMP task isolation** (`task/isolation-runner.ts`, `pi-natives` iso PAL):
  CoW worktree per subagent, dirty-tree baseline (untracked via
  `/dev/null` no-index diffs), delta capture, check-then-apply patch merge
  (never leaves conflict markers; refusal → `.patch` artifact), nested-repo
  stash discipline. `task.isolation.mode` defaults to `none`.
- **OMP pause gate** (`pi-agent-core` pause): every agent loop polls it
  before each model call and each tool call — freeze at a safe boundary in
  seconds. `pi-busy.integration.test.ts` already covers kill-server-mid-busy
  → reopen → resume.
- **Artifacts invariants**: `goals/<id>/**` has exactly one writer
  (`assertGoalScopeWrite`); canon write-through mirrors goal.md/rubric.json
  to the artifacts branch; goal records/chains are machine-local JSON;
  planned goals have no workspaceName (goal = unmaterialized workspace).
- GitHub App exists (verify `checks:write`, `deployments:write`; private key
  custody with gitspace.sh → delegate mints installation tokens via API).
- Embedded OMP packages are 18.0.6 (`f061638`); native `askDialog` replaced
  one patch, while queue removal, role-only models, flat `local://`, and
  missing-image fallback remain explicit patches.
- Skinny-event cut `b972282` replaces recurring whole-fleet agent snapshots
  with workspace snapshots and growing text blocks with append deltas.
- Session `019fed50` moved Mac→WSL by copying JSONL/blobs/memory and preserving
  `/Users/bradleat` via symlink. It proves boundary resume and exposes the
  missing first-class manifest/path/final-sync machinery.

## 4. Sandbox (#135 filed; #116 is its research arm)

- OS-enforced sandbox at the `WorkerSessionHost.boot` seam — the single
  chokepoint; the worker and every descendant inherit it.
- Policy portable; enforcement compiled per-OS at boot (Seatbelt on macOS,
  Landlock/bwrap on Linux). Recompiled on arrival after any move.
- Writable set: workspace tree, artifacts mount, session temp, narrow OMP
  session dir. Deny: other workspaces, `~/gitspace/.identity`, `.relay/`,
  `~/.ssh`, `.git/config|hooks`, capability-granting config.
- Denied ops surface the constraint in the tool result (Cursor lesson:
  agents retry blindly unless the failure names the boundary).
- OMP task isolation = CHANGE isolation; the OS sandbox = PROCESS isolation.
  Complementary, both wanted. Enable `task.isolation.mode: apfs` (zero-code
  win for subagent write isolation).
- **Container lane**: Docker VMM (Desktop ≥4.86) makes containers the check/
  service substrate on macOS; same container definitions run native on Linux
  engine-room boxes. Abstraction = "any Docker engine endpoint" (OrbStack/
  Colima substitutable). The agent body is NEVER containerized — mac-native
  capabilities live with it. Watch: Docker Sandboxes (SBX) "agent support
  coming next" — buy-vs-build check before investing in exec-in-container.
- CPU quotas: cgroups where the heavy work runs (Linux boxes / containers).
  Never contort macOS.

## 5. Processes & services

- Adopt the OMP broker under `space.processes.*`: broker owns spawn, PTY,
  readiness, restart, logs, persistence, and re-adoption. GitSpace owns
  workspace names, port/hostname allocation, environment interpolation,
  correlated events, policy, and panels.
- **One owner rule** — broker replaces tmux-lite `proc:` and the dead
  watchdog/autostart path; never run two supervisors for one process.
- Namespace broker processes by workspace identity, not whichever agent first
  launched them. Agents in a workspace intentionally share named processes.
- Raw interactive input latency is the gate for moving terminal PTYs to the
  broker. Once broker-held, terminals survive daemon replacement.
- Repository development remains repository-owned: `bun run dev`, `bun run
  test`, and project-specific package scripts. GitSpace does not invent
  `space.dev`.

## 6. Agent topology

- **One writer agent per workspace** (mirrors one-writer-per-goal artifacts
  invariant), one project agent (local:// = tree root, `goals/**` denied).
- **Side agents**: read tier only (deny bash/eval/task/write/edit), local://
  bound to `<mount>/.sessions/<sid>` (guards/GC already exist; only the
  binding is missing). Promotion of side output is the main agent's act.
- **Crons/triggers**: the daemon-side scheduler routes to the project agent
  or the workspace's agent by declared scope. Never agent→agent (IrcBus
  doesn't cross workers). Depends on #125 session policy work.
- Singleton = resolution policy ("get or create the workspace's agent"),
  not a hard cap — #125's `named`/`reuse-by-trigger`/`target-existing`.

## 7. Lifecycle v2 (effect targets)

Replace pre/setup/select/remove with per-target lifecycles; the path IS the
declaration:

```
.gitspace/lifecycle/
  cloud/provision       once per WORKSPACE IDENTITY; fingerprint stored in
                        local DB + encrypted portable manifest — NEVER re-runs
                        on move; probe ("resource exists?") repairs lost cache
  cloud/destroy         at RETIRE only. The only real teardown.
  machine/prepare       once per machine; success registers a capability
  workspace/materialize every arrival — first setup and move-in are the
                        same thing; idempotency is a contract
  workspace/dematerialize  drain: stop services, flush, release leases
```

- **evict ≠ retire**: evict = this machine stops holding it (cloud untouched);
  retire = explicit verb, destroys cloud, releases bindings. Inferring
  destruction from absence is prohibited. Careless local delete = evict
  semantics; the dev stack survives.
- `cloud/*` steps need credentials + repo ref, not the worktree. They run where
  identity lives even if the workspace machine is dead.
- **Bindings**: provision stores non-secret resource IDs/URLs in local SQLite
  and a client-sealed portable manifest in R2. Secrets are delegated by name.
  `.env` is derived at materialize from bindings + scoped secrets; never synced
  or committed. External infrastructure tools use remote state keyed by
  workspace identity.
- Migration mapping (conservative): `pre/`→materialize (already deprecated),
  `setup/`→materialize (cloud bits hand-lifted to provision),
  `select/`→materialize (ordered after), `remove/`→**cloud/destroy ONLY**
  (mapping remove→dematerialize would run deletions on every move).
- Effect-scoped fingerprints are load-bearing: worktree = per (machine,
  workspace); machine = per machine; cloud = per workspace identity in SQLite
  + encrypted manifest.


## 8. State, declarations, bundle, and identity

- Mutable local GitSpace state converges into `~/gitspace/gitspace.db`:
  projects, workspaces, machine metadata, settings, deployments, endpoint
  trust, events, outbox, process/service metadata, shares, and cloud resource
  references. WAL + ordinary schema migrations; rebuilding by scanning git
  roots and the cloud endpoint is a first-class recovery path.
- Secrets never enter SQLite: user/device private keys, provider refresh
  tokens, Cloudflare credentials, and delegated integration credentials remain
  in the OS keychain or provider-owned credential store.
- Large bytes never enter SQLite: git owns source/history; local blob files or
  encrypted R2 own artifacts, sessions, reports, and bundles. SQLite stores
  manifests, hashes, offsets, and ownership.
- Versioned repository declarations remain files because agents and humans must
  edit/review them through git: lifecycle code, bundle requirements, workflow
  specs, goals, checks, and project package scripts. These are source, not
  application state.
- Bundle requirements declare capabilities, platforms, secrets by name, checks,
  and lifecycle entrypoints. No secret values. Preflight resolves every
  capability before work starts and routes human action to the live seat.
- OMP auth broker is the provider-login authority: refresh credentials stay
  with the broker; machines/workers receive scoped, short-lived access.
- Root identity anchors machine enrollment, signed cloud deployments, promotion
  approvals, encrypted blob recipients, and user-owned subdomain reservations.

## 9. Checks, CI, placement

- **Placement is per workspace-mission and phase, not per command.**
  Residency = f(mission, phase); **phase gates are both the validation
  points and the relocation points** — one boundary, two meanings.
  Least-capable-fit (scarcity weight = 1/machines-with-cap) is only the
  tiebreak within eligible machines.
- **Checks**: daemon-as-runner, warm per-host caches, dispatch over relay
  (we originate push events — no webhooks), verdict store with measured
  timings per (check, host). **Pull, not push**: verdicts NEVER enter agent
  context uninvited; agents ask at gates. Forcing green on intermediate
  states is Goodhart — it's why agents write transient appeasement code.
- **GHA as frontend**: parse `.github/workflows` into check units
  (runs-on → labels) rather than maintaining a parallel checks.json for
  repos that have CI. Report via existing GitHub App: Statuses v0 →
  Check runs with annotations v1. Required-status contexts let our fleet
  gate merges. Provenance: machine Ed25519 signature, snapshot sha, log
  artifact link. Fidelity tiers: run:-steps native; complex marketplace
  actions → container shims or punt; OIDC actions blocked until delegate
  OIDC issuer. Deploys run locally EXCEPT: environment protection maps to
  GitSpace gates/seat approvals; concurrency = env lease (possession, 4th
  appearance); Deployments API records keep GitHub as scoreboard. Hosted
  GH demotes to nightly hermetic calibrator.
- Blacksmith-style per-invocation offload and Nx-style wrappers were
  studied: the durable ideas are content-addressed check caching (needs
  declared inputs; stale-hit is the worst failure — earn it per check) and
  intent-vs-facts split (agent supplies intent, scheduler placement).

## 10. Replication, moves, and the drain doctrine

- **Code replication** = git refs. Each machine writes only its own WIP
  namespace (`refs/gitspace/<machine>/<workspace>/wip`); tracked releases use
  user-owned refs and read-only machine deploy keys.
- **Blob replication** = encrypted R2. Artifact packfiles, session JSONL
  segments, and manifests are sealed on the machine. R2 sees ciphertext,
  hashes, size, and timing; never keys or plaintext.
- **Move** = drain at a safe boundary → publish git/blob state → materialize on
  target → reopen. The successful Mac→WSL move of session `019fed50` proves the
  current manual shape; 1.0 makes path translation, manifests, and final sync
  explicit.
- **Upgrade-in-place is the same replacement engine**, target = same
  environment, next generation. A component survives only when its interface
  is external/stable enough to cross the generation boundary.
- Survive: stable bootloader/promoter, OMP broker processes/PTYs, encrypted
  blobs, immutable artifact manifests, and externally owned services.
- Drain and replace: our daemon, agent worker, offload worker, web generation,
  relay Worker, RelayDO code, platform Worker, and schemas they own.
- Every entrypoint has one policy: build, dependencies, drain, replace, health,
  rollback. Import-graph hashes choose the affected set; there is no curated
  “files that need restart” map.
- Compatibility is not assumed. Multi-machine promotion either drains and
  updates the participating fleet as one approved plan or marks offline
  machines as requiring bootloader-assisted convergence when they return.

## 11. Self-development (GitSpace on GitSpace)

- GitSpace is a normal project in the same monorepo, with normal workspaces,
  goals, reviews, artifacts, and package scripts. No meta-project type.
- Installed stable `gssh` creates/opens isolated environment B. Inside B, an
  agent develops exactly as in another repository: `bun run dev`, `bun run
  test`, and other package-level commands owned by this repo.
- `bun run dev` is only a watcher/trigger for the shared deployment engine. It
  hashes entrypoints, builds content-addressed artifacts, drains affected B
  components, replaces them, verifies health, rolls back failure, and keeps
  watching. Edits arriving mid-deployment coalesce into the next generation.
- B has isolated SQLite, sockets/ports, OMP profile, broker namespace, relay
  deployment, and R2 resources. It exercises real daemon/worker/web/RelayDO
  replacement rather than shortcuts.
- Promotion uses the exact artifacts proven in B; it never rebuilds source.
  Environment configuration is injected at activation.
- The agent may prepare a promotion: immutable artifact hashes, affected
  entrypoints, drain/migration/reconnect impact, evidence, and rollback plan.
  Only the user can sign promotion into A. Approval is invalidated by any plan,
  target-generation, migration, or artifact change.
- A stable executor outside replaceable generations runs approved promotion.
  Automatic rollback is covered by the approval; destructive/forward-only
  database or DO migrations must say plainly that rollback is unavailable.

## 12. Routing & client (#126-B rider)

- `backendKey` in the hash route is a HINT, not identity (comment posted on
  #126): resolve workspace → current residency at rehydrate; redirect on
  mismatch; layout keyed primarily by workspaceId; tombstone only when
  unresolvable.
- OMP /collab (#130): host-authoritative E2E session mirror; worker-as-host
  + detached workers would make transcripts survive daemon restarts for
  free; open question is our relay speaking the pi-wire envelope. NOTE:
  under §10's stability rule, collab-in-OUR-worker is version-safe only via
  the same drain/recycle path — guests reconnect after a flip.

## 13. UX adoptions (from gooey-pi review; MIT)

Final cut after scrutiny (kanban IS the fleet view; amber/idle chips already
cover attention):

- highlight terminal output → attach to next prompt
- browser annotations → prompt attachments (browser lane)
- reference designs: preview-tab adoption by agent + glide cursor (Electron-
  dependent parts noted); schedules UX (pause/resume/run-now/history) → #127
- queue-vs-steer explicit shortcuts (plumbing exists: streamingBehavior)
- settings: Inherit tri-state affordance; integration status cards
- **FTUE + settings pages**: every subsystem exposes one probe-backed card
  (identity, Cloudflare deployment, relay reachability, machine enrollment,
  provider auth, projects, artifacts, integrations). FTUE is those cards in
  dependency order; settings is the same cards grouped by subsystem.
- Two legs remain: stable `gssh setup` establishes root identity, local DB, and
  enough runtime to open web; web completes Cloudflare target choice
  (standalone or hosted WfP), relay deployment, first project, integrations,
  and machine enrollment.
- Cloud cards show exact ownership/cost/trust facts: deployment target,
  account/platform owner, relay artifact hash, RelayDO migration, R2 encryption
  state, credit/risk reserve for hosted users, last usage reconciliation, and
  whether development tunnel traffic is plaintext-at-Cloudflare or E2E.
- Enrollment is a two-machine ceremony: owner settings mints a root-signed
  invite; new-machine FTUE redeems it. The Machines page is the seed of the
  fleet registry and later placement/capability view.
- design-language pass on the web app (compounds across every shell)
- **Runtime dropdown** in the agent session pane header (AgentPaneHeader) —
  not a dedicated pane. Kanban stays the WORK view; this dropdown is the
  machine's process table, agent-aware, one click from any agent pane.
  Current session's row pinned/highlighted at top; everything live on the
  backend below it.
  - agents: workspace, session title, model (as ROLE per #113, id
    secondary), thinking level, state (busy/idle/waiting), context %,
    viewer count, worker pid — and after a Promote, a "previous build,
    recycles at idle" badge (drain doctrine §10 made visible)
  - hub broker daemons per workspace: name, state, pid, uptime, restarts,
    persist/detached, ports
  - data sources already exist: PiCoordinator hosts/leases +
    getControlInfo (model/thinking/contextUsage), broker `list` op,
    machine snapshot broadcast. Gap: per-worker subagent/job registries
    are worker-internal (IrcBus/jobs are process-local) — needs a small
    worker snapshot sink; precedent: OMP's own agent-hub TUI component
    and collab's agent-registry snapshot mirroring.
  - grows into the fleet registry view (B3): same table, one column per
    machine.
- Seat apps (parked, shell choice DELIBERATELY OPEN — Electron vs Tauri
  desktop; Expo/RN vs Tauri-mobile). Facts both ways, recorded so the
  eventual decision doesn't re-derive them:
  - the `.tsx` + `.web.tsx` split is the RN-style architecture (shared
    hooks, per-surface renders) — favors Expo/RN mobile over one-webview
    Tauri sharing
  - Electron-only multi-`<webview>` matters iff the embedded agent-browser
    pane matters (gooey's best feature); bundled Chromium removes the
    ghostty-web/WKWebView risk — that spike is required only on the Tauri
    path
  - Tauri: smaller footprint, Rust core competency cost, mobile still young
  - mobile is a viewer seat either way (few screens; push approvals =
    killer feature)
  Deferral is FREE as long as the invariant holds: capabilities live on
  machines, never in shells. The moment product logic lands in a shell,
  the choice is being made implicitly — don't.

## 14. Extensions, specs, and self-modification

- **Tier 0 — data conventions**: block schemas, artifact kinds, workflow/goal
  formats, and local-backed mini-app descriptors.
- **Mini-app reset**: a mini-app is a `local://apps/<app-id>/` artifact tree
  (source, assets, manifest, durable app data) plus a named OMP broker process.
  The process owns build/dev-server lifetime, logs, readiness, ports, restart,
  and re-adoption; GitSpace supplies workspace capability policy, hostname/
  development-tunnel routing, and a transcript block that references the app
  id/process/route. Do not inline an entire `.gssh.html` program into transcript
  state. Promotion/share captures an immutable artifact version; the live app
  remains an ordinary workspace process.
- **Tier 1 — OMP extensions + GitSpace renderers**: agent tools and display
  behavior on OMP-owned extension surfaces.
- **Tier 2 — replacement-unit packages**: in-tree `protocol`, `relay`,
  `deployment`, `machine`, and platform packages. Their interfaces may churn
  until 1.0; no speculative plugin API freezes them.
- **Specs** remain the distribution mechanism for features: intent + substrate
  contract + teaching + agent-runnable rubric + reference implementation. An
  agent implements a spec into the user’s fork, validates it in B, and the user
  promotes it.
- Self-modification is primary. Extensions organize capabilities and on/off
  boundaries; they do not replace the user-owned fork.
- The user relay is itself a self-modifiable extension boundary: the user owns
  Worker source, RelayDO source/migrations, tunnel protocol, and private cloud
  routes. The platform owns only admission, tenant routing, binding allocation,
  limits, billing, and suspension.
- In-tree features double as reference implementations of their specs.
  Divergence is expected; upstream adoption is a separate user choice.

## 15. Workspace email

- Hosted addresses are human-readable:
  `<project>.<workspace>@<user>.gssh.dev` (normalized like workspace names).
  Owning the platform zone makes routing and tenant attribution deterministic.
- CF Email Routing → platform Email Worker → DKIM/SPF alignment → allowlist →
  seal to user root key → encrypted MIME in R2 → envelope fact through the
  user relay. Email is another inbox/tunnel channel.
- `.gitspace/email.jsonc` remains a versioned declaration with exact senders
  and `@domain` entries. Empty/missing = receive nothing. Effective policy is
  synced only from the project default branch so a workspace agent cannot
  widen its own ingress without review.
- Email is inert untrusted data, never auto-injected into an agent turn.
- Cloudflare sees plaintext at MX ingestion before sealing. This is an explicit
  exception to blind storage. Outbound email needs a sending provider and is
  outside receive-only 1.0.

## 16. GitSpace 1.0 monorepo and bootloader

Replacement-unit packages:

```text
packages/
  protocol/          portable messages, crypto, identities, frame rules
  core/              local SQLite + domain handlers
  machine/           daemon, broker consumers, tunnel endpoint
  sdk/               space.* / gitspace.* code-mode bindings
  blocks/            transcript/block model
  web/               browser product
  cli/               bootstrap/setup/recovery/headless-host binary
  deployment/        shared planner, drain, replace, health, rollback
  relay/             portable user Worker + user-authored RelayDO
  relay-deployment/  canonical manifest + standalone/WfP adapters
  platform/          optional trusted WfP dispatch/control/billing plane
```

- `relay` never imports `platform`. One artifact, DO class, migration chain,
  binding contract, and protocol run standalone or inside WfP.
- `deployment` owns mechanics shared by `bun run dev` in B and signed promotion
  into A. Callers differ only in source immutability, target, authority, and
  failure policy.
- Stable `gssh` is firmware: start/setup/status/doctor/update/recover, identity,
  enrollment, and headless machine hosting. Routine project/workspace/goal/
  review/artifact/process/cloud commands disappear after web + SDK parity.
- No CLI compatibility period, aliases, SDK-to-CLI calls, or duplicated command
  handlers. Each domain cutover migrates every caller and deletes its old tree.
- Recovery floor = channel-installed previous bootloader generation plus a
  rebuildable local DB. Self-modification may replace everything above it.

## 17. Shared replacement engine

Entrypoints:

```text
bootloader, cli, daemon, agent-worker, offload-worker, web,
relay-worker, relay-do, platform-dispatch, platform-api,
local-database, cloud-schema
```

Each declares artifact/build/dependency/drain/replace/health/rollback policy.
`Bun.build` import-graph hashes identify changed entrypoints.

- Web: atomic asset-generation swap → code-version event → client reload.
- Agent worker: stop admissions → finish turn/tool boundary → persist → recycle.
- Offload worker: stop queue intake → finish jobs → recycle.
- Daemon: stop admissions/RPC mutations → successor generation socket/health →
  handoff. Broker-held PTYs/processes survive.
- Bootloader: stage, hash/signature verify, health probe, atomic pointer swap;
  previous generation retained.
- Relay Worker/RelayDO: stop enrollment/new tunnels → persist → reconnect notice
  → deploy code/migration → machines/clients reconnect. Session/PTY authority
  remains on endpoints.
- Database/schema: checkpoint first; run exact migration proven in B; declare
  forward-only effects. Never claim rollback that cannot restore data.

Development and production consume the same content-addressed artifacts and
executor. B allows dirty source and agent authority; A requires immutable
artifacts and a user signature.

## 18. Multi-machine updates

- Release transport is git fetch from a user-owned follow repository; relay
  traffic never carries source/update bytes. N machines have read-only deploy
  keys; human/user authority pushes.
- No current machine is special. Promotion names the fleet/environment targets
  and their expected generations.
- We do not preserve arbitrary mixed-version protocol compatibility. An
  approved fleet update drains online participants; offline machines are fenced
  and converge through the stable bootloader before rejoining.
- Fork-on-first-self-mod provisions a user-owned follow repo; no maintainer
  concept and no requirement that users host git servers.

## 19. Portable Cloudflare relay and optional Workers for Platforms

`packages/relay` is a portable Cloudflare application:

```text
standalone: route → Relay Worker → user RelayDO → user R2
hosted:     dispatch Worker → same relay artifact as WfP User Worker
                            → user RelayDO → tenant bindings
```

- RelayDO is the tunnel: one outbound machine WebSocket multiplexes terminal,
  agent, machine control, enrollment, development HTTP/WebSockets, and
  coordination channels. Hibernation attachments restore socket identity.
- Users may modify and redeploy Worker code, RelayDO code/migrations, routing,
  and custom tunnel protocols. The WfP Upload Worker API supports exported DO
  classes, SQLite migrations, limits, and subsequent rename/delete steps.
- Standalone target: user Cloudflare account, direct Wrangler deployment, user
  pays Cloudflare, no GitSpace credit system.
- WfP target: GitSpace dispatch namespace, tenant-scoped script/DO/resources,
  GitSpace supplies domain/resources and bills credits. Platform code is
  optional and never imported by relay runtime.
- WfP isolation is untrusted mode + hostname-derived tenant dispatch + signed
  deployment admission + tenant-only raw bindings (or mediated shared
  resources). Key prefixes are not isolation.
- Platform-controlled limits exist per dispatch and upload (`cpuMs`,
  `subRequests`). External GraphQL/Logpush metrics attribute Worker and DO
  requests, CPU, subrequests, rows, and stored bytes by script/class/namespace.
  Credits are an immutable microdollar ledger with admission reservations,
  measured settlement, prepaid risk reserve, quarantine at exhaustion, and
  `force=true` script/DO deletion as the destructive abuse stop.
- Outbound Workers police stateless User Worker fetches (destination policy,
  control-plane protection, delegated credentials, attribution). They do not
  intercept DO fetches; DO egress is bounded by script/platform limits,
  externally metered, and suspended/quarantined—not trusted for billing.
- R2 stores only client-sealed artifacts/session segments/reports. Keys remain
  with user devices/root identity. GitSpace/Cloudflare can observe tenant,
  object sizes, hashes, access timing, and billing—not plaintext.
- Normal HTTPS development tunnels terminate TLS at Cloudflare and are not
  content-blind; encrypted GitSpace protocol channels remain E2E. Document the
  distinction.
- Trusted product/control origins use `gitspace.com`; untrusted user relay/app
  origins use `gssh.dev`, exact-audience auth, and `__Host-` cookies.

## 20. Code-mode SDK, typed handlers, broker, and event doctrine

- Agents retain the full capability surface they had through CLI, but as code:
  `space.*` is the current workspace; `gitspace.*` covers projects, workspaces,
  machines, users, cloud, deployments, and fleet administration.
- One canonical typed handler owns each operation. Web RPC and code mode are
  adapters. The remaining recovery CLI adapts only bootloader operations.
- Every fallible operation returns `Promise<Result<T, E>>` using
  `better-result` v3 and method-specific `TaggedError` unions. Expected domain
  failures are data. Broken contracts/invariants throw `Panic`.
- RPC serializes Result through schema-backed codecs (Zod/Standard Schema):
  `{status:"ok",value}` or `{status:"error",error}`. JS rehydrates
  `better-result`; Python receives equivalent envelope/wrapper semantics.
- No public generic exec, argv construction, stdout parsing, CLI fallback, or
  CLI-only agent capability at completed cutover.
- `space.processes.*` uses OMP broker; GitSpace owns meaning/policy/events while
  broker owns bytes/process lifetime. Raw-stdin latency gates PTY ownership.
- **Push facts, pull bytes**: full snapshots only for connect/resync; normal
  updates are workspace/block scoped; streaming text uses append deltas; large
  live payloads truncate while committed history remains authoritative.
  OMP 18 + commit `b972282` implement the first skinny-event cut.
- Browser relay uses a per-workspace capability grant and OMP’s global broker.
  Logged-in browser access is never ambient.

## 21. GitSpace 1.0 build spine

1. Land this rewrite and create the minimal Bun workspace skeleton:
   `protocol`, `relay`, `relay-deployment`, `platform`.
2. Extract protocol/crypto without semantic change; preserve known-answer and
   authorization tests.
3. Build portable Relay Worker + RelayDO; deploy standalone in our Cloudflare
   account. Prove hibernating machine/browser sockets and custom HTTP tunnel.
4. Build one relay artifact once; deploy the identical hash through WfP for two
   tenants. Prove DO migration/state preservation and cross-tenant isolation.
5. Hostile-tenant/credit spike: limits, attribution, R2/DO/storage charging,
   quarantine, force delete A while B remains healthy.
6. Build shared `deployment` engine; `bun run dev` replaces B through it, and
   user-approved promotion installs the exact proven artifacts into A.
7. Consolidate mutable local state into `gitspace.db`; make rescan/rebuild a
   supported recovery path.
8. Build canonical typed handlers + `better-result`, then full
   `space.*`/`gitspace.*` parity and web adoption domain by domain.
9. Adopt OMP broker for processes/PTYS; delete tmux-lite process ownership.
10. Rebuild mini-apps as `local://` artifact trees backed by named broker
    processes and development-tunnel routes; remove inline `.gssh.html` state.
11. Add encrypted R2 artifacts/session mirrors, shares, and move/resume.
12. Delete routine CLI, local relay/cloudflared architecture, scattered state
    files, old handlers, and compatibility shims.
13. Add platform email, settings sync, checks/placement, and remaining fleet UX
    on the proven substrate.

Already completed: OMP SDK 18.0.6 migration (`f061638`), first skinny-event
cut and atomic local takeover (`b972282`), OS sandbox issue #135, delegate
issue #136, transcript-images issue #146.

## 22. Operations / issue sequence

Execute one by one; each ticket must name the package/replacement unit it owns.

1. Land FLEET 1.0 rewrite; close/reframe stale tickets that assume local relay,
   D1 directory, full CLI, `gssh dev up`, or separate dev/promote mechanics.
2. NEW “GitSpace 1.0 monorepo substrate” — Bun workspaces + minimal packages;
   no broad file move.
3. NEW “Portable relay standalone spike” — Worker + user RelayDO + hibernating
   sockets + encrypted frame echo + custom dev HTTP tunnel.
4. NEW “Canonical relay deployment manifest” — one artifact/migration/binding
   declaration rendered to Wrangler and WfP multipart metadata.
5. NEW “WfP two-tenant relay spike” — same artifact hash, user-authored DO
   migration, binding/hostname isolation.
6. NEW “WfP hostile tenant + credit ledger” — external attribution, rate card,
   admission reserve, reconciliation, quarantine, force deletion.
7. NEW “Shared replacement engine” — entrypoint graph, artifact set, drain,
   replace, health, rollback, durable journal.
8. NEW “GitSpace B package-script development” — `bun run dev` watcher invoking
   shared engine; B self-validates; user-signed immutable promotion plan.
9. NEW “One local GitSpace SQLite” — schema, repositories, rescan/rebuild;
   migrate/delete mutable JSON/control stores.
10. NEW “Canonical handlers + better-result” — Result codecs, tagged domain
    errors, web/SDK adapters.
11. NEW “Full code-mode parity + CLI removal” — `space.*`, `gitspace.*`, migrate
    every caller, delete routine Commander tree.
12. Rewrite #131 as OMP broker adoption; raw-stdin gate; delete process runner,
    watchdog, scheduler, and tmux-lite PTY ownership when proven.
13. Reframe #126 under the shared deployment engine: stable promoter,
    generation handoff, per-entrypoint hashes, worker drain, asset reload.
14. NEW “Encrypted R2 artifacts + session mirrors” — packfiles/segments,
    manifest CAS, shares, local eviction, move/resume.
15. NEW “Workspace email on platform domain” — default-branch allowlist,
    DKIM/SPF gate, plaintext-at-MX disclosure, sealed MIME in R2.
16. NEW “Broker-backed local mini-apps” — `local://apps/<id>` artifact tree,
    named OMP process, readiness/logs/route reference block, immutable promote/
    share snapshot; delete inline `.gssh.html` program state.
17. Keep: side-agent read tier; checks/placement; runtime/fleet view;
    browser-relay grant; subagent report/blame capture; worker wedge capture;
    isolinear pilot. Sequence them after the 1.0 substrate they consume.

The Cloudflare relay spike is first because it is the largest new runtime and
security assumption. Local DB/SDK/UI restructuring follows only after the
portable standalone/WfP data plane is proven.
