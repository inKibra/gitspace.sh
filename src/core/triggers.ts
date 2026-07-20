/**
 * Trigger registry (docs/VISUAL-PARITY-ISSUES.md item 25, M1).
 *
 * Triggers are ARTIFACTS: `triggers/<slug>.trigger.json` on the workspace's
 * artifacts branch — versioned, roll up with the branch, agent-authorable
 * per the space-artifacts conventions. M1 = registry + manual runs (run-now
 * prompts an agent session and records history); the cron scheduler that
 * fires them unattended is M2.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { artifactsScope, captureArtifacts } from './artifacts.js';
import { pathInScope } from './artifact-cap.js';
import { validateTriggerWhen } from './trigger-grammar.js';
import { SpacesError } from '../types/errors.js';

export interface TriggerRecord {
  id: string;
  name: string;
  kind: 'cron' | 'event' | 'manual';
  when: string;
  status: 'ok' | 'pending' | 'failed' | 'idle';
  last: string;
  next?: string;
  cost?: string;
  writes: string[];
  history: Array<'ok' | 'fail' | 'pending'>;
  note?: string;
  scope?: 'workspace' | 'project';
  does?: string;
  runs?: { type: 'command' | 'skill' | 'workflow'; ref?: string; prompt?: string };
  reads?: string[];
  feeds?: string[];
  /** ISO timestamps of recent runs, newest last (source for `last`). */
  runLog?: Array<{ at: string; status: 'ok' | 'fail' | 'pending'; note?: string; sessionId?: string; startCommit?: string }>;
}

const TRIGGER_DIR = 'triggers';

function mountDirFor(workspaceDir: string): string {
  return join(workspaceDir, '.gitspace', 'artifacts');
}

/** Triggers are goal artifacts: `goals/<goal-id>/triggers/<slug>.trigger.json`.
 *  TRIGGER_DIR is relative to the goal folder the workspace owns, so scope-lift
 *  every path that git sees (docs/ARTIFACTS-FS.md "Tree layout"). */
function triggerDirRel(workspaceDir: string): string {
  return artifactsScope(workspaceDir).rel(TRIGGER_DIR);
}

/**
 * Lift a trigger's `writes` globs from goal-relative (how the user authors
 * them, and how the agent addresses them via `local://`) to mount-relative
 * (what artifact:// caps carry and what a git diff reports). Minting and
 * enforcement MUST use the same space or a trigger either cannot write
 * anything or is checked against nothing.
 */
export function triggerWriteScopes(workspaceDir: string, writes: string[]): string[] {
  const { rel } = artifactsScope(workspaceDir);
  return writes.filter(Boolean).map((g) => rel(g));
}

export function triggerSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!slug) throw new SpacesError('Trigger name must contain letters or digits.', 'USER_ERROR', 1);
  return slug;
}

export function listTriggers(workspaceDir: string): TriggerRecord[] {
  const dir = artifactsScope(workspaceDir).abs(TRIGGER_DIR);
  if (!existsSync(dir)) return [];
  const out: TriggerRecord[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.trigger.json')).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as TriggerRecord);
    } catch { /* skip unreadable */ }
  }
  return out;
}

export async function saveTrigger(
  projectDir: string,
  workspaceDir: string,
  trigger: Omit<TriggerRecord, 'id' | 'status' | 'last' | 'history'> & Partial<Pick<TriggerRecord, 'id' | 'status' | 'last' | 'history'>>,
): Promise<TriggerRecord> {
  const mount = mountDirFor(workspaceDir);
  if (!existsSync(join(mount, '.git'))) {
    throw new SpacesError('Triggers require the artifacts mount (.gitspace/artifacts).', 'USER_ERROR', 1);
  }
  // An unfireable schedule must be impossible to save (it would sit "armed"
  // forever with zero feedback).
  const whenError = validateTriggerWhen(trigger.kind, trigger.when);
  if (whenError) throw new SpacesError(`Trigger schedule invalid: ${whenError}`, 'USER_ERROR', 1);
  const id = trigger.id ?? triggerSlug(trigger.name);
  const record: TriggerRecord = {
    status: 'idle',
    last: 'never',
    history: [],
    ...trigger,
    id,
  };
  await captureArtifacts(projectDir, mount, [
    { path: `${triggerDirRel(workspaceDir)}/${id}.trigger.json`, content: JSON.stringify(record, null, 2) + '\n' },
  ], { message: `trigger: save ${record.name}`, provenance: { tool: 'triggers' } });
  return record;
}

export async function recordTriggerRun(
  projectDir: string,
  workspaceDir: string,
  triggerId: string,
  run: { status: 'ok' | 'fail' | 'pending'; note?: string; sessionId?: string; startCommit?: string },
  now: Date = new Date(),
): Promise<TriggerRecord> {
  const mount = mountDirFor(workspaceDir);
  const path = artifactsScope(workspaceDir).abs(`${TRIGGER_DIR}/${triggerId}.trigger.json`);
  if (!existsSync(path)) throw new SpacesError(`Unknown trigger: ${triggerId}`, 'USER_ERROR', 1);
  const record = JSON.parse(readFileSync(path, 'utf8')) as TriggerRecord;
  const entry = { at: now.toISOString(), ...run };
  const next: TriggerRecord = {
    ...record,
    status: run.status === 'ok' ? 'ok' : run.status === 'fail' ? 'failed' : 'pending',
    last: 'just now',
    history: [...record.history, run.status].slice(-5),
    runLog: [...(record.runLog ?? []), entry].slice(-20),
  };
  await captureArtifacts(projectDir, mount, [
    { path: `${triggerDirRel(workspaceDir)}/${triggerId}.trigger.json`, content: JSON.stringify(next, null, 2) + '\n' },
  ], { message: `trigger: run ${record.name} (${run.status})`, provenance: { tool: 'triggers' } });
  return next;
}

// ── run-window write enforcement (docs/ARTIFACT-PROTOCOL.md Phase 3) ────────

function gitInMount(workspaceDir: string, args: string[], env?: Record<string, string>): string {
  // execFileSync — NO shell. Filenames here are git diff output (arbitrary
  // bytes bar NUL/slash), so any string interpolation into a shell command is
  // RCE in the daemon that holds the signing key. Every arg is a literal argv
  // element; consumers pass raw paths (no JSON/shell quoting).
  return execFileSync(
    'git',
    ['-C', mountDirFor(workspaceDir), '-c', 'user.name=gitspace', '-c', 'user.email=artifacts@gitspace.sh', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined },
  ).trim();
}

/** HEAD of the workspace's artifacts mount (recorded as a run's startCommit). */
export function mountHead(workspaceDir: string): string | null {
  try {
    return gitInMount(workspaceDir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

export interface TriggerRunEnforcement {
  violations: string[];
  revertCommit?: string;
  skippedForeignCommits: number;
}

/**
 * The hard enforcement ring for trigger `writes`: after a run completes, diff
 * the commits landed on the branch during the run window (startCommit..HEAD)
 * and revert out-of-scope file changes with a forward-fix commit (safe — the
 * publish gate guarantees nothing in the window left the machine).
 *
 * Attribution: commits whose provenance note names a DIFFERENT session or
 * trigger are skipped (protects concurrent capture-attributed writes);
 * everything else in the window is attributed to the run — artifacts
 * branches are single-writer by design. An empty `writes` list means the
 * trigger declared no scope: nothing is enforced.
 */
export async function enforceTriggerWritesPostRun(
  _projectDir: string,
  workspaceDir: string,
  trigger: TriggerRecord,
  run: { sessionId?: string; startCommit?: string },
): Promise<TriggerRunEnforcement> {
  const writes = triggerWriteScopes(workspaceDir, trigger.writes ?? []);
  if (writes.length === 0 || !run.startCommit) return { violations: [], skippedForeignCommits: 0 };

  let commits: string[] = [];
  try {
    commits = gitInMount(workspaceDir, ['rev-list', '--reverse', `${run.startCommit}..HEAD`]).split('\n').map((c) => c.trim()).filter(Boolean);
  } catch {
    return { violations: [], skippedForeignCommits: 0 };
  }
  if (commits.length === 0) return { violations: [], skippedForeignCommits: 0 };

  const violations = new Set<string>();
  let skippedForeignCommits = 0;
  for (const commit of commits) {
    let note: { session?: string; trigger?: string } | null = null;
    try {
      note = JSON.parse(gitInMount(workspaceDir, ['notes', 'show', commit])) as { session?: string; trigger?: string };
    } catch { /* no note — attributable to the run window */ }
    if (note && ((note.session && run.sessionId && note.session !== run.sessionId) || (note.trigger && note.trigger !== trigger.id))) {
      skippedForeignCommits += 1;
      continue;
    }
    let changed: string[] = [];
    try {
      changed = gitInMount(workspaceDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n').map((f) => f.trim()).filter(Boolean);
    } catch { continue; }
    for (const file of changed) {
      if (file === '.gitattributes' || file.startsWith(`${triggerDirRel(workspaceDir)}/`)) continue; // run bookkeeping is always in scope
      if (!pathInScope(file, writes)) violations.add(file);
    }
  }
  if (violations.size === 0) return { violations: [], skippedForeignCommits };

  // Forward-fix: restore each out-of-scope path to its startCommit state
  // (delete paths that did not exist there).
  const paths = [...violations].sort();
  for (const file of paths) {
    const existedAtStart = (() => {
      try { gitInMount(workspaceDir, ['cat-file', '-e', `${run.startCommit}:${file}`]); return true; } catch { return false; }
    })();
    if (existedAtStart) gitInMount(workspaceDir, ['checkout', run.startCommit!, '--', file]);
    else {
      try { gitInMount(workspaceDir, ['rm', '-f', '-q', '--', file]); } catch { /* already gone */ }
    }
  }
  gitInMount(workspaceDir, ['add', '-A']);
  const message = `revert: trigger ${trigger.id} wrote outside its scope (${paths.join(', ')})`;
  gitInMount(workspaceDir, ['commit', '-q', '-m', message], { GSSH_ARTIFACTS_CAPTURE: '1' });
  const revertCommit = gitInMount(workspaceDir, ['rev-parse', 'HEAD']);
  try {
    gitInMount(workspaceDir, ['notes', 'add', '-f', '-m', JSON.stringify({ tool: 'trigger-enforcement', trigger: trigger.id }), revertCommit]);
  } catch { /* note best-effort */ }
  return { violations: paths, revertCommit, skippedForeignCommits };
}

/**
 * Close a run: enforce the write scope over the run window, then record
 * ok (clean) or fail (violations reverted). The one completion path shared
 * by the scheduler and run-now.
 */
export async function completeTriggerRun(
  projectDir: string,
  workspaceDir: string,
  triggerId: string,
  opts: { sessionId?: string } = {},
): Promise<{ status: 'ok' | 'fail'; enforcement: TriggerRunEnforcement }> {
  const trigger = listTriggers(workspaceDir).find((t) => t.id === triggerId);
  if (!trigger) throw new SpacesError(`Unknown trigger: ${triggerId}`, 'USER_ERROR', 1);
  const pendingEntry = [...(trigger.runLog ?? [])].reverse().find((r) => r.status === 'pending');
  const enforcement = await enforceTriggerWritesPostRun(projectDir, workspaceDir, trigger, {
    sessionId: opts.sessionId,
    startCommit: pendingEntry?.startCommit,
  });
  if (enforcement.violations.length > 0) {
    await recordTriggerRun(projectDir, workspaceDir, triggerId, {
      status: 'fail',
      sessionId: opts.sessionId,
      note: `out-of-scope writes reverted: ${enforcement.violations.join(', ')}`,
    });
    return { status: 'fail', enforcement };
  }
  await recordTriggerRun(projectDir, workspaceDir, triggerId, { status: 'ok', sessionId: opts.sessionId });
  return { status: 'ok', enforcement };
}
