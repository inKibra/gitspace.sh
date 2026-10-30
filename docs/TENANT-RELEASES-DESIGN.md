# Account releases: the platform builds, the account decides

Status: agreed (2026-10-30), not built. Mock: `packages/account-web/mock-gitspace-project.html`
(`src/GitSpaceProjectMock.tsx`). The GitSpace project agent's conversation asks with question cards: a published
release (launch it, or merge it into a fork), a fork's branch with changes to build, and promoting a trial (on upstream,
open a pull request or move to a fork). The project settings dialog is every project's (Repository, Base branch, Origin,
Inference); the topbar's Behind origin · Update and the sidebar ↓ are the existing ones. The sidebar and Settings →
Releases show what the account runs. The mock's "Simulate" menu makes those events happen.

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

### 3. Published releases are used by reference

GitHub builds and publishes; the platform Worker takes no part. `publish-default.yml`, run for a release tag (and
still by hand), builds the natives, the cloud image, the worker, the frontend and the portable release. It writes them,
unchanged in format, to a **public** bucket on its own domain (the **channel**; the name moves from "default release"
to the platform side):

- `catalog.json`: every published release, newest first: tag, commit, pin, publish date;
- `releases/<commit>/manifest.json` and the files it lists, each with its SHA-256. They are immutable, and only the
  operator writes them.

A **pin** is `<commit>:<SHA-256 of that commit's manifest.json>`. The commit locates the manifest, the hash proves its
bytes, and the manifest lists the SHA-256 of every file, so a pin fixes every byte of one release. Accounts already
carry one, as the `DEFAULT_ACCOUNT_RELEASE` binding. The workflow also creates a GitHub Release for the tag, which is
what the release automation (§5) watches, and keeps writing to `RELEASES`, from which the platform creates accounts
and cloud images.

An account uses a published release without copying it:

- **Record:** a release record with source `{ kind: 'release', tag, pin }`, whose files are channel URLs instead of
  account-storage keys.
- **Worker:** launched through the existing `/deploy`, which reads a worker's manifest and modules through the
  account (`/__platform/objects/<key>`) and checks them against the manifest's SHA-256. For a published release the
  account answers those reads from the channel. The platform does nothing new.
- **Frontend:** the account serves the release's files fetched from the channel, cached at the edge.
- **Machines:** they download the portable files from the channel and check them against the pinned digests, as they
  check every download. The account mirrors the natives the release pins, as now.

Channel releases are kept, so a record that names one stays launchable.

### 4. The frontend is always the selected release's

The account serves the frontend of its selected release: from account storage, or from the channel. The proxy to the
platform's `/v1/default-releases/*` goes away. A new account is created from a published release, and its default
release record names it.

### 5. Tags are releases; a moving branch is not

The GitSpace project's agent can launch either, but they mean different things:

| | A GitSpace tag | The project's branch moved (`develop`, or a fork's branch) |
|---|---|---|
| Meaning | A release, published with GitHub's build | Unreleased changes |
| Launching it | By reference: nothing is built | Built on an attached machine |
| How the account learns of it | The release automation below | The project shows it is behind its origin (§6) |
| The agent asks | "Update to v0.2.0-rc.42?" | Only on a fork, or for a maintainer: "develop has 3 unreleased changes; build and launch?" |

**The release automation.** Automations can watch a repository's releases, tags and GitHub deployments
(`docs/AUTOMATIONS-DESIGN.md` §4a): by webhook where the account's GitHub App receives the event, otherwise by checking
GitHub once a day (adjustable). The GitSpace project starts with one: **Release of `inKibra/gitspace.sh`** (the
upstream parent when the project tracks a fork) → message the project agent, which finds the release's pin in the
catalog. Its instruction depends on what the project tracks:

- **Upstream `develop`:** ask to launch the release by reference. Editing the automation can make it launch without
  asking.
- **A fork or another branch:** ask to merge the tag into the branch in a workspace and open a pull request; once that
  is merged, ask to build and launch it.

Nothing tells accounts; each account's automation looks. The agent remembers what you answered, such as a skipped
release, from its conversation.

### 6. Behind its origin, and Update base

The GitSpace project shows that its branch is behind its origin like any project: the ↓ beside its name, Behind
origin/`develop` · Update in its topbar, and Update base and Check origin in its settings, including when `develop`
moves with no tag. Update base fast-forwards the project's copy; it launches nothing. The GitSpace project no longer
hides Update base (`role === 'gitspace-source'` in `RuntimeWorkspace.tsx` and `AccountWorkPages.tsx`).

A project the GitHub App covers learns of a push at once. Any other project only learns when someone opens it
(`useOriginCheck`) or chooses Check origin. A new setting for every project in its settings dialog, **Check the origin**,
once a day by default and adjustable, keeps it current.

### 7. Trials and promoting one

A trial is a workspace's version running on some targets; it never changes the default. Promoting it means getting
its changes onto the project's branch and launching that as the default, so the agent's offer depends on where the
project points:

| The GitSpace project tracks | The agent offers |
|---|---|
| Upstream, and you cannot push there | Open a pull request upstream and keep the trial meanwhile, or move the project to your own fork, merge there and launch |
| Upstream, as a maintainer | Merge the pull request into `develop`, then build and launch it |
| Your fork | Merge into the fork's branch, then build and launch it |
| Any | Keep the trial, or go Back to default |

### 8. Pointing the GitSpace project at a fork

The GitSpace project uses the settings dialog every project has. Two changes there apply to every project:

- **Repository**, new: change the project's origin to another address (the same field as creating a project). Use it to
  move to a fork or a moved repository. Workspaces keep their branches; the base space fetches from the new origin.
- **Base branch**, existing: the GitSpace project no longer refuses it ("Managed by GitSpace releases" in
  `AccountWorkPages.tsx`, and the `gitspace-source` check in `ProjectAuthority.setBaseBranch`).

The only GitSpace-specific line in the dialog says what its repository means for releases: on `inKibra/gitspace.sh`,
published releases launch as they are; on any other repository, releases arrive as merges and launching builds on a
machine. The project agent can make the same changes when asked, or when you choose to move to your fork on a trial.
The default release stays until the next launch. The release automation follows the fork's upstream parent, and
behind-origin follows the fork's branch.

The project menu's **Launch canonical develop** becomes **Launch** with the project's base branch.

## What leaves the platform

- `/v1/default-releases/*` and `defaultFrontendResponse`.
- Reverting a tenant to the channel (`revert { to: 'channel' }`) and the channel fallback in `loadFallback`. A failed
  swap reverts to the previous active release only.
- Injecting `DEFAULT_ACCOUNT_RELEASE` on every swap. It is set once, at creation.
- The platform worker version in the Back to stable inference check. The release record's `inferenceVersion` answers it.

No platform code is added. The operator creates the public channel bucket and its domain.

## Order of work

1. Canonical from the GitSpace project's repository and base branch; Repository in project settings; Base branch
   allowed for the GitSpace project; Launch with the base branch.
2. The default release and Back to default; machines and installs follow the default.
3. The public channel and catalog; published releases by reference, including the frontend; the publish workflow runs
   on tags and creates the GitHub Release.
4. The watch trigger (automations milestone A4) and the GitSpace project's release automation.
5. Update base for the GitSpace project; the Check the origin setting.
6. The platform cleanup above, once every tenant runs a release from step 3.
