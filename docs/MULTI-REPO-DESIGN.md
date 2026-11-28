# Multi-Repo Projects — Design Doc

> **Status: design, decided 2026-11-28. Not built yet**, except "Copying through a machine" (section 10), which is
> built and described for reference. The locked visual reference is the mock in
> `packages/account-web/src/teams-mock/` (Project settings › Repositories and the new-project "Connect repositories"
> step in `project-setup.tsx` and `flows/project.tsx`). Examples use the mock's invented team, Crumb & Co.

Today a project has one repository and a workspace is one checkout of it. This design lets a project list several
repositories, keeps each one's sync as it works today, and adds one record that ties their states together.

## 1. Repositories

A project lists several repositories. Each entry has:

- **URL**;
- **subfolder path** in the workspace;
- **base branch**;
- **how it is reached:** the team's GitHub App, a machine with SSH, or **not reachable**, shown with the fix.

A new project ends with a **"Connect repositories"** step. **Project settings › Repositories → Add** runs the same step.

## 2. Layout

- **Every repository sits in its own subfolder** of the workspace.
- **One-repo projects move too**: their checkout moves into its subfolder in a **one-time path migration**.
- **No submodules on disk.** Plain clones side by side.

## 3. Cross-repo state

A **state row in the workspace's SQLite store** records the workspace's state across repositories:

- **version N**, mapping each repository to `{path, branch, head, checkpoint}`.
- **Advanced by compare-and-swap** after each repository's checkpoint has been pushed to its own Artifacts ref
  (`refs/gitspace/spaces/<space>/checkpoints/<revision>` today). A writer reads version N, pushes the checkpoint, then
  writes N+1 only if the row is still at N.
- **Today's per-repository sync is unchanged.** The row is added on top of it.
- **Pinned runs, checks, Review and change guides record the state version**, so each names the exact commit of every
  repository it saw.

## 4. Sync and conflicts

- Each repository syncs on its own, as today.
- **Conflicts resolve per repository against version N**: a conflict in one repository does not hold the others.
- The state row advances once each conflict is resolved and its checkpoint pushed.

## 5. Cloud readers

Cloud readers (anything in the cloud that reads a workspace's files) **look up each repository's commit from the state
row**, then read that commit from the repository's Artifacts ref.

## 6. Agents' repository access

- **The project agent and workspace agents get every repository, writable.**
- **Creating a workspace may pick a subset.** The subset only decides which folders are cloned; it is not a permission.

## 7. New checkouts

- **New checkouts share git objects with the base checkout on that machine** (`git clone --local`, or alternates).
- **Deferred:** copy-on-write working files and cloning dependencies.
- **Rejected:** Twig (copy-on-write worktrees), because it needs APFS or XFS.

## 8. Ship

- **One pull request per changed repository**, linked to each other.
- **A partial ship** (some pull requests opened, others failed) is shown as such, with **retry**.

## 9. Storage

Storage stays on Artifacts. Swapping in GitSpace's own git object store is not part of this design; another project of
ours already has one.

## 10. Copying through a machine (built, for reference)

A project the cloud can't read (no GitHub App) is read through a **bridge** machine attached to its base workspace:

- **Check origin** uses `project.remote.branches`.
- **Update base** uses `project.seed`, a background operation from a per-machine origin cache
  (`origins/<projectId>.git`), with progress and a 10-minute no-progress watchdog.
- With `then: updateBase`, the machine finishes Update base itself through the control op `project.base.update`.

In a multi-repo project this applies per repository whose access is "a machine with SSH".

## 11. Backlog

- **Copy-on-write** working files and dependency cloning for new checkouts (section 7).
- **#254: a Quint model** of checkout ↔ Artifacts ↔ origin sync.

## 12. Open questions

1. How existing one-repo workspaces with uncommitted work go through the path migration (moved in place on each machine,
   or only on next materialization) is not decided.
2. Whether the bridge machine's origin cache (`origins/<projectId>.git`) becomes one cache per repository, and how it is
   named, is not decided.
3. What a workspace created with a subset does when an agent needs a repository that wasn't cloned (clone on demand, or
   refuse) is not decided.
4. How the CI gate into Review (`ENVIRONMENT-DESIGN.md`) combines several pull requests: all must pass is assumed, not
   decided.

## 13. Build order

1. **Repositories list** in the project model, Project settings › Repositories and the "Connect repositories" step,
   with reachability and the fix.
2. **Subfolder layout** and the one-time path migration for one-repo projects.
3. **State row** in the workspace's SQLite store with compare-and-swap after each checkpoint push.
4. **Per-repository conflicts** against version N; pinned runs, checks, Review and guides record the state version.
5. **Cloud readers** resolve commits from the state row.
6. **Workspace creation with a subset** of repositories.
7. **Shared git objects** for new checkouts.
8. **Ship** with one linked pull request per changed repository, partial ship and retry.
9. **Backlog:** copy-on-write checkouts; the Quint model (#254).
