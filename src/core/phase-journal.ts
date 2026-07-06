/**
 * Phase journal (docs/REVIEW-GUIDE.md, grounding tier 2).
 *
 * Agents call `gssh space journal phase-start / phase-end` at workflow phase
 * boundaries. The agent supplies only the narrative (intent / outcome); the
 * SYSTEM snapshots state server-side from the sources of truth — goal
 * requirement statuses, workflow node statuses, review threads, evidence,
 * stage — and pins canon hashes (goal.md / rubric.json / workflow specs on
 * the artifacts branch). phase-end computes the delta (status motion vs
 * canon motion), joins filesTouched from blame/edits.jsonl, auto-commits the
 * workspace repo, and writes journal/NN-<slug>.json to the artifacts branch.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getProjectDir, getProjectWorkspacesDir } from './config.js';
import { readWorkspaceGoal } from './goal-chain.js';
import { hashRubric } from './goal-validation.js';
import { getWorkspaceStatus } from './workspace-metadata.js';
import { getThreads } from './review.js';
import { captureArtifacts } from './artifacts.js';
import { SpacesError } from '../types/errors.js';
import type { WorkspacePhase } from '../types/config.js';

export interface PhaseStateSnapshot {
  at: string;
  stage?: WorkspacePhase;
  goal?: {
    id: string;
    requirements: Record<string, string>;
    ready: string;
  };
  workflow?: Record<string, Record<string, string>>;
  review?: { threadsOpen: number; humanGatesAwaiting: number };
  evidenceIds: string[];
  canon: {
    artifactsSha?: string;
    goalDocHash?: string;
    rubricHash?: string;
    workflowHash?: string;
  };
}

export interface PhaseJournalDelta {
  requirementsAdvanced: Array<{ id: string; from: string; to: string }>;
  evidenceAdded: string[];
  threadsResolved: number;
  stageChanged: { from?: WorkspacePhase; to?: WorkspacePhase } | null;
  canonChanged: string[];
}

export interface PhaseJournalEntry {
  version: 1;
  phase: string;
  workflowRef?: string;
  startedAt: string;
  endedAt?: string;
  intent: string;
  outcome?: string;
  decisions?: string[];
  surprises?: string[];
  commits: { startSha?: string; endSha?: string; autoCommit?: string };
  filesTouched?: string[];
  state: { start: PhaseStateSnapshot; end?: PhaseStateSnapshot };
  delta?: PhaseJournalDelta;
}

const JOURNAL_DIR = 'journal';

function mountDirFor(workspaceDir: string): string {
  return join(workspaceDir, '.gitspace', 'artifacts');
}

function hasMount(workspaceDir: string): boolean {
  return existsSync(join(mountDirFor(workspaceDir), '.git'));
}

function gitHead(dir: string): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function contentHash(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return hashRubric(readFileSync(path, 'utf8'));
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'phase';
}

/** Snapshot the review-gated loop state for a workspace (summary-shaped). */
export function snapshotPhaseState(projectName: string, workspaceName: string, now: Date = new Date()): PhaseStateSnapshot {
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  const mount = mountDirFor(workspaceDir);
  const goal = readWorkspaceGoal(projectName, workspaceName);

  const requirements: Record<string, string> = {};
  const evidenceIds: string[] = [];
  let humanGatesAwaiting = 0;
  if (goal?.validation) {
    for (const id of goal.validation.reqOrder ?? Object.keys(goal.validation.requirements ?? {})) {
      const req = goal.validation.requirements?.[id];
      if (!req) continue;
      requirements[id] = req.status;
      for (const ev of req.evidence ?? []) evidenceIds.push(ev.id);
      if (req.required !== false && req.judgment?.kind === 'human' && req.status !== 'accepted'
        && !(req.reviews ?? []).some((r) => r.judgeType === 'human' || r.who === 'human')) {
        humanGatesAwaiting += 1;
      }
    }
  }
  const accepted = Object.values(requirements).filter((s) => s === 'accepted').length;

  // Workflow node statuses from *.workflow.json on the mount.
  let workflow: PhaseStateSnapshot['workflow'];
  let workflowHash: string | undefined;
  if (hasMount(workspaceDir)) {
    const specs = readdirSync(mount).filter((f) => f.endsWith('.workflow.json')).sort();
    for (const spec of specs) {
      try {
        const raw = readFileSync(join(mount, spec), 'utf8');
        workflowHash = hashRubric((workflowHash ?? '') + raw);
        const parsed = JSON.parse(raw) as { phases?: Array<{ name?: string; nodes?: Array<{ id?: string; status?: string }> }> };
        const nodes: Record<string, string> = {};
        for (const phase of parsed.phases ?? []) {
          for (const node of phase.nodes ?? []) {
            if (node.id) nodes[node.id] = node.status ?? 'pending';
          }
        }
        (workflow ??= {})[spec] = nodes;
      } catch { /* unreadable spec — skip */ }
    }
  }

  let threadsOpen = 0;
  try {
    threadsOpen = getThreads(workspaceDir, workspaceName, 'main').filter((t) => !t.resolved).length;
  } catch { /* no review session yet */ }

  return {
    at: now.toISOString(),
    stage: getWorkspaceStatus(projectName, workspaceName),
    goal: goal ? { id: goal.id, requirements, ready: `${accepted}/${Object.keys(requirements).length}` } : undefined,
    workflow,
    review: { threadsOpen, humanGatesAwaiting },
    evidenceIds,
    canon: {
      artifactsSha: hasMount(workspaceDir) ? gitHead(mount) : undefined,
      goalDocHash: contentHash(join(mount, 'goal.md')),
      rubricHash: contentHash(join(mount, 'rubric.json')),
      workflowHash,
    },
  };
}

export function computePhaseDelta(start: PhaseStateSnapshot, end: PhaseStateSnapshot): PhaseJournalDelta {
  const requirementsAdvanced: PhaseJournalDelta['requirementsAdvanced'] = [];
  const startReqs = start.goal?.requirements ?? {};
  const endReqs = end.goal?.requirements ?? {};
  for (const [id, to] of Object.entries(endReqs)) {
    const from = startReqs[id];
    if (from !== undefined && from !== to) requirementsAdvanced.push({ id, from, to });
    if (from === undefined) requirementsAdvanced.push({ id, from: '(new)', to });
  }
  const startEvidence = new Set(start.evidenceIds);
  const canonChanged: string[] = [];
  for (const key of ['goalDocHash', 'rubricHash', 'workflowHash'] as const) {
    if (start.canon[key] !== end.canon[key]) canonChanged.push(key.replace('Hash', ''));
  }
  return {
    requirementsAdvanced,
    evidenceAdded: end.evidenceIds.filter((id) => !startEvidence.has(id)),
    threadsResolved: Math.max(0, (start.review?.threadsOpen ?? 0) - (end.review?.threadsOpen ?? 0)),
    stageChanged: start.stage !== end.stage ? { from: start.stage, to: end.stage } : null,
    canonChanged,
  };
}

function journalEntries(mount: string): string[] {
  const dir = join(mount, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

function readEntry(mount: string, file: string): PhaseJournalEntry {
  return JSON.parse(readFileSync(join(mount, JOURNAL_DIR, file), 'utf8')) as PhaseJournalEntry;
}

export function findOpenPhaseEntry(workspaceDir: string): { file: string; entry: PhaseJournalEntry } | null {
  const mount = mountDirFor(workspaceDir);
  if (!hasMount(workspaceDir)) return null;
  for (const file of journalEntries(mount).reverse()) {
    try {
      const entry = readEntry(mount, file);
      if (!entry.endedAt) return { file, entry };
    } catch { /* skip unreadable */ }
  }
  return null;
}

export async function startPhaseJournal(
  projectName: string,
  workspaceName: string,
  input: { phase: string; intent: string; workflowRef?: string },
  now: Date = new Date(),
): Promise<{ file: string; entry: PhaseJournalEntry }> {
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  if (!hasMount(workspaceDir)) {
    throw new SpacesError('Phase journal requires the artifacts mount (.gitspace/artifacts).', 'USER_ERROR', 1);
  }
  const open = findOpenPhaseEntry(workspaceDir);
  if (open) {
    throw new SpacesError(`Phase "${open.entry.phase}" is still open (${open.file}) — end it first.`, 'USER_ERROR', 1);
  }
  const mount = mountDirFor(workspaceDir);
  const seq = String(journalEntries(mount).length + 1).padStart(2, '0');
  const file = `${JOURNAL_DIR}/${seq}-${slugify(input.phase)}.json`;
  const entry: PhaseJournalEntry = {
    version: 1,
    phase: input.phase,
    workflowRef: input.workflowRef,
    startedAt: now.toISOString(),
    intent: input.intent,
    commits: { startSha: gitHead(workspaceDir) },
    state: { start: snapshotPhaseState(projectName, workspaceName, now) },
  };
  await captureArtifacts(getProjectDir(projectName), mount, [
    { path: file, content: JSON.stringify(entry, null, 2) + '\n' },
  ], { message: `journal: start ${input.phase}`, provenance: { tool: 'phase-journal' } });
  return { file: file.slice(JOURNAL_DIR.length + 1), entry };
}

export async function endPhaseJournal(
  projectName: string,
  workspaceName: string,
  input: { outcome: string; decisions?: string[]; surprises?: string[]; autoCommit?: boolean },
  now: Date = new Date(),
): Promise<{ file: string; entry: PhaseJournalEntry }> {
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  const open = findOpenPhaseEntry(workspaceDir);
  if (!open) {
    throw new SpacesError('No open phase — call phase-start first.', 'USER_ERROR', 1);
  }
  const mount = mountDirFor(workspaceDir);

  // Auto-commit the CODE repo at the phase boundary (message from the outcome
  // headline) so commit order becomes a good narrative signal by construction.
  let autoCommit: string | undefined;
  if (input.autoCommit !== false) {
    try {
      execFileSync('git', ['-C', workspaceDir, 'add', '-A'], { stdio: 'ignore' });
      const headline = input.outcome.split('\n')[0]!.slice(0, 72);
      execFileSync('git', [
        '-C', workspaceDir,
        '-c', 'user.name=gitspace', '-c', 'user.email=journal@gitspace.sh', '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', `${open.entry.phase}: ${headline}`,
      ], { stdio: 'ignore' });
      autoCommit = gitHead(workspaceDir);
    } catch { /* nothing to commit */ }
  }

  const end = snapshotPhaseState(projectName, workspaceName, now);

  // filesTouched joined from tier-1 breadcrumbs within the phase window.
  let filesTouched: string[] | undefined;
  const crumbLog = join(mount, 'blame', 'edits.jsonl');
  if (existsSync(crumbLog)) {
    const since = open.entry.startedAt;
    const files = new Set<string>();
    for (const line of readFileSync(crumbLog, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const crumb = JSON.parse(line) as { ts: string; file: string };
        if (crumb.ts >= since && crumb.ts <= now.toISOString()) files.add(crumb.file);
      } catch { /* skip bad line */ }
    }
    if (files.size > 0) filesTouched = [...files].sort();
  }

  const entry: PhaseJournalEntry = {
    ...open.entry,
    endedAt: now.toISOString(),
    outcome: input.outcome,
    decisions: input.decisions,
    surprises: input.surprises,
    commits: { ...open.entry.commits, endSha: gitHead(workspaceDir), autoCommit },
    filesTouched,
    state: { ...open.entry.state, end },
    delta: computePhaseDelta(open.entry.state.start, end),
  };
  await captureArtifacts(getProjectDir(projectName), mount, [
    { path: `${JOURNAL_DIR}/${open.file}`, content: JSON.stringify(entry, null, 2) + '\n' },
  ], { message: `journal: end ${open.entry.phase}`, provenance: { tool: 'phase-journal' } });
  return { file: open.file, entry };
}
