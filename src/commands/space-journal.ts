/**
 * `gssh space journal` — phase-boundary journaling (docs/REVIEW-GUIDE.md).
 * The agent supplies the narrative; state snapshots happen server-side.
 * phase-start prints the phase's OWED CONTRACT (requirements the gate will
 * count); phase-end is blocked by an unsatisfied gate unless --revert.
 */
import { startPhaseJournal, endPhaseJournal, findOpenPhaseEntry } from '../core/phase-journal.js';
import { getProjectWorkspacesDir } from '../core/config.js';
import { resolveWorkspaceGoal } from '../core/goal-chain.js';
import { describeOwedRequirement, gateStatusForPhase, workflowPhaseNames } from '../core/goal-gates.js';
import { tryLoadWorkspaceWorkflow } from '../core/goal-workflow.js';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { SpaceCommandContext } from './space-goals.js';

function printJson(value: unknown): void {
  logger.log(JSON.stringify(value, null, 2));
}

/** Warnings go to stderr so --json stdout stays parseable. */
function warnStderr(message: string): void {
  console.error(`⚠ ${message}`);
}

export async function journalPhaseStart(
  ctx: SpaceCommandContext,
  options: { phase: string; intent: string; workflowRef?: string; json?: boolean },
): Promise<void> {
  const workspaceDir = join(getProjectWorkspacesDir(ctx.project), ctx.workspace);

  // Phase canon: the active workflow's phase list is canonical. Free-form
  // names stay allowed (no gate attaches), but warn so typos surface now.
  const { workflow, error } = tryLoadWorkspaceWorkflow(workspaceDir);
  if (error) warnStderr(error);
  const knownPhases = workflowPhaseNames(workflow);
  if (knownPhases.length > 0 && !knownPhases.includes(options.phase)) {
    warnStderr(`Phase "${options.phase}" is not in the active workflow (${workflow!.path}). Known phases: ${knownPhases.join(', ')}. No gate will attach to it.`);
  }

  const { file, entry } = await startPhaseJournal(ctx.project, ctx.workspace, options);

  // The owed contract: requirements this phase's gate will count
  // (wfPhase == phase), printed so the agent starts with the rubric in hand.
  const goal = resolveWorkspaceGoal(ctx.project, ctx.workspace);
  const gate = goal ? gateStatusForPhase(goal, options.phase) : null;
  if (options.json) {
    printJson({ file, entry, gate: gate ? { phase: gate.phase, satisfied: gate.satisfied, waived: gate.waived, owed: gate.owed } : null });
    return;
  }
  logger.success(`Phase "${entry.phase}" started (${file}). State snapshotted; end it with: gssh space journal phase-end --outcome "..."`);
  if (gate && gate.owed.length > 0) {
    logger.log('');
    logger.log(`This phase owes ${gate.owed.length} requirement(s) — phase-end is gated on all required ones being accepted:`);
    for (const r of gate.owed) logger.log(describeOwedRequirement(r));
  } else if (knownPhases.includes(options.phase)) {
    logger.log('No requirements are owed by this phase yet — its gate is trivially satisfied. Declare owed work with: space goal requirement add … --phase "' + options.phase + '"');
  }
}

export async function journalPhaseEnd(
  ctx: SpaceCommandContext,
  options: {
    outcome?: string;
    decision?: string[];
    surprise?: string[];
    noCommit?: boolean;
    revert?: boolean;
    reason?: string;
    to?: string;
    json?: boolean;
  },
): Promise<void> {
  const outcome = options.outcome
    ?? (options.revert ? `reverted → ${options.to?.trim() || 'plan'}: ${options.reason ?? ''}`.trim() : undefined);
  if (!outcome) {
    logger.error('--outcome is required (it becomes the journal record and commit headline).');
    process.exit(1);
  }
  const { file, entry } = await endPhaseJournal(ctx.project, ctx.workspace, {
    outcome,
    decisions: options.decision,
    surprises: options.surprise,
    autoCommit: !options.noCommit,
    revert: options.revert ? { reason: options.reason ?? '', to: options.to } : undefined,
  });
  if (options.json) { printJson({ file, entry }); return; }
  const delta = entry.delta!;
  const bits = [
    entry.reverted ? `REVERTED → ${entry.reverted.to} (gate stays red)` : null,
    delta.requirementsAdvanced.length ? `${delta.requirementsAdvanced.length} requirement(s) advanced` : null,
    delta.evidenceAdded.length ? `${delta.evidenceAdded.length} evidence added` : null,
    delta.threadsResolved ? `${delta.threadsResolved} thread(s) resolved` : null,
    delta.canonChanged.length ? `CANON CHANGED: ${delta.canonChanged.join(', ')}` : null,
    entry.commits.autoCommit ? `committed ${entry.commits.autoCommit.slice(0, 7)}` : null,
  ].filter(Boolean);
  logger.success(`Phase "${entry.phase}" ended (${file}). ${bits.join(' · ') || 'no state motion'}`);
}

export function journalStatus(ctx: SpaceCommandContext, options: { json?: boolean }): void {
  const workspaceDir = join(getProjectWorkspacesDir(ctx.project), ctx.workspace);
  const open = findOpenPhaseEntry(workspaceDir);
  if (options.json) { printJson({ open: open ? { file: open.file, phase: open.entry.phase, startedAt: open.entry.startedAt } : null }); return; }
  logger.log(open ? `Open phase: "${open.entry.phase}" since ${open.entry.startedAt} (${open.file})` : 'No open phase.');
}
