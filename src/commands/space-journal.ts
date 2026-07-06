/**
 * `gssh space journal` — phase-boundary journaling (docs/REVIEW-GUIDE.md).
 * The agent supplies the narrative; state snapshots happen server-side.
 */
import { startPhaseJournal, endPhaseJournal, findOpenPhaseEntry } from '../core/phase-journal.js';
import { getProjectWorkspacesDir } from '../core/config.js';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { SpaceCommandContext } from './space-goals.js';

function printJson(value: unknown): void {
  logger.log(JSON.stringify(value, null, 2));
}

export async function journalPhaseStart(
  ctx: SpaceCommandContext,
  options: { phase: string; intent: string; workflowRef?: string; json?: boolean },
): Promise<void> {
  const { file, entry } = await startPhaseJournal(ctx.project, ctx.workspace, options);
  if (options.json) { printJson({ file, entry }); return; }
  logger.success(`Phase "${entry.phase}" started (${file}). State snapshotted; end it with: gssh space journal phase-end --outcome "..."`);
}

export async function journalPhaseEnd(
  ctx: SpaceCommandContext,
  options: { outcome: string; decision?: string[]; surprise?: string[]; noCommit?: boolean; json?: boolean },
): Promise<void> {
  const { file, entry } = await endPhaseJournal(ctx.project, ctx.workspace, {
    outcome: options.outcome,
    decisions: options.decision,
    surprises: options.surprise,
    autoCommit: !options.noCommit,
  });
  if (options.json) { printJson({ file, entry }); return; }
  const delta = entry.delta!;
  const bits = [
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
