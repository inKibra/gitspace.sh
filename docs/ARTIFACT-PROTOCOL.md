# Artifact Protocol — `artifact://` capabilities, enforced capture, and signed share links

Status: ACCEPTED design (2026-07). Supersedes ad-hoc write conventions in the artifacts mounts. Companion to `docs/ARTIFACTS-FS.md`.

---

## Decision summary

**Q1 — Capture enforcement.** Hand-commits in the mount stay ergonomic and become protocol-conformant instead of forbidden: a versioned `#!/bin/bash` pre-commit hook installed once in each project's bare `.artifacts.git` (verified to fire in every current and future worktree mount) auto-converts staged blobs ≥ 2 MiB into blob-store bytes + a git-LFS pointer + a `.gitattributes` line, exactly matching `captureArtifacts` output. Because `--no-verify` bypasses any hook (verified), the hard boundary is a push gate in `syncArtifacts` **and** `rollupArtifacts` that refuses to publish any branch whose new commits contain a raw non-pointer blob ≥ 2 MiB; since gated bytes provably never left the machine, a `repair` command can safely re-commit with conversion. This makes the promise already printed in `space-artifacts/SKILL.md:32` ("Files ≥2MB are stored as LFS-style pointers automatically — commit normally") true as written.

**Q2 — OMP `local://` unification.** Unify as a **scoped, unversioned namespace** of the artifact protocol: back `local://` with the mount via the SDK's sanctioned `localProtocolOptions` DI hook (`createAgentSession`, `sdk.d.ts:175` — no fork), rooting each session at `<mount>/.sessions/<sessionId>/` (the SDK appends `/local`), while keeping `.sessions/` **out of version control** via the bare repo's shared `info/exclude`. Session plans and scratch become addressable (`artifact://<p>/<w>/.sessions/<sid>/local/PLAN.md`) and shareable mid-flight without ever polluting branch history, rollups, or `git status`; curation into the versioned tree is an explicit `promote`. ArtifactManager tool-output overflow (`artifact://<n>` numeric spill) stays transcript-adjacent per `ARTIFACTS-FS.md:57-61` — never mirrored.

**Q3 — Signed share links.** A share link is a read-capability: an Ed25519-signed bearer token in the existing root-invite format (`gssh-share:` + base64url canonical JSON, explicit `expiresAt`, optional `maxUses`), signed by the machine signing key already in daemon memory — no JWT (none exists; the `src/relay/jwt.ts` reference in AGENTS.md is stale). The HTTP surface is `GET /artifact-share/<token>` in the relay's existing `Bun.serve` fetch handler on `<name>.gitspace.sh`, but the relay **never reads disk**: it verifies the token and then delegates over the existing relay pipe to the machine daemon (`artifact-share-read` RPC), which independently re-verifies, checks the revocation ledger, jails the path, and streams **resolved** bytes through `readArtifactResolving` (LFS pointers served as content from `.artifacts-blobs`). Identical behavior on co-located and split/self-hosted topologies; the relay's zero-knowledge stance is relaxed only per explicit share, per request.

---

## The protocol

### URI scheme

```
artifact://<project>/<workspace>/<relpath>
```

- `<workspace>` is a workspace name or `@base` (the project base clone's main mount).
- The mount base directory is always resolved **server-side** from the project/workspace segments (`artifactsMountDir(getWorkspacePath(...))`); clients never supply a path prefix.
- `<relpath>` is validated with `assertSafeRelPath` semantics (`src/core/artifacts.ts:182-186`): no absolute paths, no empty/`.`/`..` segments.
- Session namespace: `artifact://<p>/<w>/.sessions/<sessionId>/local/<name>` ≡ that session's `local://<name>`. `.sessions/` is git-excluded (unversioned but addressable).
- No new agent-facing scheme is taught for writes — the mount path is the address; `local://` and `artifact://<n>` remain OMP-internal.

### Capability record

Canonical sorted-key JSON, Ed25519-signed by the machine signing key, domain separator `gitspace-artifact-cap-v1` (pattern from `device-cert.ts:25-27`), serialized as `gssh-share:` + base64url (format from `root-invites.ts`):

```json
{
  "v": 1,
  "tokenId": "<random 128-bit>",
  "sub": { "kind": "session" | "trigger" | "user" | "link", "id": "..." },
  "verbs": ["read" | "write" | "share"],
  "scope": ["artifact://<p>/<w>/<glob>", "..."],
  "machineId": "...",
  "expiresAt": 1234567890000,
  "maxUses": 1,
  "sig": "..."
}
```

One canonical glob matcher lives in `src/core/artifact-cap.ts`; the bash hook's scope check is generated from it so the two implementations cannot diverge.

In-process producers (`triggers.ts`, `phase-journal.ts`, `review-guide.ts`, `goal-chain.ts`, `goal-validation.ts`, `edit-breadcrumbs.ts`) hold **compile-time ambient caps**: their scopes (`triggers/**`, `journal/**`, `review/**`, `goal.md`+`rubric.json`, `validation/**`, `blame/**`) are declared in one table in `artifact-cap.ts` — an auditable registry, not runtime checks.

### Daemon RPCs (`src/lib/tmux-lite/server.ts`)

Replacing `artifacts-read` / `artifacts-write` / `project-artifacts-read` / `project-artifacts-write` (clean cutover — the web UI ships embedded in the daemon, single deploy unit):

| RPC | Behavior |
|---|---|
| `artifact-read { uri }` | `readArtifactResolving` (pointer→blob resolution, 25 MB cap for UI reads) |
| `artifact-write { cap?, uri\|files[], message? }` | verify cap sig+expiry+verb+glob when present; provenance derived from `cap.sub` (session/goal/trigger keys, tool from `sub.kind`) instead of bare `{tool:'web-ui'}`; delegates to `captureArtifacts` — which remains the **only** commit constructor |
| `artifact-list { uriPrefix }` | list mount contents (lazily `ensureArtifactsMount`s, as today) |
| `artifact-share-mint { uri, ttl, maxUses? }` | returns `https://<name>.gitspace.sh/artifact-share/<token>`; requires `share` verb — trigger caps cannot mint links |
| `artifact-share-revoke { tokenId }` / `artifact-share-list` | ledger operations |
| `artifact-share-read { token }` *(relay-pipe only)* | machine-side streamed read backing the public share route |

### CLI (`registerSpaceArtifactsCommands` in `src/cli/commands/space.ts`)

Follows the eleven existing `registerSpaceXxxCommands` (`space.ts:75-100`); context via `requireSessionContext` (`space.ts:54-66`):

```
gssh space artifacts commit <paths...> -m <msg>     # capture + provenance; enforces GSSH_ARTIFACT_CAP scope if set
gssh space artifacts promote <local://uri|path> <dest-relpath>   # bridge from session scratch
gssh space artifacts share <relpath> [--ttl 7d] [--max-uses N] [--attachment]
gssh space artifacts share list | share revoke <tokenId>
gssh space artifacts repair                          # safe pointer-conversion of gated (never-pushed) commits
```

`promote` accepts `local://` URIs directly: OMP's `bash-skill-urls` rewriting (`bash-skill-urls.ts:171`, verified at pi-coding-agent 16.3.4) resolves the URI to a real filesystem path before the CLI runs — zero extra plumbing for the agent-facing bridge, with a plain-path fallback for non-bash callers.

### Enforcement rings (summary)

1. **Advisory/ergonomic — commit time.** Bare-repo pre-commit hook: pointer auto-convert ≥ 2 MiB; cap-glob check when `GSSH_ARTIFACT_CAP` is present. Post-commit hook stamps hand-commit provenance notes.
2. **Mechanical — daemon boundary.** RPC/CLI writes carry caller identity; cap scopes enforced hard in `captureArtifacts`' front door.
3. **Hard/bypass-proof — publish time.** Push gate in `syncArtifacts` and `rollupArtifacts`: no raw ≥ 2 MiB blob ever leaves the machine or reaches `main`.

---

## Capture enforcement design (Q1)

### Verified git semantics this design rests on (all experimentally confirmed, git 2.43)

- A pre-commit hook placed **only** in `<projectDir>/.artifacts.git/hooks/` fires for commits made inside every worktree mount — including mounts created **after** hook install. Hook resolution goes through the git common dir (`GIT_DIR` during the hook is `<bare>/worktrees/<mount>`, which has no hooks dir). One install point covers all current and future mounts, including `@base`. No `core.hooksPath` needed (nothing in the codebase sets one today).
- Staged sizes must be measured with `git rev-parse ":$path"` + `git cat-file -s` (works under `commit -a` temp indexes); `git diff --cached --numstat` is unusable — binaries report `-`.
- Full index rewrite inside pre-commit works end-to-end: `git hash-object -w` the pointer, `git update-index --cacheinfo 100644,<sha>,<path>`, rewrite the working-tree file, stage the `.gitattributes` `filter=lfs` line. The landed commit contains the 132-byte pointer; status is clean afterward, for both `git commit` and `git commit -a`.
- The swapped-out raw blob stays in the local odb but is **unreachable**, so `git push --all` never ships it.
- `git commit --no-verify` bypasses the hook entirely (raw 2.1 MB blob landed). Hooks are ergonomics + safety net, not a security boundary.
- Pathspec commits (`git commit -- <file>`) land the pointer in the commit but leave the raw blob in the real index (`MM` status; self-heals on next add). Accepted, documented wart — the hook cannot safely touch the real index during a partial commit.
- The hook **must** be `#!/bin/bash` (dash broke on `read -d ''` and silently let raw bytes through with exit 0) and **must verify the blob-store write landed before `update-index`**, aborting the commit otherwise (observed silent byte-stranding in the odb on store failure).
- git-lfs is **not** installed and must not be: the `filter=lfs` attributes capture writes are inert locally, which is precisely why pointer checkouts work. Installing real git-lfs would fork blob storage into `<bare>/lfs/objects` and break worktree-add smudge against a nonexistent endpoint.

### Mechanism

**Hook install** — `ensureArtifactsRepo` (`src/core/artifacts.ts:65-71`) gains an idempotent, versioned install of two hook scripts into `<projectDir>/.artifacts.git/hooks/`, embedded as template strings with the absolute project dir and `.artifacts-blobs` path baked in at install time (hooks run with cwd inside the mount). Install is write-if-changed keyed on a `# gssh-hook-vN` header — content comparison, not existence. Because `ensureArtifactsRepo` is re-run by every `ensureArtifactsMount` call (`artifacts.ts:121-133`), all existing projects self-migrate on next mount touch, and second machines adopting a repo via `.gitspace/artifacts.json` (`session-lifecycle.ts:321-342`) get hooks automatically — hooks do not travel with clone, so install living in repo creation is load-bearing. The tmux-lite daemon additionally exposes a status check that the installed hook hash matches expected, because a hook regression **fails open**.

**pre-commit** (~150 lines bash):
1. For each staged path: `git rev-parse ":$p"` → `git cat-file -s`. Files < 2 MiB: pass untouched — the fast no-op path that keeps small-text hand-edits (the SKILL-taught `git add -A && git commit`) at zero friction, and lets `captureArtifacts`' own commits pass by construction (pointers are < 400 B; capture uses no `--no-verify`, and none is added — one mechanism, no bypass env var for size discipline).
2. Files ≥ 2 MiB: sha256 the content, copy to `<projectDir>/.artifacts-blobs/<2-hex-shard>/<oid>`, **verify** the blob landed (abort non-zero on failure), then `hash-object -w` the LFS pointer, `update-index --cacheinfo` it over the raw blob, rewrite the working file, append + stage the `.gitattributes` line.
3. If `GSSH_ARTIFACT_CAP` is set in the committing environment: reject staged paths outside the cap's scope globs (check generated from the canonical matcher in `artifact-cap.ts`).

**post-commit** (~40 lines bash): attaches the standard provenance git-note `{tool:'hand-commit', session: $GSSH_SESSION_ID?, trigger: $GSSH_TRIGGER_ID?}` so hand-commits stop being provenance-blind. Skipped when `GSSH_ARTIFACTS_CAPTURE=1` — set on the `git commit` env by `captureArtifacts`/`captureArtifactsSync`, which attach their own richer notes.

**Push gate** — in `syncArtifacts` immediately before `git push origin --all` (`artifacts.ts:568`), and **also in `rollupArtifacts`** (`artifacts.ts:425-463`) before merging a workspace branch into `main` — otherwise a `--no-verify` blob committed between 5-minute sync ticks (`server.ts:603-630`) could reach `main` before any gate sees a push. Scan is incremental: `git rev-list --objects <branch> --not --remotes=origin | git cat-file --batch-check`; any non-pointer blob ≥ 2 MiB blocks that branch/rollup and raises an **inbox notification** (silent stalls on a single-writer branch are the top agent-confusion risk).

**Repair** — `gssh space artifacts repair`: because the gate guarantees the offending bytes never left the machine, it can safely soft-reset and re-commit the never-pushed commits with pointer conversion. This is the only sanctioned history modification; general daemon-side rewrite stays off the table (sha churn under live mounts, non-ff pushes, rollup merges embedding old shas — all verified dangers).

**Closing the last out-of-band writer** — `backfillLfsAttributes` (`src/core/artifacts-github.ts:108-118`) is rewritten onto `captureArtifacts`, deleting the only committed mount write that bypasses capture today.

### Files changed

| File | Change |
|---|---|
| `src/core/artifacts.ts` | hook templates + versioned install in `ensureArtifactsRepo`; push gate in `syncArtifacts`; gate in `rollupArtifacts`; `allowedWrites` scope check beside `assertSafeRelPath`; `GSSH_ARTIFACTS_CAPTURE=1` on capture commit env |
| `src/core/artifacts-github.ts` | `backfillLfsAttributes` → `captureArtifacts` |
| `src/core/artifact-cap.ts` (new) | cap record, canonical glob matcher, mint/verify, ambient-cap registry |
| `src/cli/commands/space.ts` | `registerSpaceArtifactsCommands` (commit/promote/share/repair) |
| `src/lib/tmux-lite/agents/skills/space-artifacts/SKILL.md` | line 32's promise is now true — keep it; keep hand-commit teaching; add commit/promote/share/repair verbs |

### CI discipline

A shell test harness mirroring the scratchpad experiments runs the hook against: plain `commit`, `commit -a`, pathspec commit, `--no-verify`, and blob-store-write failure (must abort). The dash failure mode (silent exit-0 no-op) is exactly why this harness is non-optional.

---

## OMP `local://` integration (Q2)

### What the SDK allows (verified in `node_modules/@oh-my-pi/pi-coding-agent` 16.3.4)

- `createAgentSession({ localProtocolOptions: { getArtifactsDir, getSessionId } })` is a sanctioned, published DI hook (`dist/types/sdk.d.ts:175`). The SDK installs it as a process-global override **and** threads it into every tool call's context; subagents inherit it (`task/executor.ts`).
- The SDK hard-appends `/local` to whatever `getArtifactsDir()` returns (`local-protocol.ts:242-253`). You control the parent directory, not the leaf.
- The backend **must be a real directory**: writes/edits/eval/bash resolve `local://x` to a plain path via `resolveLocalUrlToPath` and do ordinary fs I/O (`write.ts:903-934`, `buildEvalUrlRoots`). There is no virtual storage interface, and **no write hook fires** — `LocalProtocolHandler` has no `write()`, and edit/plan internals bypass even a replacement router handler.
- Plan mode makes the working tree read-only and permits writes **only** inside the local sandbox (`plan-mode-guard.ts:128-155`); the local root must stay freely writable plain fs at all times.
- Symlink containment: root/parent/target are realpathed; a worktree-mounted root qualifies (root is realpathed first), files symlinking out are refused.

### Chosen integration

Pass at all three `createAgentSession` call sites — `pi-runtime.ts:271-283`, `pi-backend.ts:126-133`, `pi-coordinator.ts:789-796` — plus the one-line type addition to `OmpModule` (`omp-types.ts:128-141`):

```ts
localProtocolOptions: {
  getArtifactsDir: () => join(artifactsMountDir(workspaceDir), ".sessions", piSessionId),
  getSessionId: () => piSessionId,
}
```

Result: `local://PLAN.md` lives at `<mount>/.sessions/<sid>/local/PLAN.md`, canonically addressable as `artifact://<p>/<w>/.sessions/<sid>/local/PLAN.md` — readable via `artifact-read`, listable in the UI, and shareable via a minted read-cap link **without committing** (share a plan mid-flight). Base-mount sessions (`<project>:@base`) work identically against the base clone's mount.

**Noise control by exclusion, not sweeping**: `ensureArtifactsRepo` appends `.sessions/` to `<bare>/info/exclude` — the common-dir exclude covers all worktrees, the same sharing mechanism the hook experiment verified (precedent: `ensureCodeRepoExcludes`, `artifacts.ts:97-114`). Scratch never enters branch history, rollups, sync, or `git status`; the pre-commit hook never sees these files because they are never staged. Plan mode is preserved **by construction**: no hook, lock, or sync ever touches unstaged `.sessions/` paths — this is a stated invariant any future mount-level mechanism must honor.

**Curation bridge**: `gssh space artifacts promote local://PLAN.md notes/plan.md` — bash-skill-urls resolves the URI to a path before the CLI runs; the CLI captures via `captureArtifacts` with provenance `{tool:'promote', session}`. Promotion is a capability-checked write like any other. Promote is copy-not-move; provenance records the source, and staleness of a still-edited original is a documented non-goal.

**GC**: the SDK has no session-dir GC; the daemon deletes `<mount>/.sessions/<sid>` for ended sessions past a retention window.

**ArtifactManager overflow**: not touched. `adoptArtifactManager` is not called; overflow stays transcript-adjacent per `ARTIFACTS-FS.md:57-61`. Bridge = explicit promote only.

**Typed discovery — scratch has an address but no type.** The artifact taxonomy
(`classifyArtifact`, `src/components/artifact-kinds.ts:19-31`) is a claim the
CURATED tree makes; `.sessions/` never participates. Two guards make this true
(both land in Phase 4, non-optional):

- `listArtifactFiles` (`src/core/artifacts.ts:279-306`) skips `.sessions/` in
  the default walk — otherwise every session's scratch floods the artifact
  rails the day the cutover lands (the walk is filesystem-based; the git
  exclude does not help it).
- `classifyArtifact` short-circuits `.sessions/` paths to a non-curated kind —
  directory-keyed kinds (`reports/`, `notes/`, `evidence/`) are safe by
  construction, but extension-keyed kinds match ANYWHERE: without the guard a
  scratch `ops.dashboard.json` appears in the ph DASHBOARDS sidebar, a scratch
  `.data.json` appears in the dashboard panel's data picker, and scratch
  `.gssh.html` files list as apps.

Promotion is therefore the TYPING act, not just the durability act: an agent
drafts `local://draft.report.json`, iterates, shares it mid-flight via a read
cap — and only `promote` to `reports/draft.report.json` makes it a report to
feeds, rails, and rated precedents. Deliberate scoped surfacing (e.g. the ph
agent-thread pane listing its own session's working docs) is a welcome future
feature; accidental global leakage is not.

### Honest limits

- The process-global `LocalProtocolHandler.setOverride` is last-writer-wins in the one-process multi-session daemon. All tool traffic is correct via per-tool-call context threading (the documented fix for upstream #1608); only context-less paths (TUI hyperlink resolution) can resolve against the wrong session's mount. Low impact; noted for follow-up.
- No per-write events exist, so there is no write-granularity provenance for session scratch — and none is needed, since scratch is unversioned; provenance begins at promote/commit.
- Session scratch lifetime is coupled to the mount: workspace removal deletes live sandboxes. `SessionManager.moveTo` and the win32 ≥ 180-char `$TMPDIR` fallback are un-exercised in this configuration (Linux daemon only today); guard if paths deepen or Windows hosts appear.
- Existing sessions under `~/gitspace/.pi/sessions/*/local` keep their old roots until reopened; reopened sessions start with an empty local root, which matches `local://`'s scratch semantics. No copier, no shim.

---

## Signed share links (Q3)

### Token

A share link is a `link`-subject read capability, exact-path scope:

```
gssh-share:<base64url(canonical sorted-key JSON)>
{ v:1, tokenId, sub:{kind:'link'}, verbs:['read'],
  scope:['artifact://<p>/<w>/<exact-relpath>'],
  machineId, expiresAt, maxUses?, sig }
```

- Ed25519-signed with the **machine signing key** already in daemon memory (`serve.ts:575-589`), domain separator `gitspace-artifact-share-v1`.
- Format and canonicalization reuse `root-invites.ts` (prefix + base64url + `expiresAt`/`maxUses`) — the idiomatic prior art. **Not JWT**: no JWT module exists anywhere; AGENTS.md's `src/relay/jwt.ts` row is stale and gets deleted.
- Explicit `expiresAt` (default 7 d) — `signing.ts`'s 5-minute drift window is for messages, not links.

### Endpoint placement and byte path

**Public route**: `GET /artifact-share/<token>` added to the relay's `Bun.serve` fetch handler (`src/relay/server.ts:639-796`), which already serves plain non-WebSocket HTTP (`/health`, `/__enroll`, static UI) through the hosted Cloudflare tunnel. Inherits the existing posture: Host-header guard (`:663-679`), IP rate limiter, `Cache-Control: no-store` (the `/__enroll` discipline, `:712-737`). Behind the tunnel all requests arrive from loopback, so the token is the entire access control — hence exact-path scope, short TTL, optional `maxUses`. Link URL: `https://<name>.gitspace.sh/artifact-share/<token>` — no new hostname provisioning, works day one.

**The relay never reads disk.** It verifies the token signature against the machine's registered public key and checks expiry, then issues a machine pipe RPC `artifact-share-read { token }` over the established machine WebSocket (`relay/pipes.ts`) and streams chunked frames to the HTTP response. This makes the link genuinely **daemon-served** and identical across co-located and split/self-hosted topologies — no `machineId`-mismatch 404 fragmentation, and the relay's zero-knowledge stance is relaxed only per explicit share, per request.

**Machine side** (`artifact-share-read` handler in `src/lib/tmux-lite/server.ts`):
1. Independently re-verify the token (defense in depth — the daemon trusts its own key, not the relay).
2. Check the revocation ledger; enforce `maxUses` (atomic increment — the single daemon process owns the ledger, so the counter is serialized in-process and persisted; no cross-process race exists).
3. Resolve the mount dir server-side from the token's project/workspace; `assertSafeRelPath` the relpath; require it to match the cap scope exactly.
4. Serve **resolved** bytes: `readArtifactResolving` (`artifacts.ts:336-350`) swaps LFS pointers for blob-store content; blobs above the 25 MB RPC ceiling stream directly from `<projectDir>/.artifacts-blobs/<shard>/<oid>` via chunked pipe frames (the existing base64 `artifact-read` stays for UI reads). Falls back to the ArtifactBlobFetcher (GitHub LFS batch, gh token) for blobs absent locally.

**Response hardening**: `Content-Type` from an extension allowlist; unknown types forced to `application/octet-stream` + `Content-Disposition: attachment` (kills stored-XSS via shared HTML on the gitspace.sh origin); `X-Content-Type-Options: nosniff`; `Content-Disposition: inline` only for the allowlisted html/md/image types so shared dashboards render; `Cache-Control: no-store`.

**Bonus path (unchanged priority)**: when the file is a pointer and the GitHub tier is configured, the daemon may answer with the LFS presigned batch href and the relay 302s — an optimization, never the primary mechanism.

### TTL, revocation, minting

- Revocation ledger: daemon-owned JSON store (`~/gitspace/.serve/artifact-shares.json`: `tokenId → {uri, mintedBy, createdAt, revokedAt?, useCount, maxUses?}`), checked on every request. Bearer tokens cannot be un-signed, so revocation is a deny-list; the store doubles as the audit log and `share list` source. **Fail-closed**: ledger loss revokes every outstanding link (safe; breaks shared URLs, acceptable).
- Minting: `artifact-share-mint` RPC / `gssh space artifacts share <relpath> --ttl 7d [--max-uses N] [--attachment]` / UI Share button on artifact panes (and on `.sessions/` files — the mid-flight plan share). Minting requires the `share` verb, so trigger caps cannot mint links.

---

## Trigger `writes` enforcement tie-in

`TriggerRecord.writes` (`triggers.ts`) became a real capability with **no schema change** — implemented (Phase 3) with one adjustment forced by ground truth:

**SDK gap (discovered at implementation)**: `createAgentSession` exposes no per-session ambient environment, and the bash tool's `env` is per-invocation (model-supplied) — so the designed `GSSH_ARTIFACT_CAP`/`GSSH_TRIGGER_ID` env injection is NOT possible today. Upstream ask filed conceptually; until then the cap rides the RUN PROMPT and the hard ring moved down a level:

1. **Mint + deliver**: the scheduler and run-now RPC mint a write-cap `{sub:{kind:'trigger', id}, verbs:['write'], scope}` signed with a dedicated machine-local keypair (`artifact-cap-key.ts`, 0600 under the identity dir — share links in Phase 5 bind to the REGISTERED machine key instead) and include the token in the run prompt with usage instructions.
2. **Mechanical enforcement where the token flows**: `artifact-write` RPC and `gssh space artifacts commit --cap` verify the signature (fail closed) and enforce the scope globs; verified subjects drive provenance.
3. **Hard backstop for raw git** (the ring that catches everything): each run records `startCommit` at pending; on completion `completeTriggerRun` diffs the run window, skips commits whose provenance note names a DIFFERENT session/trigger (protects concurrent attributed writes; single-writer branches otherwise), reverts out-of-scope changes with a forward-fix commit (safe pre-push), records the run **failed** with the reverted paths, and raises an inbox notification.
4. The pre-commit hook's cap check (advisory ring) is DEFERRED until per-session env exists — without env there is nothing session-scoped for the hook to read.

Honest grading, stated in the docs and prompts: size/pointer discipline is hard-enforced at the push gate for everyone; path scopes are hard-enforced on the token-carrying RPC/CLI channel and detect-and-reverted for raw git. Prompts say "enforced write scope … automatically reverted", which is now literally true.

---

## Phased implementation plan

Clean cutover, six independently shippable phases, no shims. Enforcement floor lands **before** any skill-text change (so the SKILL's pointer promise is never a lie in either direction).

**Phase 1 — Hooks + gates (enforcement floor).**
Files: `src/core/artifacts.ts` (hook templates + versioned install in `ensureArtifactsRepo`; push gate in `syncArtifacts`; gate in `rollupArtifacts`; `GSSH_ARTIFACTS_CAPTURE` env), `src/core/artifacts-github.ts` (`backfillLfsAttributes` → capture), inbox surfacing for gate refusals. `gssh space artifacts repair` ships in the same commit so a gated branch is immediately fixable.
Size: ~200 lines bash (embedded), ~200 lines TS.
Verification: CI shell harness (commit / `commit -a` / pathspec / `--no-verify` / blob-store-failure abort) mirroring the scratchpad experiments; manual: hand-commit a 3 MB file in a live mount, confirm 132-byte pointer in `ls-tree`, clean status, blob present in `.artifacts-blobs`; commit a raw blob with `--no-verify`, confirm sync tick refuses the branch, inbox item appears, `repair` fixes and next tick pushes.

**Phase 2 — Capability core + RPC cutover.**
Files: `src/core/artifact-cap.ts` (new, ~200 lines), `src/lib/tmux-lite/server.ts` (delete four old RPCs, add `artifact-read/write/list/share-mint/share-revoke`, ~150 lines), UI call sites `src/app.web.tsx` / `src/pages/ProjectHomePage.web.tsx` / `src/components/DashboardPanel.web.tsx` (~60 lines). `artifact-write` provenance enriched from `{tool:'web-ui'}` to `{session, goal, trigger}`.
Size: ~400 lines TS.
Verification: typecheck; dashboard create/edit and trigger-panel persist round-trip through the new RPCs; git-note on a UI write shows session provenance. Restart the tmux-lite daemon and hard-refresh (daemon caches server code; breaking rename is a single deploy unit).

**Phase 3 — CLI verbs + trigger enforcement.**
Files: `src/cli/commands/space.ts` (`registerSpaceArtifactsCommands`, ~250 lines), `src/core/artifacts.ts` (`allowedWrites` param, ~40 lines), `src/lib/tmux-lite/trigger-scheduler.ts` + `src/app.web.tsx` (cap mint + `GSSH_ARTIFACT_CAP`/`GSSH_TRIGGER_ID` injection, prompt rewording, ~60 lines), `src/core/triggers.ts` (`recordTriggerRun` post-run diff/revert with note-based attribution, ~100 lines), `src/lib/tmux-lite/agents/pi-runtime.ts` (export `GSSH_SESSION_ID` into agent shells for the post-commit note).
Size: ~450 lines TS.
Verification: run a trigger with `writes: ['reports/**']`; confirm the CLI refuses an out-of-scope path, the hook rejects an out-of-scope raw commit, and a `--no-verify` out-of-scope commit is reverted + flagged by `recordTriggerRun`.

**Phase 4 — OMP `local://` cutover.**
Files: `src/lib/tmux-lite/agents/omp-types.ts` (one-line `localProtocolOptions` type addition), `pi-runtime.ts` / `pi-backend.ts` / `pi-coordinator.ts` (option at all three call sites, reopen path included so resumed sessions keep the same root), `src/core/artifacts.ts` (`.sessions/` → `<bare>/info/exclude` in `ensureArtifactsRepo`; retention-window GC of dead session dirs; `listArtifactFiles` skips `.sessions/`), `src/components/artifact-kinds.ts` (`classifyArtifact` short-circuits `.sessions/` paths — see "Typed discovery" above; without both guards, scratch floods the rails and extension-keyed kinds leak into curated surfaces).
Size: ~100 lines TS.
Verification: open a session, write `local://PLAN.md`, confirm the file at `<mount>/.sessions/<sid>/local/PLAN.md`, `git status` clean in the mount, plan mode writable while tree read-only; reopen the session and confirm the same root; subagent sees the parent's local files; write a scratch `x.dashboard.json` via `local://` and confirm it does NOT appear in the ph DASHBOARDS sidebar or the artifacts rail.

**Phase 5 — Share links.**
Files: `src/core/artifact-share.ts` (new: mint/verify/ledger, ~250 lines), `src/relay/server.ts` (`GET /artifact-share/` verify + pipe-delegate + stream, ~120 lines), `src/lib/tmux-lite/server.ts` (`artifact-share-read` pipe handler with chunked streaming, ~200 lines), CLI share verbs (~80 lines), UI Share button.
Size: ~650 lines TS.
Verification: mint a link for a 30 MB captured file (a pointer in the mount); `curl` the public URL and confirm resolved bytes, correct Content-Type, `no-store`, `nosniff`; revoke and confirm 404; expire and confirm 404; confirm an unknown extension arrives as `attachment`. Restart both daemon and relay.

**Phase 6 — Docs made true.**
Files: `src/lib/tmux-lite/agents/skills/space-artifacts/SKILL.md` (line 32 stays — now true; hand-commit teaching stays; add commit/promote/share/repair; add "Promoting session work" section), `docs/ARTIFACTS-FS.md` ("Relationship to OMP" updated: scoped-unversioned unification + promote; overflow never mirrored), `AGENTS.md` (delete stale `src/relay/jwt.ts` row).
Verification: doc review; grep that no skill still describes unenforced behavior.

Rollback per phase: hook uninstall = version-header delete on next ensure; RPC cutover = revert the single deploy unit; `local://` = drop the option (sessions revert to transcript-adjacent roots); share = remove route + handler.

---

## Rejected alternatives

**Full unification of session scratch into version history ("SpaceFS" / unify-max).** Backing `local://` with the mount *and* committing it via a turn-end sweep puts every session's PLAN.md and scratch into workspace-branch history, then needs a nonstandard `sessions/`-stripping rollup merge, a GC policy for unbounded branch growth, and serialization for index-lock contention among four concurrent committers — all to obtain durability that scratch, by its own semantics, does not want. Its redirect of ArtifactManager overflow into the mount was the least-verified piece of any design and contradicts `ARTIFACTS-FS.md:57-61`. The `.sessions/` + `info/exclude` approach delivers the same addressability and mid-flight shareability with none of that machinery. (Its pipe-delegated share byte path was correct, and is adopted here.)

**Strict separation with promote-only bridge ("bridge-clean").** Keeping `local://` at its default transcript-adjacent roots is the smallest diff, but it under-answers Q2: session plans stay invisible to the UI and unshareable until an agent remembers to promote, and its strongest objections to mount-backing dissolve on the ground truth — the "uncommitted dirt in git status" problem is fully solved by one `info/exclude` line, and the process-global override hazard is mostly theoretical given per-tool-call context threading. Its v1 share also 404'd on split relays. Its operational discipline (hook versioning + CI harness, rollup gating, bash-skill-urls promote, response hardening, inbox notifications) is adopted wholesale here.

**JWT-based share tokens.** No JWT module exists in the repo (the AGENTS.md reference is stale); introducing one is new surface with no benefit over the proven root-invite shape (prefix + base64url canonical JSON + Ed25519 signature + explicit `expiresAt`/`maxUses`), which the codebase already knows how to sign, canonicalize, and verify.

**Installing real git-lfs / custom clean filters.** Installing git-lfs would activate the `filter=lfs` attributes capture already writes, diverting bytes into a second blob store under `<bare>/lfs/objects` (diverging from `.artifacts-blobs`) and breaking worktree-add smudge against a nonexistent LFS endpoint. A custom clean filter pointed at the gitspace store is feasible in principle (bare-repo config is shared across worktrees) but untested, harder to version than a hook, and cut for blast radius.

**Daemon-side history rewrite on the sync tick.** Detection is cheap, but rewriting changes shas on branches live-checked-out as worktree mounts (mount HEAD reset under a possibly mid-commit agent), makes previously-pushed branches non-fast-forward, and rollup merges permanently embed pre-rewrite shas. Only two daemon-side mechanisms are safe and both are used: refusing at the push/rollup gate, and `repair`'s rewrite of provably-never-pushed commits.

**Daemon-owned HTTP listener via the hosting serve-tunnel for shares.** Architecturally pure (bytes never transit the relay process at all), but it requires tmux hosting plus locally-managed serve-tunnel credentials to be configured, adds hostname provisioning via an authenticated gitspace.sh API round-trip, and fragments the feature by topology. The pipe-delegation design achieves the same "relay never reads disk" property on the hostname users already have. Kept as a possible future home if share traffic ever needs to bypass the relay process entirely.

**Cloudflare gateway worker.** Specification-only, explicitly not implemented (`docs/GATEWAY-WORKER.md`), and it contradicts the locked decision that the machine has all bytes locally. At most a future vanity/redirect layer.
