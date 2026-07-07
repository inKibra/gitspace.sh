# Artifacts FS

Durable, versioned artifact storage for gitspace projects — demos, screenshots,
goal-validation evidence, eval reports, and any other proof-of-work that agents
and humans produce while working in a workspace.

**Status**: local foundation + GitHub sharing implemented (2026-07). Sharing is
GitHub-first: a private `<owner>/<repo>-artifacts` repo with large files on
**GitHub LFS**. The earlier Cloudflare-managed tier (CF Artifacts + worker-minted
tokens + R2 LFS) was designed, built, and then **dropped 2026-07-07** — CF
Artifacts is closed beta with no ship date, while every gitspace machine already
has an authenticated `gh`. GitHub is the managed path.

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
- OMP's `local://` scheme IS unified with artifacts (2026-07, via the SDK's
  `localProtocolOptions` hook): each session's `local://` root lives at
  `<mount>/.sessions/<sessionId>/local/` — addressable as
  `artifact://<p>/<w>/.sessions/…` and shareable mid-flight, but
  **unversioned** (bare-repo `info/exclude`) and **typeless** (list walk +
  `classifyArtifact` skip it). `gssh space artifacts promote` copies scratch
  into the versioned tree — promotion is the typing act. Dead sessions'
  scratch is GC'd after a 14-day retention window.

### Rendering

Chat blocks reference artifacts via `ArtifactRef{kind:'path'}` resolved through
the `.gitspace/artifacts` mount. Preview bytes (video/image) stream over a
daemon HTTP route (path-jailed to the mount), not RPC JSON. The `url` kind is
the remote/published seam — swap the resolver, keep the components.

## Large files: LFS-style pointer split

Raw binaries in the repo are untenable: git history compounds every version
forever, and review/sync costs scale with weight.

**Split structure from weight, from day one:**

- The repo holds the tree, metadata, small files (below a ~2 MB threshold), and
  **standard-format git-LFS pointer files** (content-addressed, sha256) for
  everything bigger. Captures also commit matching `.gitattributes` lines, so
  the repo is a *real* git-LFS repo to any external `git lfs` clone.
- Blobs live in a blob store:
  - **Local**: project-level blob dir beside `.artifacts.git` (dedup by hash).
  - **GitHub**: **GitHub LFS** on the artifacts repo. gitspace speaks the LFS
    batch API directly (auth via the `gh` token) — no `git-lfs` binary needed
    on gitspace machines, while teammates outside gitspace can still
    `git lfs clone` the repo natively.
  - **BYO**: branches sync over plain git; blobs stay machine-local (no blob
    transport — the host would need its own LFS).
- Pointers merge like text at roll-up. Deleting branches orphans pointers; a gc
  pass against reachable hashes reclaims blobs.

## Project identity and the backend

**Principle: the backend attaches to projects; it does not own them.** A
project exists fully offline. A backend record is created lazily, on the first
cloud touch (artifacts remote, hosting, sharing) — never by `project add`.

### In-repo configuration (the durable pointer)

A small **committed** file in the code repo — `.gitspace/artifacts.json` — lets
any clone of the code repo rediscover its artifacts (the `.gitmodules` /
`.lfsconfig` pattern):

```jsonc
// GitHub-provisioned or BYO: an explicit remote URL. github.com remotes get
// blob transport (GitHub LFS) automatically; others sync branches only.
{ "remote": "https://github.com/me/proj-artifacts.git" }
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
| 1 · BYO remote | `gssh artifacts remote add <url>` | Their remote, their auth. gitspace never sees bytes. Branches only — no blob transport. |
| 2 · GitHub | `gssh artifacts provision` (or the ph wizard) | Private `<owner>/<repo>-artifacts` repo, code-repo collaborators mirrored, blobs on GitHub LFS, committed pointer. |

There is **no gitspace.sh backend record** for artifacts — GitHub is the
backend. Project state (goal chains, board state, reports, review records)
belongs on `main` of the artifacts repo — versioned, synced, merged with
roll-up semantics — not in any database. The artifacts repo is the project's
**spine across machines**: machine #2 attaches by cloning the code repo (which
carries `artifacts.json`) and authenticating with its own `gh` login.

### Auth

**Tier 0/1 — gitspace is not in the loop.** Tier 0 has no auth (local bare
repo). Tier 1 uses whatever the user's remote uses (SSH keys, PATs); gitspace
runs plain `git`, stores nothing.

**Tier 2 — GitHub is the single enforcement point:**

- Git pushes authenticate through `gh auth setup-git` (gh's credential
  helper). Blob transfers hit the **GitHub LFS batch API** with the same
  `gh auth token`. gitspace mints nothing and stores nothing.
- Access control = GitHub repo collaborators. Provisioning mirrors the code
  repo's direct collaborators onto the artifacts repo; later changes are
  managed on GitHub like any repo.
- **No lock-in**: it's a normal GitHub repo with normal LFS — `git lfs clone`
  works with no gitspace anywhere.

### Dropped: the Cloudflare-managed tier (2026-07-07)

A full CF-managed tier was built (worker-provisioned CF Artifacts repos,
short-lived repo-scoped tokens minted by the worker, R2 as the LFS blob store)
and then removed before ever deploying: CF Artifacts is a closed beta with no
ship date, the worker added a second auth system for capabilities GitHub gives
us for free, and the standard-LFS pointer format means nothing was lost —
any future host that speaks git + LFS batch is a remote-URL change away.

## Project creation & first-run experience

Projects are born local; every attachment is a later, optional rung. This is
what makes the artifacts design land cleanly: **`project create` is where the
artifacts repo is born**, and the Plan-first flow is where its first contents
(goal, rubric) come from.

### Three ways into a project

1. **From an existing repo** — today's `gssh project add` (GitHub clone via
   `gh`). Unchanged.
2. **From scratch — no repo required.** `gssh project create <name>`
   (+ web "New project" modal):
   - `git init` base repo + initial commit from a **bundle/template**
     (`src/core/bundle.ts` — the existing bundle system is the template layer);
   - `.artifacts.git` initialized alongside (artifacts phase 1 runs here);
   - first workspace created + mounted, session opened;
   - **GitHub is a deferred attachment** — "publish to GitHub" later
     (`gh repo create --push`), same lazy-attach posture as the backend.
3. **From an idea — agent-first.** A prompt ("a metronome app that…") creates a
   from-scratch project and opens a **Plan-stage workspace** with the project
   agent seeded with the idea. The goal chain + rubric it authors live in the
   artifacts repo (exactly what the ProjectHome right rail renders: goal.md,
   rubric.json, evidence, dashboards). Scaffolding happens through the agent —
   the user onboards into a plan, not an empty repo.

### The FTUE staircase (zero accounts → fully attached)

```
install gssh → open UI → "New project" (blank | template | idea)
   → working locally, project agent live          [no GitHub, no gitspace.sh]
→ publish to GitHub                                [when code wants a remote]
→ gssh artifacts provision                         [when artifacts want sync/share]
→ host reserve / invites                           [when collaborating]
```

Every rung is optional and independent — possible only because the backend
attaches rather than owns, and `.gitspace/artifacts.json` is written at
whichever rung first needs it. A from-scratch project has no remote and no
slug until publish/provision mints them.

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
6. **GitHub tier** (done): one-click provisioning (`gssh artifacts provision`
   / ph wizard), collaborator mirroring, GitHub LFS blob transport, 5-minute
   auto-sync in the machine daemon.

## Mini-apps and data artifacts

Mini-apps are self-contained, sandboxed HTML artifacts; data artifacts are
plain JSON. The contract between them is one postMessage:

- **App**: `<name>.gssh.html` — a complete HTML document (inline CSS/JS, no
  external requests; rendered in an `<iframe sandbox="allow-scripts">`). It
  listens for `message` events shaped `{ type: 'gssh:data', data }` and
  re-renders from `data`. Apps must tolerate `data == null` (opened standalone
  with no feed) and repeated messages (data re-picked or refreshed).
- **Data**: `<name>.data.json` or anything under `data/` — arbitrary JSON.
  The SHAPE IS APP-DEFINED; there is no global schema. Example pair:
  `apps/ops-board.gssh.html` expects `{ title, series: [{ label, value }] }`
  from `data/build.data.json`.
- **Binding** happens in two places:
  1. **Dashboards** (`<name>.dashboard.json`): each panel def pins
     `{ app, data, size }` — the canvas reads both artifacts and posts the
     payload on iframe load. Panel edits persist via the artifacts write RPC.
  2. **Standalone open**: opening a `.gssh.html` artifact runs it live with a
     Run|Source toggle and a data picker listing the workspace's data
     artifacts (auto-selected when exactly one exists).
- **Refresh model (planned, plan item 25)**: triggers (cron/event/manual)
  write data artifacts; freshness chips (`⟳ last run`) surface on data rows
  and dashboard panels. Apps never fetch — data always arrives as an artifact
  commit, so every chart state is reproducible from git history.
