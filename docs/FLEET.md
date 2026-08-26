# FLEET.md — fleet, movability, lifecycle, and self-development design

Status: DRAFT for approval. Captured 2026-08-10 from a full design session.
This is the anchor document: tickets reference it instead of re-deriving
rationale. When a decision here changes, change it here first.

---

## 1. Thesis

**Don't hide machines. Name them, and make crossing between them cheap.**

Five primitives, which every subsystem below reduces to:

1. **Possession** — one writer per thing (workspace tree, goal folder, session,
   deploy environment). Movement is an explicit verb, never ambient. Possession
   is the lock; there is no separate lease registry.
2. **Refs** — git is the data plane: code, WIP snapshots, artifacts, canon,
   goal content, the recovery estate.
3. **Signals** — the relay is the control plane: dispatch, pings, log streams.
   It carries no state.
4. **Names** — work lands somewhere explicit: labeled runner, pinned service,
   identity-bearing machine, the user's seat. Nothing migrates transparently.
5. **Facts → agent** — the system observes (probes, timings, failures) and
   presents facts; the agent chooses. Safe because placement is a performance
   decision only — correctness is structural (single writer + fences).

## 2. Rejected alternatives (do not relitigate without new evidence)

| Rejected | Why |
|---|---|
| Network filesystem mounts for code | metadata-storm syscall tax (100x on stat-heavy builds); owner death bricks every consumer — contradicts the founding "disconnect and keep going" requirement; watchers don't cross mounts; SQLite-on-NFS |
| Live session/process migration | can't serialize a mid-turn process; industry (Codex cloud, Cursor cloud agents) moves git artifacts at boundaries and keeps conversation in a backend |
| Ambient multi-master state sync | conflict soup; replication (one writer per namespace) gives durability without merges |
| Credential distribution/leasing per-cred | the credential surface is unenumerable ($HOME sprawl); route work to identity instead; delegate for the top few |
| Transparent remote shells (migrating bash state) | shell/kernel state is machine-local; the honest model is named per-host contexts (ssh-tab model) — later superseded entirely by "move the whole harness" |
| Per-command remote exec surface (maintained) | an entire product surface to maintain; collapsed into two lanes: declared checks + whole-harness moves |
| `space check` as a new agent-facing verb | space surface is shrinking (#117 codemode); the chokepoint is the bash/eval tool; declaration ≠ invocation |
| GitHub-hosted CI as the check engine | queue+boot+cache-transfer latency; we originate the push events, so their control plane adds nothing |
| Live worker reattach across daemon versions | requires OUR wire protocol stable across versions — the thing guaranteed to churn during self-development. See §10 |
| Orphaning busy workers through an upgrade | old OUR-code mutating artifacts/records while new code migrates schemas = cross-version skew via the filesystem |
| A "meta project" product type for self-dev | gitspace-on-gitspace is a normal project; the feature is that there is no feature (§11) |

## 3. Audited current-state facts (verified in-repo this session)

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

## 5. Processes & services (#131 rewrite)

- Adopt the OMP broker under `space process`: broker owns spawn/PTY/readiness/
  restart/logs/persistence/re-adoption. GitSpace keeps workspace-scoped names,
  port allocation, env interpolation (#124), hostnames/hosting, wide-events,
  autostart policy. **One owner rule** — broker replaces the tmux-lite `proc:`
  path and the dead watchdog; never both supervising one process.
- Namespace: root per workspace (or prefix names with workspace id) — NOT
  OMP's per-project-dir default. This is the main integration risk.
- Broker `owner` field is metadata, not a lock; sharing named processes
  across a workspace's agents is intended behavior.

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
  cloud/provision       once per WORKSPACE IDENTITY; fingerprint travels
                        (artifacts mount) — NEVER re-runs on move; probe
                        ("stack exists?") degrades lost state to a skip
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
- `cloud/*` steps need credentials + repo ref, NOT the worktree → they run
  where identity lives, even if the workspace's machine is dead (bindings
  travel via artifacts).
- **Bindings**: provision emits `bindings.json` (ids/URLs — non-secret) into
  the artifacts mount; secrets go to the delegate BY NAME. `.env` becomes a
  DERIVED artifact: render(bindings) + inject(delegate secrets) at
  materialize. Never synced, never committed. Pulumi et al MUST use remote
  state backends keyed by workspace id.
- Migration mapping (conservative): `pre/`→materialize (already deprecated),
  `setup/`→materialize (cloud bits hand-lifted to provision),
  `select/`→materialize (ordered after), `remove/`→**cloud/destroy ONLY**
  (mapping remove→dematerialize would run deletions on every move).
- Effect-scoped fingerprints are load-bearing: worktree = per (machine,
  workspace); machine = per machine; cloud = per workspace identity, stored
  where it travels.

## 8. Bundle v2 + identity

- bundle.json = the repo's contract with the fleet (additive fields):
  `requires` / `permits` (capabilities, platforms, per-role: server may be
  linux; interface needs macos+display), `secrets` (declarations → delegate
  rules, never values), `checks` (pointers at existing package scripts —
  transcribe, don't port), onboarding v1 unchanged as interactive fallback.
- Setup SDK (TS): steps declare { scope, effect, probe, satisfy, requires }.
  Probes have TTL/freshness ("once per user per session length per tool").
  **Preflight**: resolve every step's identity/capability needs BEFORE
  running — route the step to a satisfying machine or walk the user through
  auth at the seat. Scripts never die at the gcloud step.
- **Identity routing**: work goes to where logins live (learned table:
  login events, `auth status` probes, 401-retry outcomes). Never declared
  lists.
- **Delegate (#136)**: fleet egress proxy holds/injects secrets; workers
  never hold them. v0 = GitHub (App installation tokens via gitspace.sh) +
  LLM gateway (base URLs). Prefer named per-service endpoints over MITM-CA.
  Availability failure degrades to identity-routed placement, not outage.
  v2 = GitSpace as OIDC issuer (cloud workload identity federation; claims
  can include env-lease). **Access** = the ingress mirror: deny-by-default
  route policies at the relay, OAuth→scoped cookie, reuse `gssh-share:`
  token format + revocation ledger. Same policy engine, opposite directions.
- **Seat** = dynamic capability on the user's live client connection:
  `process open`, OAuth callbacks, approvals, docs route to the seat.
  Distinct from `display:attached` (machine with a GUI session).

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

## 10. Replication, moves, upgrades (the drain doctrine)

- **Replication** = eager push, lazy pull. Each machine writes only its own
  namespace: `refs/gitspace/<machine>/<ws>/wip`. Disjoint writers →
  conflict-free (same trick as goals/). v0 = git shadow-snapshot on a
  debounce; upgrade = jj colocated (working-copy-as-commit; snapshot.
  max-new-file-size replaces the LFS hook role; first-class conflicts
  soften roll-up; op log; weak git-notes interop is the gap).
  Sync boundary = gitignore ("carry everything except ignored"); ignored
  dirs are REDERIVED per machine (grown, not shipped). Ignored-but-precious
  ceases to exist once .env is derived (§7).
- **Move** = the #126 restart aimed at another machine: drain at a gate →
  sync (tracked + artifacts + session JSONL + carry-list) → lifecycle
  materialize on target → reopen. Goal = unmaterialized workspace; moving
  an unmaterialized one is copying a record. Recovery from a dead machine =
  force-take from its replica namespace; unpushed work is lost (git's
  contract, understood by everyone). Retire-from-anywhere works because
  cloud/destroy needs bindings + credentials, not the corpse.
- **Upgrade-in-place (Promote) is the same verb, destination = same host,
  different code.** THE STABILITY RULE: a process may only survive a flip
  if the interface it speaks is one we don't own or can't churn.
  - Survive: hub broker + services (OMP's protocol), PTY holders (byte
    pipe + replay file; MUST stay tiny/rarely redeployed), session JSONL
    (OMP's at-rest format).
  - Die, always: OUR workers. Drain via OMP pause gate (freezes at next
    model/tool boundary in seconds; abort() as fallback) → worker exits →
    new-code worker reopens from JSONL + durable inbox. No cross-version
    IPC ever; no orphaned old code mutating shared files.
  - Durable runtime store (small; SQLite fine, files fine): prompt inbox,
    session registry snapshot, previous-build pointer. At-rest schemas get
    ordinary migrations; wire protocols never cross versions.
- This SHRINKS #126-A: worker named-socket reattach is not needed for
  promote. Survivors: holders + broker only.

## 11. Self-development (gitspace-on-gitspace)

- gitspace.sh is a NORMAL project: N workspaces for feature ideas, same
  kanban/goals/review flow. No meta-product.
- Day-one kit: `gssh dev up` (boot THIS workspace's build as the single "B"
  instance — own session dir/control dir/port block, devroot FIXTURE root;
  env seams already exist and are test-exercised), a single-B lockfile,
  and `serve restart --into <workspace>` (promotion; also the rollback,
  pointed at the previous build).
- **Promote UI**: workspace card/detail action on self-repo workspaces;
  preflight sheet (build state, diff, B smoke); flip = drain doctrine (§10);
  toast with one-click Revert; global chip showing console version.
  Asset-skew: reconnect detects new web bundle → hard reload (layout is
  localStorage). NEVER waits for busy agents (pause-gate drain in seconds).
  Promote is the daily acceptance test of #126 and the rehearsal of B2.
- B on fixture root only; "candidate against real root" IS promotion.
- Parked (FLEET-future, only if traction): A/B health slots + auto-revert,
  patch-queue agent (rebase personal patches on upstream — precedent:
  our own patches/@oh-my-pi), propose-upstream flow, community funnel.
- Hermetic B doubles as the e2e check ("dev instance boots + smoke") that
  any executor incl. Codex cloud containers can run.

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
- **FTUE + settings pages** ("getting everything running"): every subsystem
  (identity, auth, hosting, daemon, project, Linear, artifacts, delegate
  later) exposes the same probe `gssh status` uses — status + one repair
  action = a settings card. FTUE is the SAME cards arranged as an ordered
  checklist with empty states; settings is them arranged by subsystem.
  One component set, two arrangements — never two implementations.
  Two legs, because the web app is served by the daemon: a terminal leg
  (bare `gssh` guides init → daemon+web running — the §11 bootloader is
  also the first-run wizard) then the web leg (auth, host, first project,
  integrations). Bundle onboarding (utils/onboarding.ts) is the per-project
  FTUE that already exists; this is the machine-level analogue.
  The crypto/remote side is cards too: identity (keypair + fingerprint),
  relay mode (gitspace.sh tunnel vs self-hosted, reachability), machine
  enrollment (enrolled-at-relay, last seen), browser/client identities
  (localStorage keys awaiting approval), invites (mint/revoke). FTUE
  defaults the hosted path (auth login → host reserve → serve start);
  self-hosted/multi-machine lives in settings. Enrollment is a TWO-machine
  ceremony — owner's settings mints the invite, the new machine's FTUE
  redeems it — and the resulting Machines page is the seed of the fleet
  registry view (B3): naming a machine here is what later gives it
  capability rows.
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

## 14. Extensions & specs (the distribution model)

Three tiers, ordered by frozen-interface burden; §10's stability rule
decides which exist:

- **Tier 0 — data conventions** (shipped): artifact kinds (`*.dashboard.json`
  → rails), `.gssh.html` mini-apps + #129 action bridge. The "API" is file
  formats.
- **Tier 1 — OMP extension + GitSpace renderer**: agent-side tools via OMP's
  extension API (OMP-owned — stable for free), display via the block/tool
  renderer registry or mini-apps.
- **Tier 2 — GitSpace plugin API: REJECTED-FOR-NOW.** A plugin API freezes
  exactly the surfaces self-development most needs to churn. Self-mod
  deletes this tier, not the other two.

**Distribution = specs, not binaries.** An "extension" is a spec — goal +
rubric + skill (the teaching) + optional reference implementation — that the
user's agent implements into THEIR fork: implement in a workspace → checks
green in a B instance → review gate → promote. Every piece already exists;
the catalog is a set of planned goals. Divergence stops being a bug:
integration into the user's own setup is the product. Tiers 0–1 are what
specs compile against — thin stable substrate, thick spec layer.

**Everybody owns their own**: GitSpace's in-tree features double as the
reference implementations of their own specs; a user's fork owns its
variants via the self-modifying flow (§11), with the patch-queue agent as
"spec rebase" when upstream specs update, and propose-upstream as the
return path.

Caveats (recorded): implementing > installing (reference impls are the fast
path); quality floor = the rubric + checks in the spec; security = §11's
stack (mandatory review gate, blame provenance, delegate-shrunk secrets).

**Pilot recipe: the isolinear codebase display.** v1 is pure tier 0: a
skill emits a codebase-map artifact (chip grid of the tree), rendered as a
dashboard/mini-app, heat from data we uniquely have — `blame/edits.jsonl`
(agent activity), goal association per area, check status. If the spec
model works, this is catalog entry #1; if not, we still got the display.

**Spec doc strawman** (format DELIBERATELY UNSPECIFIED until op 19 writes
the real one; FLEET.md itself is the informal prototype). A spec is
ordinary markdown, agent-first — no manifest, no registry schema; the
reader is an agent with your fork checked out. Sections:

```markdown
# Spec: <name>
version: 1 · tier: 0|1 · targets: <stable surfaces>

## Intent            — one paragraph: what exists when done, for whom
## Substrate contract — the ONLY compat-sensitive section: exact shapes of
                        emitted artifacts (schema inline), render surface
                        (.gssh.html + #129 verbs), data read. May only
                        reference tier-0/1 surfaces — this is what keeps
                        specs viable without a plugin API.
## Teaching          — the skill, inline or skill:// ref; conventions the
                        user's fork may override
## Rubric            — agent-runnable acceptance checks ("checks green in
                        B" made specific). Without it: documentation.
                        With it: an installer.
## Reference implementation — pointer to upstream's own build (fast path:
                        adapt, don't reimplement)
## Non-goals
```

Install verb: drop the spec in a goal folder → agent implements against
the rubric → B instance → review gate → promote. The catalog is a
directory of these files (home — docs/specs/ vs bundle — also open until
the pilot).

## 15. Workspace email (receive-only v1)

Every workspace gets a human-readable address:
`<project>.<workspace>@<subdomain>.gitspace.sh` (normalized like workspace
dir-names; mail to unresolvable addresses drops silently — no bounce, no
enumeration oracle). Guessability is fine because ingress is
allowlist-default-deny.

- **Pipeline** (pure "push facts, pull bytes"): CF Email Routing catch-all →
  Email Worker → DKIM/SPF alignment check → allowlist check → raw MIME
  sealed to user root key → R2; envelope-fact via relay DO; machine pulls
  bytes on open. Email = another inbox transport on the named-agents plan
  (§6/§13) — no new primitive.
- **Allowlist** = `.gitspace/email.jsonc` in the repo: exact senders and
  `@domain` entries (domain entries are what make agent-testable
  transactional flows work — allow `@yourapp.dev`, receive every
  password-reset/confirmation mail the app under test sends). Absent/empty
  file = receive nothing; email is opt-in per project. Allowlist means
  nothing without the DKIM/SPF gate first (From: is spoofable).
- **Self-widening guard**: the Worker syncs the allowlist from the project
  base repo's DEFAULT BRANCH only. A workspace agent editing its own
  `email.jsonc` gets no ingress until a human merges — consistent with
  repo-config-as-defaults scoping.
- **Injection stance**: mail is untrusted input adjacent to agents. It lands
  as inert inbox data an agent reads deliberately; never auto-injected into
  a session.
- **Doctrine disclosure**: email arrives plaintext at the MX — this is the
  ONE channel where CF sees content (sealed before R2, but visible at
  ingestion). Say so; don't pretend.
- **Sending** is out of v1 (CF doesn't send; needs Resend/SES + DKIM).
  Outbound later, hosted-tier — same paywall line as App-backed
  integrations.
- **Extension canary #2**: settings-sync proves daemon+cloud legs;
  workspace-email proves Worker-routes-owned-by-an-extension (Email Worker
  binding + R2 + directory rows, all private to the extension).

## 16. Bootloader inversion & dev mode

- Installed stable `gssh` CREATES the dev environment; the dev env is
  gitspace.sh as a normal project bundle. B = a space process behind an env
  lease; promote = A execing its successor.
- The bootloader contract (exec + env + socket + health) is the ONE
  conservative interface. Everything above it may churn.
- Recovery floor = channel-installed binary: no self-mod outcome may leave
  a machine without a working `gssh`.

## 17. Self-mod machinery (replacement map + flip)

- **Detection = import-graph hashing, not curated maps**: `Bun.build` per
  entry point (server.ts, agent-worker.ts, offload-worker.ts), hash the
  artifact. Replace the `code-version.ts` single token with a
  `{daemon, worker, offload}` triple. Worker-hash-only diff → recycle
  workers, no daemon flip. `evaluateDaemonFreshness()` (cli.ts —
  fresh/stale-idle/stale-busy/wedged) is the existing sensor.
- **Replacement map** = extension types (boundary vocabulary, NO compat
  promise) × restart tiers (hot / worker / daemon / swapper / cloud). Type
  implies tier. The swapper self-swaps via generation handoff.
- **Missing flip items (4)**: `gssh machine serve restart` verb;
  `recycleIdleWorkers()`; per-entrypoint hashes; asset-skew web reload
  (daemon pushes codeVersion over the agent-state conduit → client
  location.reload).
- **Extension rings**: kernel (possession/crypto/process-lifetime litmus) /
  in-tree extensions (internal daemon SPI ok) / packaged extensions (tiers
  0–1 + declarative only, NEVER daemon SPI) / specs (anything). Proving
  set: settings-sync, workspace-email (§15), isolinear, Linear.
- Self-mod is the PRIMARY extension mechanism; extensions are the
  organizing principle / on-off boundaries, not a replacement for
  spec-driven self-mod. The core need is knowing which entry point an edit
  affected and what reload level it requires — the hash triple answers
  both.

## 18. Multi-machine updates (git-only distribution)

- A release = a git ref in a user-owned follow repo; each machine holds
  `{remote, ref}`. Transport = `git fetch` ONLY — the relay NEVER carries
  update bytes.
- Credentials: N machines × read-only deploy keys, 1 human × push. Users
  are NEVER asked to host git servers.
- Convergence is per-machine and independent, at local idle; no machine is
  special. Mixed versions are tolerated (PROTOCOL_VERSION, additive
  changes); expand→contract migrations ship one release behind the code
  that needs them.
- No maintainer concept: fork-on-first-self-mod, provision-style
  automation.

## 19. Cloud stack (CF-first, all BYO via wrangler deploy)

- **Relay → per-user Durable Object**: machines dial out wss; deletes
  tunnel + local relay + gateway. E2E keeps it blind; frame chunking
  already fits the 1MB WS cap. GATE: DO pricing math before commitment.
- **R2** = artifact blobs + durable share links (Worker validates token →
  short-lived R2 URL) + session mirrors.
- **D1** = directory, NEVER authority: machines disagree → machine wins.
  Machines never speak SQL to D1 — the Worker owns schema; migrations are
  atomic with deploy.
- **Artifacts cross-machine with nobody hosting git**: objects =
  bundles/packfiles → R2 (Worker stores bytes only); refs = name→sha CAS
  in the DO (~20 lines); possession = single writer, so CAS only contends
  at rollup. GitHub `-artifacts` repo demoted to optional export. A move =
  final bundle push + fetch.
- **Pi session mirrors**: append-only JSONL → segment objects in R2 +
  manifest CAS in the DO, at turn-settle, async. Replica NEVER authority;
  client-side encrypted (sealed to user root key); unit = the session
  directory (nested subagent JSONLs). Filesystem-level, below the SDK — no
  OMP support needed. Enables transcript-reads-despite-wedged-worker,
  move/resume, local eviction.
- **Auth/settings sync**: adopt OMP auth-broker (one authority + read-only
  mirrors; refresh tokens never leave the broker) ≈ delegate v0 done
  upstream. Panel settings sync via D1 KV LWW per scope (repo config =
  defaults; synced prefs shadow; session overrides local);
  credential-flagged keys excluded; history/stats stay home.
  Settings-sync = extension canary #1 (daemon + cloud legs; SPI =
  onSettingChanged/applySetting/nudge; extensions may own Worker routes,
  routes private to the extension).
- **App-backed integrations** (Checks API is App-only; delegate tokens) =
  hosted paywall tier. The GitHub App today is only the device-flow login
  client.

## 20. Space SDK v1, broker adoption, skinny events

- **Space SDK v1**: typed `space.*` namespace in the eval kernel,
  eval-only first; NO CLI cutover (CLI stays a thin frontend over the same
  daemon API). `space.processes.*` backed by the OMP broker day one;
  processes.jsonc names = broker names, pinned before step 1. The old proc
  path dies by attrition, then delete runner/watchdog/scheduler.
- **Placement**: consumers (log tails→events, xterm-headless per PTY,
  port/hostname registries, panels) = daemon side; the SDK stub = worker
  side, stateless RPC to the daemon. Broker discovery = deterministic
  wyhash socket paths, connect-if-exists.
- **Keep our correlated event system** — the broker has only pull
  primitives (logs/wait/ready), no push/classify/wake pipeline. Broker
  owns bytes; we own meaning.
- **tmux-lite rip-out (directional)**: the daemon stops owning PTYs and
  becomes viewer/coordinator over broker-held PTYs (= the PTY-holder plan
  for free; terminals survive flips). Make-or-break spike: broker
  raw-stdin latency for interactive input. Agent-opened PTYs appear under
  Terminals; attach/send behind a per-workspace capability grant (same
  policy line as the browser-relay port).
- **Skinny events principle**: "push facts, pull bytes." Transcript live
  deltas by block id + focused-pane expanded subscription; payloads
  truncate-with-handle; snapshots → change events + on-demand fetch.
  Evidence: 4.7GB renderer peak measured from snapshot churn (0.74MB
  encrypted frames ~1/sec); daemon-side snapshot debounce is the cheap
  forerunner. Images are the fattest payloads — thumbnail inline, full on
  expand (rider on the transcript-images ticket, #146).
- **omp-via-RPC without patching** (plausible): prize = zero patches →
  stock worker binary → workers stop dying at our flips. Deliverable = one
  table (every patch + createAgentSession arg: stock-expressible /
  upstream-PR / must-keep), produced during the bump patch re-apply.

## 21. Build spine (each step is the test harness for the next)

1. OMP bump 17.2.4 → 18.0.6 (edit-tool infinite-loop fix #7437,
   stale-job wait-forever #8634, late-cleanup settle #7488; browser-relay,
   the global broker, large-session restoration improvements, and stable-row
   transcript APIs included). Produce the patch/RPC table; re-verify report
   capture end-to-end (broken silently twice).
2. Skinny events + payload truncation (+ snapshot debounce forerunner).
3. Space SDK v1 + broker adoption (incl. raw-stdin spike).
4. Flip machinery (§17's four items) → Promote v0.
5. Dev mode (§16) → the board takes over (monorepo re-org as
   replacement-map packages, named agents + cron + inbox, FTUE probes,
   tmux-ectomy, settings-sync extension, isolinear).

Cloud track runs parallel: Worker skeleton → ref-CAS + R2 artifacts →
share links → relay-DO (pricing math FIRST) → session mirrors → D1
directory → workspace email (§15).

## 22. Ticket operations (execute one by one, in order)

Already done this session: #135 (OS sandbox), #136 (delegate),
#126 comment (backendKey).

1. Land this document (approval gate for everything below).
2. Close #112 as superseded by #126 (comment pointing here).
3. Comment on #126: drain doctrine rider — workstream A scope change
   (workers always drain+die via pause gate; survivors = holders + broker;
   durable inbox/runtime store; `restart --into`; Promote UI + asset-skew
   reload; gates as drain points). References §10–§11.
4. Rewrite #131 (hub spike → adoption): broker under space process,
   workspace namespace, one-owner rule, delete tmux proc path + watchdog.
5. Comment on #130: collab findings (§12).
6. Comment on #127: gooey schedules UX reference.
7. NEW "Lifecycle v2: effect-target phases" (§7). Keystone.
8. NEW "Bundle v2: fleet contract + setup SDK + preflight" (§8).
9. NEW "Bindings + derived .env" (§7; may fold into 7 at filing time).
10. NEW "Bug: process watchdog/autostart have no callers" (restart.policy
    inert; resolution likely = delete in favor of broker, ties #131).
11. NEW "Side agents: read-tier + .sessions local:// binding" (§6).
12. NEW "GitSpace Access: authenticated ingress for hosted routes" (§8).
13. NEW "Seat routing: process open at the seat" (§8).
14. NEW "Hermetic B instance: gssh dev up + single-B lease" (§11).
15. NEW "UX adoptions umbrella" (§13).
15b. NEW "Runtime dropdown in AgentPaneHeader: live agents
    (model/state/context) + hub daemons per backend" (§13). Grows into
    B3's registry view.
16. NEW "Hygiene: stale local:// comment + ARTIFACT-PROTOCOL Q2" (§3).
17. Track B (filed now, sequenced after #126-A): "Replication: namespaced
    WIP refs" (§10); "Movable harness" (§10, absorbs restart --into if not
    in #126); "Capability registry + placement" (§8–9); "Check lane + GHA
    frontend + App wiring" (§9).
18. Wire existing GitHub App: verify checks:write + deployments:write,
    installation-token minting path (rides the check-lane ticket).
19. NEW "Isolinear codebase display — tier-0 pilot spec" (§14). Also the
    first catalog entry if the spec model proves out.
20. NEW "FTUE + settings pages: shared subsystem probes, cards as wizard
    and as settings" (§13).
21. NEW "Workspace email addresses: receive-only v1" (§15). Sequenced
    after the cloud Worker skeleton + directory exist; files with the
    extension-canary framing.
22. NEW "OMP 18.0.6 bump" (§21 step 1). First mechanical op after this
    doc lands.
23. NEW "Skinny events: push facts, pull bytes" (§20) + snapshot-debounce
    forerunner; absorbs the UI memory-churn evidence.
24. NEW "Space SDK v1 + broker adoption" (§20); includes the raw-stdin
    latency spike as its gate.
25. NEW "Flip machinery: restart verb, recycleIdleWorkers, per-entrypoint
    hashes, asset-skew reload" (§17).
26. NEW "Bug: subagent tool events invisible to host — report capture and
    blame breadcrumbs miss all subagent activity; move both to the
    managed-extension seam" (specimen: ttsc-graph report, 2026-08-19).
27. NEW "Browser-relay from OMP: enable + per-workspace capability grant"
    (§20 policy line; requires op 22 — not present in 17.2.4).
28. NEW "Worker watchdog: wedge detection + heartbeat column in runtime
    dropdown" (two wedged-worker incidents on record; `hub wait` timeout
    failed to fire).
29. NEW "Monorepo re-org as replacement-map packages" (§17/§21 step 5);
    timed after the SDK exists; ideal board + B-instance dogfood ticket.

Sequencing spine: #126-A (as amended) + hermetic B + hygiene make
GitSpace-inside-GitSpace safe → everything else increasingly dogfooded
through the board itself. Codex cloud is suitable for the well-specified,
daemon-free tickets (10, 12 plumbing, 16, parts of 8); GitSpace agents for
everything touching worker/daemon lifecycle or UI.
