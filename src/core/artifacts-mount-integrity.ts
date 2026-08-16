/**
 * Artifacts mount integrity — the round trip between a mount and its git
 * worktree registration.
 *
 * A linked worktree is TWO pointers that must agree:
 *
 *   <mountDir>/.git                      → "gitdir: <repoDir>/worktrees/<id>"
 *   <repoDir>/worktrees/<id>/gitdir      → "<mountDir>/.git"
 *
 * `git worktree list` reads only the second one, so it reports a healthy tree
 * whenever the registrations are self-consistent — even when a mount's own
 * `.git` points somewhere else entirely. That is why the incident this module
 * exists for was invisible from the command an operator would reach for: the
 * project's base mount pointed at the registration belonging to a workspace
 * worktree, so two working trees shared one HEAD, one index and one set of
 * refs, while `worktree list` still printed `base … [main]`.
 *
 * How that state is reached, in order:
 *
 *  1. Two concurrent `worktree add` calls for the same mount. One wins the
 *     registration; the loser writes the mount's `.git` file LAST, naming its
 *     own registration, then fails and has that registration cleaned up. The
 *     mount now DANGLES at a registration that no longer exists.
 *  2. A later `worktree prune` frees that registration name, and the next
 *     `worktree add` — for an unrelated workspace — is handed the same name.
 *     The dangling pointer silently becomes a live pointer into a stranger's
 *     worktree. A loud break heals into a quiet cross-wire.
 *
 * The consequences are all silent: a project-scope commit lands on a workspace
 * branch, `mountHead()` reports the wrong branch so post-run write-scope
 * enforcement diffs against a bogus baseline and can revert legitimate work,
 * roll-up onto main cannot be trusted, and two writers share one index.
 *
 * Hence `cross-wired` is never auto-repaired: two live worktrees are sharing an
 * index, and picking one to rewrite is a data-loss decision, not a cleanup.
 * `dangling` IS safe to repair — nothing is on the other end.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

export type MountIntegrityStatus =
  /** No `.git` at the mount — nothing mounted yet. Not a fault. */
  | 'absent'
  /** Both pointers agree. */
  | 'ok'
  /** The mount names a registration that does not exist. Safe to re-add. */
  | 'dangling'
  /** The mount names a registration that belongs to a DIFFERENT mount. */
  | 'cross-wired';

export interface MountIntegrity {
  status: MountIntegrityStatus;
  /** Registration id the mount's `.git` names (when it names a readable one). */
  registration?: string;
  /** Where that registration says its working tree lives — the smoking gun for
   *  `cross-wired`, since it is some other mount. */
  registrationPointsAt?: string;
  /** Registration ids whose `gitdir` names this mount but which the mount does
   *  not point back at. Orphans: the other half of a cross-wire, and what a
   *  blanket `worktree prune` would recycle. */
  orphanedRegistrations: string[];
}

/**
 * Symlink-resolved absolute path, DEFINED FOR PATHS THAT DO NOT EXIST.
 *
 * macOS hands out `/var/folders/…` while git records the resolved
 * `/private/var/folders/…`, so a raw string compare calls every temp-dir mount
 * cross-wired. `realpathSync` alone is not enough: the case that matters most
 * is a mount whose directory is GONE, where it throws — and falling back to an
 * unresolved `resolve()` silently stops matching the registration that names
 * it, so the orphan is never cleaned and `worktree add` then refuses the path.
 * Resolve the nearest existing ancestor and re-append the missing tail.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute; // hit the filesystem root: nothing resolves
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** Read `<repoDir>/worktrees/<id>/gitdir` → the mount `.git` path it claims. */
function registrationTarget(repoDir: string, id: string): string | null {
  try {
    return canonicalPath(readFileSync(join(repoDir, 'worktrees', id, 'gitdir'), 'utf8').trim());
  } catch {
    return null;
  }
}

/** All registration ids in the bare repo. `[]` when the repo has never had a
 *  linked worktree (no `worktrees/` directory at all). */
function allRegistrationIds(repoDir: string): string[] {
  try {
    return readdirSync(join(repoDir, 'worktrees'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Inspect one mount's round trip. Pure filesystem reads — no git subprocess, so
 * this is cheap enough to run before every write and on every daemon start.
 */
export function inspectArtifactsMount(repoDir: string, mountDir: string): MountIntegrity {
  const dotGit = join(mountDir, '.git');
  const wantTarget = canonicalPath(dotGit);

  // Every registration claiming this mount. Collected first: an orphan is
  // meaningful even when the mount itself is absent, because it is exactly the
  // registration a blanket prune would free and hand to someone else.
  const claiming = allRegistrationIds(repoDir).filter((id) => registrationTarget(repoDir, id) === wantTarget);

  if (!existsSync(dotGit)) {
    return { status: 'absent', orphanedRegistrations: claiming };
  }

  const raw = readFileSync(dotGit, 'utf8').trim();
  const named = raw.startsWith('gitdir:') ? raw.slice('gitdir:'.length).trim() : '';
  // A mount whose `.git` is a directory (a real repo, not a linked worktree) or
  // is unparseable names no registration; treat as dangling so the caller
  // re-establishes it rather than trusting it.
  if (named === '') {
    return { status: 'dangling', orphanedRegistrations: claiming };
  }

  const registration = named.split('/').filter(Boolean).pop() ?? '';
  if (!existsSync(named)) {
    return { status: 'dangling', registration, orphanedRegistrations: claiming };
  }

  const back = registrationTarget(repoDir, registration);
  if (back === null || back !== wantTarget) {
    return {
      status: 'cross-wired',
      registration,
      registrationPointsAt: back ?? undefined,
      orphanedRegistrations: claiming,
    };
  }

  return { status: 'ok', registration, orphanedRegistrations: claiming.filter((id) => id !== registration) };
}

/** One-line explanation for logs and thrown errors. */
export function describeMountIntegrity(mountDir: string, info: MountIntegrity): string {
  switch (info.status) {
    case 'ok':
      return `${mountDir}: mount and registration ${info.registration} agree`;
    case 'absent':
      return `${mountDir}: no mount present`;
    case 'dangling':
      return `${mountDir}: names registration ${info.registration ?? '(unparseable)'} which does not exist`;
    case 'cross-wired':
      return (
        `${mountDir}: names registration ${info.registration}, but that registration's working tree is ` +
        `${info.registrationPointsAt ?? '(unreadable)'} — two working trees would share one HEAD, index and refs`
      );
  }
}
