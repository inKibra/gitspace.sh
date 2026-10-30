# Account releases: the platform builds, the account decides

Status: agreed (2026-10-30), not built. Mock: `packages/account-web/mock-gitspace-project.html`
(`src/GitSpaceProjectMock.tsx`): the GitSpace project agent asks with a question card when upstream publishes a release
(launch it, or for a fork merge it), when its branch has changes ready to launch, or about a running trial; the sidebar
and Settings → Releases show what the account runs.

## Already in place

- Every account has a GitSpace project (`ensureAccountGitSpaceProject`, role `gitspace-source`). Its repository is a
  normal project repository.
- Its agent has the release tools:
  - `deployment.status`;
  - `deployment.checkCanonical`, which reads the head of `develop`;
  - `deployment.launch`, which builds a workspace checkout or a canonical commit on an attached machine;
  - `deployment.revert` (Back to stable).
- Building means attaching a machine. A launch of a commit the account already built reuses that release.
- Release records keep their source (canonical commit or workspace) and a selection per target (worker, frontend,
  machine).
- Project automations run on a schedule, manually, on GitHub events or on labels.

## Changes

### 1. Canonical is the GitSpace project's own source

`GITSPACE_SOURCE_REPOSITORY` and `GITSPACE_CANONICAL_BRANCH` are constants today, used by `checkCanonical` and the
launcher. They become the GitSpace project's repository and base branch. Upstream `inKibra/gitspace.sh` on `develop` is
what a new project starts with. A project pointed at a fork or another branch launches that, built on an attached
machine.

### 2. The account's default release

The default is the release the GitSpace project runs: launching its canonical commit to every target makes that
release the default. Workspace launches are trials and never change it. **Back to default** replaces Back to stable. It
launches the default release to the worker, the frontend and the machines through the normal launch path, with no
platform `revert { to: 'channel' }`. Machines with no selection, and new computers, follow the default, which replaces
`stableMachineRelease`.

### 3. Platform builds are used by reference

GitHub builds and publishes; the platform Worker takes no part. `publish-default.yml`, run for a release tag (and still
by hand), builds the natives, the cloud image, the worker, the frontend and the portable release, and writes them
unchanged in format to the platform's `RELEASES` bucket as the **channel** (the name moves from "default release" to
the platform side). It then creates a GitHub Release for the tag whose notes carry the build's **pin**:
`<commit>:<SHA-256 of that commit's manifest.json>`. The commit locates the manifest, the hash proves its bytes, and the
manifest lists the SHA-256 of every file, so a pin fixes every byte of one build. Accounts already carry one, as the
`DEFAULT_ACCOUNT_RELEASE` binding.

Launching a commit the channel has built uses that build, with no machine build and no copy:

- the platform uploads the worker from its own bucket, checked against the pin;
- the account serves the frontend from the build's files;
- machines build their generation from the build's portable files, and the account mirrors the natives it pins, as now.

Accounts read a build's files through the existing platform route, `/v1/default-releases/<pin>/…`, through their
`PLATFORM_SERVICE` binding. The route loads the manifest the pin names, checks its SHA-256, finds the path in it, checks
the file's SHA-256 and returns it with immutable caching and `x-gitspace-frontend-release: <pin>`, which the account
checks. Channel builds are immutable and kept, so a release record that names one stays launchable.

### 4. The frontend is always the selected release's

The account serves the frontend of its selected release: from account storage, or from a channel build through the
route above. A new account is created from a channel build, and its default release record names that build.

### 5. Upstream releases arrive through a watch automation

Automations can watch a repository's releases, tags and GitHub deployments (`docs/AUTOMATIONS-DESIGN.md` §4a): by
webhook where the account's GitHub App receives the event, otherwise by checking GitHub every hour (adjustable). The
GitSpace project starts with one: **Release of `inKibra/gitspace.sh`** (the upstream parent when the project tracks a
fork) → message the project agent. Its instruction depends on what the project tracks:

- **Upstream `develop`:** offer to launch the release's build by reference, named by the pin in its notes. Editing the
  automation can make it launch without asking.
- **A fork or another branch:** offer to merge the tag into the branch in a workspace and open a pull request; once
  that is merged, launch with a build on an attached machine.

Nothing tells accounts; each account's automation looks. There is no separate updates setting: accounts change what
happens by editing or removing the automation.

## What leaves the platform

- Reverting a tenant to the channel (`revert { to: 'channel' }`) and the channel fallback in `loadFallback`. A failed
  swap reverts to the previous active release only.
- Injecting `DEFAULT_ACCOUNT_RELEASE` on every swap. It is set once, at creation.
- The platform worker version in the Back to stable inference check. The release record's `inferenceVersion` answers it.

## What the platform changes (needs your approval, per `AGENTS.md`)

- `/v1/default-releases/<pin>/frontend/<path>` serves any file its manifest names (`/v1/default-releases/<pin>/<path>`),
  so machines can read a build's portable files too.
- `/deploy` accepts a pin as well as a worker manifest in account storage. Today it reads the worker through the
  account (`/__platform/objects/<key>`); for a channel build it reads its own bucket. It already loads channel worker
  manifests to create accounts.

## Order of work

1. Canonical from the GitSpace project's source.
2. The default release and Back to default; machines and installs follow the default.
3. Channel builds by reference, including the frontend; the publish workflow runs on tags and creates the GitHub
   Release.
4. The watch trigger (automations milestone A4) and the GitSpace project's release automation.
5. The platform cleanup above, once every tenant runs a release from step 3.

## Decisions for you

1. **Approval of the two platform changes above.**
