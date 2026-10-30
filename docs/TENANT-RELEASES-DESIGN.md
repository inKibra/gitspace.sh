# Account releases: the platform builds, the account decides

Status: agreed (2026-10-30), not built.

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

The platform builds upstream release tags and publishes them, unchanged in format, as the **channel** (the name moves
from "default release" to the platform side). Launching a commit the channel has built uses that build, with no
machine build and no copy:

- the platform uploads the worker from the channel build named by its pin;
- the account serves the frontend from the build's files;
- machines build their generation from the build's portable files, and the account mirrors the natives it pins, as now.

Channel builds are immutable and kept, so a release record that names one stays launchable.

### 4. The frontend is always the selected release's

The account serves the frontend of its selected release: from account storage, or from a channel build. The proxy to
the platform's `/v1/default-releases/*` goes away. A new account is created from a channel build, and its default
release record names that build.

### 5. Upstream releases arrive as an automation trigger

A new automation trigger, `{ kind: 'gitspace-release' }`, fires on the GitSpace project when the platform has published
a build of a new upstream tag. The platform tells each account after it publishes, because reaching every account is
cross-tenant work; an account's GitHub App never sees upstream's events. The GitSpace project starts with one
automation on that trigger, and its instruction depends on what the project tracks:

- **Upstream `develop`:** offer to launch the new build by reference. Editing the automation can make it launch without
  asking.
- **A fork or another branch:** offer to merge the tag into the branch in a workspace and open a pull request; once
  that is merged, launch with a build on an attached machine.

There is no separate updates setting: accounts change what happens by editing the automation.

## What leaves the platform

- Reverting a tenant to the channel (`revert { to: 'channel' }`) and the channel fallback in `loadFallback`. A failed
  swap reverts to the previous active release only.
- Injecting `DEFAULT_ACCOUNT_RELEASE` on every swap. It is set once, at creation.
- `/v1/default-releases/*`, if the channel moves to a public bucket (decision 1).
- The platform worker version in the Back to stable inference check. The release record's `inferenceVersion` answers it.

## What the platform gains (needs your approval, per `AGENTS.md`)

- After publishing a build, a notice to every account.
- `/deploy` accepting a channel pin as well as a manifest in account storage. The platform already loads channel worker
  manifests to create accounts.

## Order of work

1. Canonical from the GitSpace project's source.
2. The default release and Back to default; machines and installs follow the default.
3. Channel builds by reference, including the frontend; tags publish to the channel.
4. The `gitspace-release` trigger, the GitSpace project's default automation, and the platform's notice.
5. The platform cleanup above, once every tenant runs a release from step 3.

## Decisions for you

1. **Where accounts read channel builds.**
   - (a) A public bucket on its own domain, with no platform code.
   - (b) The existing platform route.
   - Recommended: (a).
2. **Approval of the two platform additions above.**
