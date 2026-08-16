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
import { artifactsScope, captureArtifacts } from './artifacts.js';
import { describeOwedRequirement, gateStatusForPhase, workflowPhaseNames } from './goal-gates.js';
import { tryLoadWorkspaceWorkflow } from './goal-workflow.js';
import { SpacesError } from '../types/errors.js';
import type { WorkspacePhase } from '../types/config.js';
import { z } from 'zod';
import { parseJsonOrThrow, parseWith } from './schema-parse.js';

export const phaseStateSnapshotSchema = z.object({
  at: z.string(),
  stage: z.string().optional() as z.ZodType<WorkspacePhase | undefined>,
  goal: z.object({
    id: z.string(),
    requirements: z.record(z.string(), z.string()),
    ready: z.string(),
  }).optional(),
  workflow: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  review: z.object({ threadsOpen: z.number(), humanGatesAwaiting: z.number() }).optional(),
  evidenceIds: z.array(z.string()),
  canon: z.object({
    artifactsSha: z.string().optional(),
    goalDocHash: z.string().optional(),
    rubricHash: z.string().optional(),
    workflowHash: z.string().optional(),
  }),
});
export type PhaseStateSnapshot = z.infer<typeof phaseStateSnapshotSchema>;

export const phaseJournalDeltaSchema = z.object({
  requirementsAdvanced: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })),
  evidenceAdded: z.array(z.string()),
  threadsResolved: z.number(),
  stageChanged: z.object({
    from: z.string().optional() as z.ZodType<WorkspacePhase | undefined>,
    to: z.string().optional() as z.ZodType<WorkspacePhase | undefined>,
  }).nullable(),
  canonChanged: z.array(z.string()),
});
export type PhaseJournalDelta = z.infer<typeof phaseJournalDeltaSchema>;

export const phaseJournalEntrySchema = z.object({
  version: z.literal(1),
  phase: z.string(),
  workflowRef: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  intent: z.string(),
  outcome: z.string().optional(),
  decisions: z.array(z.string()).optional(),
  surprises: z.array(z.string()).optional(),
  commits: z.object({ startSha: z.string().optional(), endSha: z.string().optional(), autoCommit: z.string().optional() }),
  filesTouched: z.array(z.string()).optional(),
  state: z.object({ start: phaseStateSnapshotSchema, end: phaseStateSnapshotSchema.optional() }),
  delta: phaseJournalDeltaSchema.optional(),
  /** Set when the phase was closed via `phase-end --revert` — the gate was
   *  not satisfied and the workflow returns to `to` (typically plan) for
   *  requirement rewrite. The gate stays red. */
  reverted: z.object({ reason: z.string(), to: z.string() }).optional(),
});
export type PhaseJournalEntry = z.infer<typeof phaseJournalEntrySchema>;

/** The subset of a workflow spec this module reads for node statuses. */
const workflowNodeStatusSchema = z.object({
  phases: z.array(z.object({
    name: z.string().optional(),
    nodes: z.array(z.object({ id: z.string().optional(), status: z.string().optional() })).optional(),
  })).optional(),
});

const JOURNAL_DIR = 'journal';

function mountDirFor(workspaceDir: string): string {
  return join(workspaceDir, '.gitspace', 'artifacts');
}

/** The goal folder this workspace owns — journal entries, canon, breadcrumbs
 *  and the workflow spec all live under it, not at the mount root
 *  (docs/ARTIFACTS-FS.md "Tree layout"). */
function scopeDirFor(workspaceDir: string): string {
  return artifactsScope(workspaceDir).rootDir;
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
  const scopeDir = scopeDirFor(workspaceDir);
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
    const specs = readdirSync(scopeDir).filter((f) => f.endsWith('.workflow.json')).sort();
    for (const spec of specs) {
      try {
        const raw = readFileSync(join(scopeDir, spec), 'utf8');
        workflowHash = hashRubric((workflowHash ?? '') + raw);
        const specParse = parseWith(workflowNodeStatusSchema, JSON.parse(raw));
        if (!specParse.ok) continue; // malformed spec — no node statuses to record
        const parsed = specParse.data;
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
      goalDocHash: contentHash(join(scopeDir, 'goal.md')),
      rubricHash: contentHash(join(scopeDir, 'rubric.json')),
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

function journalEntries(scopeDir: string): string[] {
  const dir = join(scopeDir, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

/**
 * Parse rather than cast: an entry missing `endedAt`/`state` would otherwise be
 * treated as the open phase and then fail on every field the caller reads.
 * Callers already skip unreadable entries, so a throw here degrades correctly.
 */
function readEntry(scopeDir: string, file: string): PhaseJournalEntry {
  const path = join(scopeDir, JOURNAL_DIR, file);
  return parseJsonOrThrow(phaseJournalEntrySchema, readFileSync(path, 'utf8'), `phase journal entry ${file}`);
}

export function findOpenPhaseEntry(workspaceDir: string): { file: string; entry: PhaseJournalEntry } | null {
  const scopeDir = scopeDirFor(workspaceDir);
  if (!hasMount(workspaceDir)) return null;
  for (const file of journalEntries(scopeDir).reverse()) {
    try {
      const entry = readEntry(scopeDir, file);
      if (!entry.endedAt) return { file, entry };
    } catch { /* skip unreadable */ }
  }
  return null;
}

/** Name of the currently OPEN journal phase for a workspace, or null.
 *  Cheap: one dir listing + parses newest-first until the open entry. */
export function getOpenJournalPhase(workspaceDir: string): string | null {
  return findOpenPhaseEntry(workspaceDir)?.entry.phase ?? null;
}

/** All journal entries for a workspace, oldest first. Empty without a mount. */
export function listPhaseJournalEntries(workspaceDir: string): PhaseJournalEntry[] {
  const scopeDir = scopeDirFor(workspaceDir);
  if (!hasMount(workspaceDir)) return [];
  const out: PhaseJournalEntry[] = [];
  for (const file of journalEntries(scopeDir)) {
    try {
      out.push(readEntry(scopeDir, file));
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Timeline join: phase-start/end append a divider event to the goal
 * validation ledger when the workspace carries a goal. Never blocks the
 * journal write — degrades silently without a goal.
 */
async function appendGoalPhaseMarker(
  projectName: string,
  workspaceName: string,
  phase: string,
  action: 'started' | 'ended',
  note: string,
): Promise<void> {
  try {
    const { appendPhaseMarkerEvent } = await import('./goal-validation.js');
    const { writeGoalRecord } = await import('./goal-chain.js');
    const { withGoalLock } = await import('./goal-lock.js');
    withGoalLock(projectName, () => {
      const goal = readWorkspaceGoal(projectName, workspaceName);
      if (!goal) return;
      writeGoalRecord(projectName, {
        ...goal,
        validation: appendPhaseMarkerEvent(goal.validation, phase, action, note),
      });
    });
  } catch { /* non-fatal: journal entry is already written */ }
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
  const scope = artifactsScope(workspaceDir);
  const seq = String(journalEntries(scope.rootDir).length + 1).padStart(2, '0');
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
  await captureArtifacts(getProjectDir(projectName), scope.mountDir, [
    { path: scope.rel(file), content: JSON.stringify(entry, null, 2) + '\n' },
  ], { message: `journal: start ${input.phase}`, provenance: { tool: 'phase-journal' } });
  await appendGoalPhaseMarker(projectName, workspaceName, input.phase, 'started', input.intent);
  return { file: file.slice(JOURNAL_DIR.length + 1), entry };
}

/**
 * Gate check for closing phase `phase` (goal-rubric-workflow interconnect):
 * blocks only when the phase is KNOWN to the workspace's single workflow and
 * the computed gate is neither satisfied nor human-waived. Unknown phases,
 * absent/broken workflows, and goal-less workspaces behave as before
 * (unblocked) — the interconnect is opt-in via wfPhase on requirements.
 */
function assertPhaseGatePassable(projectName: string, workspaceName: string, workspaceDir: string, phase: string): void {
  const { workflow } = tryLoadWorkspaceWorkflow(workspaceDir);
  if (!workflow || !workflowPhaseNames(workflow).includes(phase)) return;
  const goal = readWorkspaceGoal(projectName, workspaceName);
  if (!goal) return;
  const gate = gateStatusForPhase(goal, phase);
  if (gate.passable) return;
  const lines = [
    `Phase "${phase}" gate is not satisfied — ${gate.unmet.length} owed requirement(s) not accepted:`,
    '',
    ...gate.unmet.map((r) => describeOwedRequirement(r)),
    '',
    'Options:',
    '  1. Produce and judge the evidence above, then retry phase-end.',
    `  2. The contract is wrong → space journal phase-end --revert --reason "…"  (closes this phase as reverted and returns the workflow to plan for requirement rewrite; the gate stays red).`,
    '  3. Ask a human to waive the gate from the goal board UI. Waives are human-only — the CLI has no waive flag.',
  ];
  throw new SpacesError(lines.join('\n'), 'USER_ERROR', 1);
}

export async function endPhaseJournal(
  projectName: string,
  workspaceName: string,
  input: {
    outcome: string;
    decisions?: string[];
    surprises?: string[];
    autoCommit?: boolean;
    /** Escape hatch: close the phase WITHOUT satisfying its gate, marked
     *  reverted (requirements need rewrite). `to` defaults to 'plan'. */
    revert?: { reason: string; to?: string };
  },
  now: Date = new Date(),
): Promise<{ file: string; entry: PhaseJournalEntry }> {
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  const open = findOpenPhaseEntry(workspaceDir);
  if (!open) {
    throw new SpacesError('No open phase — call phase-start first.', 'USER_ERROR', 1);
  }
  const revert = input.revert && input.revert.reason.trim()
    ? { reason: input.revert.reason.trim(), to: input.revert.to?.trim() || 'plan' }
    : undefined;
  if (input.revert && !revert) {
    throw new SpacesError('--revert requires --reason: say why the contract needs rewriting.', 'USER_ERROR', 1);
  }
  if (!revert) {
    // Computed gate: every owed requirement (wfPhase == phase) accepted, or
    // human-waived. Checked BEFORE the auto-commit so a blocked phase-end
    // leaves the repo untouched.
    assertPhaseGatePassable(projectName, workspaceName, workspaceDir, open.entry.phase);
  }
  const scope = artifactsScope(workspaceDir);

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
  const crumbLog = join(scope.rootDir, 'blame', 'edits.jsonl');
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
    ...(revert ? { reverted: revert } : {}),
  };
  await captureArtifacts(getProjectDir(projectName), scope.mountDir, [
    { path: scope.rel(`${JOURNAL_DIR}/${open.file}`), content: JSON.stringify(entry, null, 2) + '\n' },
  ], { message: `journal: end ${open.entry.phase}${revert ? ' (reverted)' : ''}`, provenance: { tool: 'phase-journal' } });
  if (revert) await appendGoalGateRevertMarker(projectName, workspaceName, open.entry.phase, revert);
  await appendGoalPhaseMarker(projectName, workspaceName, open.entry.phase, 'ended', input.outcome.split('\n')[0] ?? '');
  return { file: open.file, entry };
}

/**
 * Timeline join for `phase-end --revert`: records a gate event
 * ("phase reverted → <to>") on the goal ledger. Same degradation contract as
 * appendGoalPhaseMarker — never blocks the journal write.
 */
async function appendGoalGateRevertMarker(
  projectName: string,
  workspaceName: string,
  phase: string,
  revert: { reason: string; to: string },
): Promise<void> {
  try {
    const { appendGateRevertEvent } = await import('./goal-validation.js');
    const { writeGoalRecord } = await import('./goal-chain.js');
    const { withGoalLock } = await import('./goal-lock.js');
    withGoalLock(projectName, () => {
      const goal = readWorkspaceGoal(projectName, workspaceName);
      if (!goal) return;
      writeGoalRecord(projectName, {
        ...goal,
        validation: appendGateRevertEvent(goal.validation, phase, revert.to, revert.reason),
      });
    });
  } catch { /* non-fatal: journal entry is already written */ }
}
