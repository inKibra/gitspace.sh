/**
 * `gssh space workflow` — the workspace's single canonical workflow spec
 * (goal-rubric-workflow interconnect, docs/REVIEW-GUIDE.md).
 */
import { join } from 'path';
import { getProjectWorkspacesDir } from '../core/config.js';
import { resolveWorkspaceGoal } from '../core/goal-chain.js';
import { validateWorkspaceWorkflow } from '../core/goal-workflow.js';
import { logger } from '../utils/logger.js';
import type { SpaceCommandContext } from './space-goals.js';

/**
 * Validate THE workflow against the goal doc. Exit nonzero ONLY on
 * structural errors (multiple *.workflow.json, invalid JSON/schema). Dangling
 * slice refs and phase-name oddities are WARNINGS: amber state data for the UI.
 */
export function validateSpaceWorkflow(ctx: SpaceCommandContext, options: { json?: boolean } = {}): void {
  const workspaceDir = join(getProjectWorkspacesDir(ctx.project), ctx.workspace);
  const goal = resolveWorkspaceGoal(ctx.project, ctx.workspace);
  const result = validateWorkspaceWorkflow(workspaceDir, goal);
  if (options.json) {
    logger.log(JSON.stringify({ ok: result.issues.length === 0, ...result }, null, 2));
    return;
  }
  if (!result.path) {
    logger.log('No workflow spec on the artifacts mount (*.workflow.json) — nothing to validate.');
    return;
  }
  if (result.issues.length > 0) {
    logger.error('Invalid workflow spec:');
    for (const issue of result.issues) logger.error(`  ${issue}`);
    return;
  }
  if (result.warnings.length === 0) {
    logger.success('Valid — no warnings.');
    return;
  }
  for (const warning of result.warnings) {
    logger.warning(warning);
  }
  logger.log(`${result.warnings.length} warning(s) — amber state, not a failure.`);
}
