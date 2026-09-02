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
- Machine notes are canonical shared fleet metadata, synchronized into the
  local database cache rather than trapped in one browser or machine. They
  describe purpose, installed tools, constraints, and credential boundaries;
  they are visible in machine settings and agent placement context. Notes are
  not a secret store and the editor warns against putting credentials in them.
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
- Provider login remains a live-seat action. The durable refresh authority can
  be a per-user `CredentialVaultDO`: root-signed device grants authorize access,
  refresh credentials are sealed at rest, the DO leases and atomically commits
  rotating refresh operations, and returned access tokens are X25519/HKDF/
  AES-GCM sealed to the requesting machine. Hosted refresh is an explicit trust
  boundary: the Worker necessarily decrypts a refresh credential while calling
  the provider; Cloudflare/GitSpace are not content-blind at that moment.
- Root identity anchors machine enrollment, credential-device grants, signed
  cloud deployments, promotion approvals, encrypted blob recipients, and
  user-owned subdomain reservations.

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
  agent develops exactly as in another repository with package scripts owned by
  this repo. GitSpace has no product-level “dev mode”: B and current environment
  A use the same `ReplacementEnvironment`, machine runtime, frontend generation
  server, Result RPC transport, database migrations, drain, health, pointer
  switch, and rollback mechanics. Sandbox vs current is target root, resources,
  authority, and promotion policy—not another implementation.
- This repository's `bun run dev` is only a source watcher that builds immutable
  machine and frontend artifacts and submits sandbox-authorized replacement
  plans into B. Edits arriving mid-deployment coalesce into the next generation.
  It does not launch Vite or a development-only machine server.
- B has isolated SQLite, sockets/ports, OMP session storage, and artifact
  generations. Provider credential authority still needs the planned OMP auth
  broker before the whole OMP profile can be isolated without duplicating
  credentials. Relay and R2 sandbox allocation remain to be wired.
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

## 13. UX architecture (Gooey Pi + OpenSession references; GitSpace semantics)

- One persistent main agent per canonical space. Every project owns exactly one
  `kind=base` space; worktree spaces are its indented children.
  `agent_sessions.space_id` is unique, artifacts are indexed by `space_id`, and
  machine paths/generations live only in `space_placements`. Project routes
  resolve to the base space; workspace routes resolve to worktree spaces. Side
  agents belong to a main turn and surface as nested activity/reports, never
  peer navigation.
- Machine bootstrap creates metadata and placements only; it never creates an
  agent. Code-generation replacement persists live sessions with
  `stopForRestart(close=false)`, and the successor recovers only
  opening/active/draining rows. Closed, failed, and absent agents remain stopped.
  `space.open` is the sole ensure-live operation, including when placement is
  already local but its canonical agent has not started.
- Mid-turn replacement drains the current OMP run, persists a
  `resume_pending` fence, and lets the successor call `Agent.continue()` from
  the persisted user tail. The fence remains set until continuation settles;
  a second crash therefore retries rather than silently declaring the turn
  complete.
- No global top bar. The left app panel owns navigation, search, projects,
  inbox, settings, and active work. The project row is the base-project agent;
  its separately toggled, indented children are workspace agents. Agent focus
  occupies the main canvas. Kanban/project/review views widen into the canvas
  while the main agent contracts into a floating dock.
- The right inspector is a resizable workbench sibling, not a transcript
  overlay. Its 42px strip owns Summary, Subagents, Changes, Browser, Files, and
  Artifacts. When closed, a reserved accessory lane shows workspace status,
  deterministic subagent blobvatars, and artifact counts without covering the
  centered transcript or composer. Subagent rows are read-only observability:
  status, role, resolved model, summary, and the complete child OMP transcript.
  Selecting a child replays its persisted events, then follows the same
  ordinal stream until dismissal; completed children therefore remain
  inspectable while running children update without polling in the browser.
  Workspace action menus render through a fixed body portal so neither the
  inspector nor the left panel can clip them.
- Port the 0.x activity system as one truth, not lifecycle inference. Activity
  reasons are ordered turn, compacting/retry, human, queued steering/follow-up,
  and live subagents. Human wait renders permission orange; turn or compaction
  renders green; queued or subagent-only debt stays waiting blue rather than
  pretending the main agent is executing; actionable retry is red;
  closed/dormant/archived contribute nothing. Workspace precedence remains
  orange, green, blue, red, dim. Current workspace sorts first, then orange/red,
  blue, green; other dim workspaces stay hidden. Visual color tables remain
  exhaustive and consume this one projection.
- `packages/blocks` owns a stable reducer and schema: first-class turns,
  messages, thinking, tool calls/groups, distinct ask and permission blocks,
  todos, nested side agents/reports, interruptions, coalesced transport state,
  service-backed previews, rich content, and application reference blocks.
  Raw `message_update`/advisor lifecycle noise is not persisted into the
  product transcript; only committed semantic events produce replay facts.
- Goal/workflow/review documents open in context or wide application surfaces;
  transcript references point to them rather than embedding document editors.
  Inline `.gssh.html` blocks are removed in favor of `local://apps/<id>` plus a
  named OMP workspace-hub service and preview reference.
- OpenSession provides reference patterns for turn grouping, compact tool
  lifecycles, asks, turn footers, diffs, and virtualization. Gooey Pi provides
  reference patterns for quiet timelines, progressive detail, scroll behavior,
  changes summaries, terminal drawers, and the composer. Existing GitSpace
  remains authoritative for OMP event semantics, permissions, TTSR, artifacts,
  phase, possession, and workspace status.
- Highlight terminal output → attach to the next prompt. Browser annotations →
  prompt attachments. Queue-vs-steer remains explicit through OMP
  `streamingBehavior`.
- **FTUE + settings pages**: `UserSettingsDO`, keyed by user identity, owns the
  versioned profile, onboarding completion, Git author defaults, placement, and
  composer behavior. Mutations use expected revisions. `HandleRegistryDO`,
  keyed by normalized handle, provides globally serialized `gitspace.sh`
  namespace claims. The saved Queue/Steer choice maps directly to OMP
  `followUp`/`steer` prompt behavior. A missing or incomplete record opens FTUE;
  completion returns to the workspace. Settings opens at `?view=settings`.
- **OMP settings**: OMP remains the schema and persistence authority. GitSpace
  renders the installed `SETTINGS_SCHEMA` instead of maintaining a parallel
  catalog. `UserSettingsDO` stores the exact managed `config.yml` with a
  generation, SHA-256 checksum, writer, and update time. Each machine keeps a
  writable local replica at OMP's normal path. Native OMP or GitSpace writes are
  watched and published with compare-and-swap; stale writes are rejected and
  replaced by the newer cloud generation. A hibernation-safe Durable Object
  WebSocket broadcasts generation changes to every authenticated machine;
  reconnect uses bounded backoff and there is no settings poller. Machines
  replace newer files atomically, call `Settings.reloadFromDisk()`, fan reloads
  into active OMP sessions, and retain the last replica for offline startup.
- **Git identity**: the user fleet owns one generated Ed25519 SSH identity in
  canonical cloud storage. Each enrolled machine materializes the same key with
  `0600` permissions. GitSpace repositories receive its `core.sshCommand` plus
  the shared author name/email; existing non-GitSpace repositories are untouched.
- Physical/self-hosted machines join through the 1.x machine enrollment path.
  Every fleet definition carries a provider ID (`physical` or
  `cloudflare-sandbox`) in addition to presentation kind and shared notes. The
  generic lifecycle RPC resolves that provider record; no sandbox branch exists
  in machine control. The physical adapter owns daemon-specific behavior. The
  Cloudflare adapter calls package-local `@gitspace/sandbox-worker`, which owns
  container stop/restart/destroy and RPC re-exposure.
- Create sandbox requires provisioned user Git storage, generates an
  Ed25519/X25519 managed-machine identity, records its scoped grant, and passes
  private runtime material only through the internal service binding. The image
  contains the package-only 1.x runtime, OMP native addon, migrations, OpenSSH,
  WalGit, and an actual Result RPC probe. Runtime startup resolves the user's R2
  binding and mints project-scoped WalGit credentials dynamically. A machine is
  registered online only after its readiness log, TCP port, and RPC query pass.
  Sleep or destroy is rejected while the machine owns an open space; destroy
  removes the fleet record and managed grant only after provider teardown.
- Cloud cards show exact ownership/cost/trust facts: deployment target,
  account/platform owner, relay artifact hash, RelayDO migration, R2 encryption
  state, hosted credit reserve, and whether tunnel traffic is plaintext at
  Cloudflare or E2E. Physical enrollment remains a root-signed two-machine
  ceremony. Managed sandboxes instead require an authenticated owner-machine
  control request; the control vault records the generated scoped device grant
  before private runtime material crosses the internal sandbox service binding.
- OMP workspace-hub process mechanics are internal. Users see Services: state,
  readiness, logs, ports/routes, restart, and preview. Machine-global browser
  relay remains separate.
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
- Platform-controlled limits work for the dispatched User Worker: four external
  subrequests succeeded, six failed at a configured limit of five; CPU burn was
  terminated. These limits DO NOT contain user-authored Durable Objects:
  25 Worker→DO invocations succeeded, DO-originated `fetch()` bypassed the
  Outbound Worker, and a DO alarm rescheduled independently of dispatch.
- External GraphQL/Logpush metrics DO attribute DO requests/CPU/duration/rows by
  script/class/namespace and R2 operations by bucket. The implemented credit
  prototype provides a versioned gross-list-price microdollar rate card,
  idempotent CreditDO ledger, dispatch reservations, risk reserve, automatic
  quarantine, and `force=true` deletion; beta remained healthy throughout
  alpha exhaustion/deletion.
  Usage capture must stream into platform-owned immutable ledger storage before
  destructive suspension: after force-deleting alpha, a later namespace query
  no longer returned its rows, while the pre-delete capture remained usable.
- **Blocking result**: Cloudflare exposes no externally enforced per-tenant DO
  instance count or aggregate burn-rate cap. Metrics are delayed; a malicious
  DO can create more objects/alarms during that window. Therefore maximum
  uncollected exposure for arbitrary public user-authored DO code is NOT
  finitely bounded with current controls.
- Standalone BYO remains safe economically because Cloudflare bills the user.
  Hosted WfP may allow arbitrary RelayDO code only after one of: Cloudflare
  supplies a hard aggregate tenant cap/subaccount boundary; users post a
  platform-acceptable externally enforceable reserve; or hosted mode constrains
  DO code behind a platform-owned state capability. Do not paper over this with
  delayed analytics.
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
- Every fallible operation returns `Promise<Result<T, E>>` through the single
  workspace `better-result` v3 runtime. Browser RPC uses `result-rpc`: the
  browser-safe contract owns codecs and declared public error definitions;
  core/machine own handlers and routers. Browser code never imports a router.
  Expected failures cross as rehydrated tagged values; broken invariants and
  undeclared exceptions become sanitized internal failures plus private
  incident signals.
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
- Browser RPC stays on result-rpc's native transport: batched HTTP requests for
  queries/mutations and exactly one replayable streaming-HTTP fact subscription
  per browser↔machine connection. Components share its cache; they never open
  subscriptions. The committed SQLite event log is the queue: bounded pages and
  explicit offsets prevent per-client memory backlogs. result-rpc 0.5 documents
  `.resumable()` but omits it from the browser-safe contract builder, so the
  first implementation reconnects with an explicit `afterOffset` and dedupes by
  monotonic offset. Replace that input with native resumability when the
  contract API actually exposes it.
- Local HTTP goes directly to the machine. Remote HTTP/streaming HTTP is
  tunneled through RelayDO over the machine's required outbound WebSocket.
  An `e2eFetch` wrapper encrypts ordered request/response stream records with
  the browser↔machine session key, so RelayDO routes opaque bytes while
  result-rpc still sees ordinary Fetch requests and responses.
- WebSockets are on-demand interactive transports, not the application RPC:
  terminal, CDP/browser control, service WebSockets, and the machine's outbound
  NAT tunnel. Static assets, RPC, transcript ranges, and artifact bytes use
  HTTP. Fact queues are bounded/coalesced; overflow closes with an explicit
  resync requirement rather than accumulating memory.
- ReflectDB is deferred. Possession deliberately prevents ambient multi-master
  writes; result-rpc subscriptions/cache cover current live-state needs.
  Reconsider offline sync only for low-risk personal UI state such as notes,
  read markers, and saved views.

## 21. GitSpace 1.0 build spine

1. Land this rewrite and create the minimal Bun workspace skeleton:
   `protocol`, `relay`, `relay-deployment`, `platform`.
2. Extract protocol/crypto without semantic change; preserve known-answer and
   authorization tests.
3. Build portable Relay Worker + RelayDO; deploy standalone in our Cloudflare
   account. Prove hibernating machine/browser sockets and custom HTTP tunnel.
4. Build one relay artifact once; deploy the identical hash through WfP for two
   tenants. Prove DO migration/state preservation and cross-tenant isolation.
5. Hostile-tenant/credit spike: completed. Attribution, encrypted tenant R2,
   ledger/reservation/quarantine/force-delete work; arbitrary user DO burn is
   unbounded across the analytics delay because no instance/aggregate cap exists.
6. **Architecture gate**: choose/obtain an externally enforceable hosted DO
   containment boundary. Standalone arbitrary RelayDO remains valid. Do not
   public-launch arbitrary WfP RelayDO code before this gate passes.
7. Build shared `deployment` engine; `bun run dev` replaces B through it, and
   user-approved promotion installs the exact proven artifacts into A.
8. Consolidate mutable local state into `gitspace.db`; make rescan/rebuild a
   supported recovery path.
9. Build canonical typed handlers + `better-result`, then full
   `space.*`/`gitspace.*` parity and web adoption domain by domain.
10. Adopt OMP broker for processes/PTYS; delete tmux-lite process ownership.
11. Rebuild mini-apps as `local://` artifact trees backed by named broker
    processes and development-tunnel routes; remove inline `.gssh.html` state.
12. Add encrypted R2 artifacts/session mirrors, shares, and move/resume.
13. Delete routine CLI, local relay/cloudflared architecture, scattered state
    files, old handlers, and compatibility shims.
14. Add platform email, settings sync, checks/placement, and remaining fleet UX
    on the proven substrate.

Already completed: OMP SDK 18.0.6 migration (`f061638`), first skinny-event
cut and atomic local takeover (`b972282`), OS sandbox issue #135, delegate
issue #136, transcript-images issue #146.

## 22. Operations / issue sequence

Execute one by one; each ticket must name the package/replacement unit it owns.

1. DONE “FLEET 1.0 rewrite” — stale local-relay/D1/full-CLI/dev-promote
   assumptions replaced.
2. DONE “GitSpace 1.0 monorepo substrate” — Bun workspaces + minimal packages.
3. DONE “Portable relay standalone spike” — Worker + user RelayDO + hibernating
   sockets + encrypted frame echo + custom dev HTTP tunnel.
4. DONE “Canonical relay deployment manifest” — one artifact/migration/binding
   declaration renders Wrangler and WfP metadata, including tenant R2.
5. DONE “WfP two-tenant relay spike” — same artifact hash, user-authored DO
   migration, binding/hostname/R2 isolation.
6. DONE “WfP hostile tenant + credit ledger” — encrypted tenant R2, external
   attribution, rate card, idempotent ledger, admission reserve, exhaustion
   quarantine, and force deletion. Result: no finite arbitrary-DO exposure bound.
7. GATE “Hosted user-authored DO containment” — obtain Cloudflare aggregate
   tenant limit/subaccount isolation, or choose a constrained hosted state
   capability. Standalone arbitrary RelayDO remains supported.
8. DONE “Shared replacement engine core” — signed immutable plans, dependency
   expansion, SQLite journal/recovery, drain-all/stage/activate/health/commit,
   reverse rollback, frontend pointer swap, machine socket handoff with database
   checkpoint/migrate/restore, OMP worker drain, and broker PTY fence. Wiring
   real hosts belongs to operations 9/13/14.
9. IN PROGRESS “GitSpace B package-script self-development” — root `bun run dev`
   is now a thin watcher/plan submitter. The same exported
   `ReplacementEnvironment` mechanics can host sandbox B or current A. It builds
   content-addressed machine and frontend artifacts, invokes the shared engine,
   checkpoints/migrates SQLite, health-gates successors, switches stable RPC and
   asset endpoints, preserves the OMP session, emits `code-version`, reloads the
   browser, and coalesces source changes. User-signed immutable B→A promotion,
   auth-broker-isolated OMP configuration, and sandbox relay/R2 allocation remain.
10. IN PROGRESS “One local GitSpace SQLite” — Drizzle Kit now owns the first
    `packages/core` schema and migrations for projects, possessed workspaces,
    artifact scopes/cache, OMP sessions/transcript offsets, and promotions.
    Restart recovery is proven across a closed/reopened database. Repository
    rescan and migration/deletion of the 0.x stores remain.
11. IN PROGRESS “Canonical handlers + better-result/result-rpc” — browser-safe
    contracts, reified tagged errors, bootstrap/possession/session handlers,
    Fetch router, bounded fact log, live React client, and encrypted unary/
    streaming adapters are proven through real HTTP wire tests. Complete every
    remaining domain and the SDK adapter before calling parity.
12. NEW “Full code-mode parity + CLI removal” — `space.*`, `gitspace.*`, migrate
    every caller, delete routine Commander tree.
13. Rewrite #131 as OMP broker adoption; raw-stdin gate; delete process runner,
    watchdog, scheduler, and tmux-lite PTY ownership when proven.
14. IN PROGRESS under the shared deployment engine: machine and frontend
    generations both drain/stage/activate/health/commit through common
    environment hosts. Machine replacement switches the stable RPC endpoint;
    frontend replacement switches the stable asset generation and reloads the
    browser; the same OMP session survives. Stable bootloader promotion and
    wiring installed `gssh web` to the common current-environment host remain.
15. IN PROGRESS “Encrypted R2 artifacts + session mirrors” — the first
    capability-scoped `local://` projection now provides base/current/sibling
    views, client encryption, lazy object fetch, local materialization,
    generation-CAS manifests, and explicit re-encrypting workspace→base
    promotion. Shares, chunked large blobs, remote ref authority, eviction
    policy, and fleet move/resume remain.
16. NEW “Workspace email on platform domain” — default-branch allowlist,
    DKIM/SPF gate, plaintext-at-MX disclosure, sealed MIME in R2.
17. NEW “Broker-backed local mini-apps” — `local://apps/<id>` artifact tree,
    named OMP process, readiness/logs/route reference block, immutable promote/
    share snapshot; delete inline `.gssh.html` program state.
18. DONE “First local 1.0 vertical slice” — `packages/machine` enforces and
    reopens one main agent per possessed workspace plus one project agent at the
    base repository. Project and workspace sessions keep isolated OMP identities,
    transcripts, and writable artifact scopes; scope migration preserves existing
    workspace transcripts. Semantic transcript events survive database/machine
    replacement. `packages/blocks` reduces OMP history into turns, nested side
    agents, typed interactions/content, and coalesced transport blocks.
    `packages/web` now uses the panel-first shell: no top bar, left app
    navigation with status-sorted active work and an indented project/workspace
    hierarchy, agent focus plus floating context capsule, combined right context,
    wide Kanban/project canvases, and mobile bottom navigation. Desktop project/
    workspace agent routing, agent/context/Kanban, and mobile agent surfaces are
    browser-verified.
19. IN PROGRESS “Worker credential authority” — `packages/auth-worker` proves a
    Worker-compatible per-user CredentialVaultDO, root-signed machine grants,
    signed/replay-protected access requests, at-rest vault sealing, per-request
    refresh leases, revision-CAS token rotation, refresh-uncertain fail-closed
    state, and machine-sealed access responses. Anthropic, OpenAI Codex, Google
    Gemini CLI, Google Antigravity, and Cursor refresh under Workers and pass
    local DO simulations. None are copied now: one narrow
    `@oh-my-pi/pi-ai` patch adds a Worker-only bounded HTTP/error core plus
    provider-specific portable refresh modules; each original OMP adapter calls
    the same module and maps portable errors back into its existing `OAuthError`
    contract. A pristine `bun install --force` applies the patch. Upstream these
    modules and delete the patch once released. The DO now exposes OMP's native
    auth-broker health/snapshot/conditional-fetch/refresh routes; self-development
    imports existing local OAuth rows into the DO, then launches OMP with only
    `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`. A real Codex turn completed
    through `RemoteAuthCredentialStore` while the refresh token remained absent
    from the client snapshot. Live deployment, scoped incarnation bearer grants,
    remaining providers, SSE snapshot streaming, and uncertain-refresh recovery
    remain.
20. DONE “Portable space checkpoint substrate” — one versioned manifest and one
    hierarchical key builder keep repository state at `projects/<project>/repo`
    and agent/artifact/checkpoint state under its owning space. The machine uses
    temporary Git indexes to preserve HEAD, staged and unstaged trees, modes,
    symlinks, and policy-approved untracked files without touching visible
    history; a supervised per-project walgit process publishes immutable refs.
    Encrypted application-data objects carry OMP, transcript, and artifact
    manifests through the signed Worker API into the dedicated `DATA` R2
    binding. `SpaceAuthorityDO` generation-fences close/open. Git storage is a
    separate bucket: walgit uses S3 against RustFS in development and R2 in
    production. `bun run dev` runs that exact topology with programmatic
    Miniflare, persistent local R2/DO state, RustFS, and a packaged walgit
    binary. Result RPC delegates close/open only to `PortableSpaceLifecycle`;
    there is no direct local stop/release/start path. The live integration test
    deletes repository and OMP state, reconstructs an empty target, restores
    staged/unstaged/non-ignored untracked state, excludes ignored secrets,
    resumes the canonical agent, and accepts another prompt.
    Destructive close also requires the repository root to be beneath the
    machine's managed-space root; self-development source checkouts and other
    externally owned paths fail closed before deletion.
    The move demo adds a user-scoped `FleetCatalogDO`, separate per-machine
    SQLite projections, and client-orchestrated source close plus target open.
    `bun run demo:move` runs two isolated machines behind one browser transport
    directory. Verification moved generation 1 on Machine A to generation 3 on
    Machine B, deleted the complete Machine A root, preserved the canonical
    agent and OMP ids, restored staged/unstaged/untracked Git state, and accepted
    a new target prompt while rejecting the stale source generation.
    The prototype database history was intentionally reset at this boundary:
    the fresh schema has only `projects`, `spaces`, `space_placements`, and
    space-owned agent/artifact rows; no legacy project/workspace session columns
    or local-only workspace lifecycle RPC remain.
    Machine/control transport is one canonical signed envelope: device key,
    capability grant, timestamp, UUID nonce, operation, payload, and Ed25519
    signature. `CredentialVaultDO` consumes replay nonces before routing
    generation-checked space operations to `SpaceAuthorityDO`; the machine
    implements the same authority interface through `CloudSpaceCheckpointAuthority`.
21. Keep: side-agent read tier; checks/placement; runtime/fleet view;
    browser-relay grant; subagent report/blame capture; worker wedge capture;
    isolinear pilot. Sequence them after the 1.0 substrate they consume.

The portable relay data plane is proven standalone and under WfP. Hosted
arbitrary user-authored DO containment is not. Local DB/SDK and standalone work
may proceed; public hosted RelayDO execution waits at operation 7.
