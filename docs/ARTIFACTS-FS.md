# Artifacts FS

Durable, versioned artifact storage for gitspace projects — demos, screenshots,
goal-validation evidence, eval reports, and any other proof-of-work that agents
and humans produce while working in a workspace.

**Status**: design accepted 2026-07 · local foundation not yet implemented.

---

## Why

- Artifacts today have no home: demo videos and screenshots land in the code
  repo root, goal evidence hides in `.gitspace/goals/validation/`, and OMP's
  session artifacts are just tool-output overflow storage that dies with the
  session.
- Big binaries do not belong in the code repo (history bloat, review noise).
- Artifacts need to **outlive workspaces** (evidence backs judged reviews),
  **sync across machines**, and eventually **share/publish**.

## Model

**One artifacts git repo per project. One branch per workspace. Roll-up = merge.**

```
~/gitspace/<project>/.artifacts.git      ← bare artifacts repo (one per project)
  main                                   ← long-lived project artifacts ("base")
  <workspace-name>                       ← branched off main at workspace creation

<workspace>/.gitspace/artifacts          ← `git worktree add` of its branch (gitignored)
base/.gitspace/artifacts                 ← worktree of main
```

- A workspace is **a code branch + an artifacts branch**. Same lifecycle, same
  mental model.
- Workspace creation branches `<name>` off `main` and mounts it via
  `git worktree add` at `.gitspace/artifacts`. (Branch-per-checkout is what
  makes worktree mounts legal — git forbids the same branch checked out twice.)
- **Capture** = commit on the workspace's artifacts branch. Provenance
  (`{session, goal, chain, tool}` ids) rides in **git-notes**, so metadata never
  mutates content commits.
- **Freshen** = merge `main` into the workspace branch (like updating a code
  branch against base).
- **Roll-up** = merge the workspace's artifacts branch into `main`, with a
  curation pass in the merge (move keepers to durable paths, drop scratch —
  workspaces can collide on paths and binaries don't merge, so roll-up is where
  curation belongs).
- **Abandon** = delete the branch with the workspace. `main` stays clean.

### Relationship to OMP

- OMP's `saveArtifact`/ArtifactManager is **tool-output overflow spillover**
  (truncated bash/eval output). It is runtime plumbing, not user-facing
  artifacts, and stays where it is (transcript-adjacent). Do not mirror it —
  never store the transcript twice. A read-only "session outputs" listing with
  an explicit *promote to artifacts* action is the only planned bridge.
- OMP's `local://` scheme (session-local durable named docs, e.g.
  `local://PLAN.md`) is the closer spiritual analog: artifacts are **named,
  addressable, durable documents**, scoped to workspace/project instead of
  session.

### Rendering

Chat blocks reference artifacts via `ArtifactRef{kind:'path'}` resolved through
the `.gitspace/artifacts` mount. Preview bytes (video/image) stream over a
daemon HTTP route (path-jailed to the mount), not RPC JSON. The `url` kind is
the remote/published seam — swap the resolver, keep the components.

## Large files: LFS-style pointer split

Raw binaries in the repo are untenable: git history compounds every version
forever, Cloudflare Artifacts caps repos at 10 GB (inherited from the Durable
Object SQLite ceiling — architectural, not negotiable), and Artifacts storage
costs 33× R2 ($0.50 vs $0.015 per GB-month).

**Split structure from weight, from day one:**

- The repo holds the tree, metadata, small files (below a ~2 MB threshold), and
  **standard-format git-LFS pointer files** (content-addressed, sha256) for
  everything bigger.
- Blobs live in a blob store:
  - **Local**: project-level blob dir beside `.artifacts.git` (dedup by hash).
  - **Managed**: R2 behind a thin gitspace.sh LFS endpoint (the LFS batch API
    is just "hand back upload/download URLs" — R2 presigned URLs fit exactly).
  - **BYO**: the user's own LFS endpoint / S3-compatible store.
- Pointers merge like text at roll-up. Deleting branches orphans pointers; a gc
  pass against reachable hashes reclaims blobs.
- Cloudflare Artifacts has **no native LFS today** (design-goal mention only).
  Using the standard pointer format means native support, if it ships, is a
  config change — zero migration.

## Project identity and the backend

**Principle: the backend attaches to projects; it does not own them.** A
project exists fully offline. A backend record is created lazily, on the first
cloud touch (artifacts remote, hosting, sharing) — never by `project add`.

### In-repo configuration (the durable pointer)

A small **committed** file in the code repo — `.gitspace/artifacts.json` — lets
any clone of the code repo rediscover its artifacts (the `.gitmodules` /
`.lfsconfig` pattern):

```jsonc
// gitspace.sh-managed: identity only — backend resolves endpoints.
// Migration-proof; leaks nothing but a slug.
{ "project": "bradleat/gitspace-sh" }

// BYO: explicit endpoints.
{ "remote": "https://git.example.com/me/proj-artifacts.git",
  "lfs": "https://lfs.example.com/proj" }
```

- **Tokens/credentials never live in the repo.**
- Forks inherit the pointer but not access: attach fails on auth → gitspace
  offers to provision the fork's own artifacts repo and rewrite the file (same
  trust model as forked CI config).
- `gssh project add <repo>` reads the file after clone: present → init local
  artifacts repo, add remote, fetch (auth as needed), mount. Absent → init
  empty local artifacts repo; the file is written at provision time (staged as
  a normal commit for review).

### Provisioning tiers

| Tier | Trigger | What exists |
|---|---|---|
| 0 · Local | `project add` (always) | `.artifacts.git` + mounts. No account, no network. |
| 1 · BYO remote | `gssh artifacts remote add <url>` | Their remote, their auth. gitspace never sees bytes. |
| 2 · Managed | `gssh project provision` (explicit, like `host reserve`) | Backend record + CF Artifacts repo + R2 prefix + LFS endpoint + tokens. |

### Backend entities (Tier 2, thin by design)

| Entity | Holds | Where |
|---|---|---|
| Project | `handle/slug`, stable id, settings | D1/DO on the worker |
| ArtifactRepo | CF Artifacts repo ref, token minting | Artifacts API |
| BlobStore | R2 prefix + LFS endpoint | R2 |
| Collaborators | identity pubkeys → read/write grants | existing invite/ACL machinery |
| Quota | storage/ops rollup across repo + blobs | billing hook |

The backend stays a **provisioning/token layer**. Project state (goal chains,
board state, reports, review records) belongs on `main` of the artifacts repo —
versioned, synced, merged with roll-up semantics — not in a backend database.
The artifacts repo is the project's **spine across machines**: machine #2
attaches by cloning the code repo (which carries `artifacts.json`) and
authenticating.

### Cloudflare Artifacts facts (verified 2026-07)

- Repos/namespaces per account: **unlimited**. Per-repo: **10 GB** (DO SQLite
  ceiling). Per-account: 1 TB, raisable. Rate: 2k req/10s per repo.
- Auth: **repo-scoped Bearer tokens** (read | write), minted via Workers
  binding/REST; git via `http.extraHeader`. No SSH. → `gssh` ships a git
  credential helper for `artifacts.gitspace.sh` that exchanges the user's
  session for short-lived tokens.
- **No native encryption story** (standard at-rest/in-transit only) and **no
  native LFS** — both are ours to layer if wanted.
- ArtifactFS (their OSS lazy-hydrating mount, works against any remote) is
  irrelevant locally; interesting later for instant-start cloud sandboxes.
- Public beta ~May 2026; re-verify limits before building Tier 2.

### Encryption posture (open decision)

If "gitspace.sh can't read your artifacts" should match "the relay can't read
your terminals", it is our layer: per-project content key wrapped per identity
(the existing X25519 machinery), file bytes encrypted before commit, paths +
git-notes plaintext so listings work, client-side decrypt (the web app already
does client-side crypto for terminals). Costs: ciphertext defeats git deltas
and server-side preview. Leading candidate: **private-by-default E2E, with
"publish" as an explicit act** that copies selected artifacts to a plaintext
public space. Not yet decided.

## Lifecycle edges

- **Rename**: `handle/slug` is backend identity; the local dir name is free —
  mapping lives in machine-local config.
- **`project remove`**: local delete never implies cloud delete; teardown is
  explicit (`--purge-remote`) with a grace period.
- **Collision/attach**: provisioning a slug that exists prompts "attach to
  existing `<handle>/<slug>`?" — the same flow by which additional machines
  join a project.

## Implementation phases

1. **Local foundation**: lazy `.artifacts.git` init; branch + worktree mount on
   workspace add/select (base mounts `main`); gitignore management.
2. **Capture**: commit-on-write helper with pointer discipline (threshold →
   blob dir + LFS pointer) and git-notes provenance; goal-validation evidence
   becomes the first producer.
3. **Roll-up**: artifacts-branch merge in workspace roll-up; merge-or-drop on
   workspace remove.
4. **UI**: RightRail Artifacts tab (browse mount, pointer-aware previews via
   daemon HTTP route, copy-ref, evidence-block deep links).
5. **BYO remote**: `artifacts remote add`, sync commands, `.gitspace/artifacts.json`.
6. **Managed (post CF public beta)**: provision worker, credential helper, LFS
   endpoint on R2, quotas; encryption decision lands here.
