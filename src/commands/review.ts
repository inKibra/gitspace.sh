/**
 * Review command — open or interact with the diff review system
 *
 * Primary entry point: `gssh review`
 *   Opens the browser-based review UI at http://localhost:<port>?view=review&workspace=<current>
 *
 * Sub-commands:
 *   gssh review notes [--workspace <name>] [--project <name>]
 *     Print saved review threads as structured JSON (LLM-friendly).
 *
 *   gssh review import [--pr <number>] [--workspace <name>] [--project <name>]
 *     Import GitHub PR review comments as local threads.
 *
 *   gssh review push [--pr <number>] [--workspace <name>] [--project <name>]
 *     Push local review decisions to GitHub as a formal PR review.
 */

import { spawnSync } from 'child_process';
import { readProjectConfig, readGlobalConfig } from '../core/config.js';
import { executeLocalReviewOperation } from '../core/review-executor.js';
import { logger } from '../utils/logger.js';

// Match the port used by `gssh serve` local relay (overridable via RELAY_PORT env)
const DEFAULT_PORT = parseInt(process.env.RELAY_PORT ?? '4480', 10);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the current workspace name from the global config / cwd.
 * Returns null if no workspace context is available.
 */
function resolveCurrentWorkspace(options: {
  workspace?: string;
  project?: string;
}): { projectName: string; workspaceName: string } | null {
  const globalConfig = readGlobalConfig();
  const projectName = options.project ?? globalConfig.currentProject ?? null;

  if (!projectName) {
    return null;
  }

  if (options.workspace) {
    return { projectName, workspaceName: options.workspace };
  }

  // Try to derive workspace name from the global state marker
  // (reads from <project>/.config.json currentWorkspace if set)
  try {
    const projectConfig = readProjectConfig(projectName);
    const workspaceName = (projectConfig as unknown as Record<string, unknown>).currentWorkspace as string | undefined;
    if (workspaceName) {
      return { projectName, workspaceName };
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Open a URL in the default browser (macOS / Linux / Windows).
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  spawnSync(cmd, [url], { stdio: 'ignore' });
}

// ============================================================================
// Main review command (opens browser)
// ============================================================================

export interface ReviewOptions {
  workspace?: string;
  project?: string;
  port?: number;
}

export async function openReview(options: ReviewOptions = {}): Promise<void> {
  const port = options.port ?? DEFAULT_PORT;
  const ctx = resolveCurrentWorkspace(options);

  let url = `http://localhost:${port}?view=review`;
  if (ctx) {
    url += `&workspace=${encodeURIComponent(ctx.workspaceName)}&project=${encodeURIComponent(ctx.projectName)}`;
  }

  logger.log(`Opening review UI: ${url}`);
  logger.log('(Requires `gssh serve start` to be running)');
  openBrowser(url);
}

// ============================================================================
// gssh review notes
// ============================================================================

export interface ReviewNotesOptions {
  workspace?: string;
  project?: string;
  format?: 'json' | 'text';
}

export async function showReviewNotes(options: ReviewNotesOptions = {}): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  const result = await executeLocalReviewOperation({
    op: 'get_threads',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
  });

  if (result.op !== 'threads') {
    logger.error('Unexpected response from review operation');
    process.exit(1);
  }

  const { threads } = result;

  if (options.format === 'text') {
    if (threads.length === 0) {
      logger.log('No review threads found.');
      return;
    }
    for (const thread of threads) {
      const targetStr =
        thread.target.kind === 'hunk'
          ? `hunk ${thread.target.hunkHeader} in ${thread.target.file}`
          : thread.target.kind === 'line'
            ? `lines ${thread.target.startLine}-${thread.target.endLine} in ${thread.target.file}`
            : thread.target.kind === 'file'
              ? `file ${thread.target.file}`
              : 'workspace';
      const decision = thread.decision ? ` [${thread.decision.toUpperCase()}]` : '';
      const resolved = thread.resolved ? ' (resolved)' : '';
      logger.log(`\n--- Thread: ${thread.id}${decision}${resolved} ---`);
      logger.log(`Target: ${targetStr}`);
      for (const comment of thread.comments) {
        logger.log(`  [${comment.author} @ ${comment.createdAt}]: ${comment.body}`);
      }
    }
    return;
  }

  // Default: JSON output for LLM consumption
  console.log(JSON.stringify({ threads }, null, 2));
}

// ============================================================================
// gssh review import
// ============================================================================

export interface ReviewImportOptions {
  workspace?: string;
  project?: string;
  pr?: number;
}

export async function importReview(options: ReviewImportOptions = {}): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  logger.log(`Importing GitHub PR review for ${ctx.projectName}:${ctx.workspaceName}...`);

  const result = await executeLocalReviewOperation({
    op: 'import_github',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
    prNumber: options.pr,
  });

  if (result.op !== 'github_imported') {
    logger.error('Unexpected response from import operation');
    process.exit(1);
  }

  logger.success(`Imported ${result.imported} comment(s) as ${result.threads.length} thread(s).`);
}

// ============================================================================
// gssh review push
// ============================================================================

export interface ReviewPushOptions {
  workspace?: string;
  project?: string;
  pr?: number;
}

export async function pushReview(options: ReviewPushOptions = {}): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  logger.log(`Pushing review for ${ctx.projectName}:${ctx.workspaceName} to GitHub...`);

  const result = await executeLocalReviewOperation({
    op: 'push_github',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
    prNumber: options.pr,
  });

  if (result.op !== 'github_pushed') {
    logger.error('Unexpected response from push operation');
    process.exit(1);
  }

  logger.success(`Review submitted to GitHub: ${result.url}`);
}
