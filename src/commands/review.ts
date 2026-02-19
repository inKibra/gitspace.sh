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
 *
 *   gssh review hunks <file>
 *     List hunks in a changed file with stable index and header.
 *
 *   gssh review add-hunk <file> --index <n> [--approve|--reject|--pending] [--body <text>]
 *     Add or update a hunk-level review decision/comment.
 *
 *   gssh review add-file <file> --body <text>
 *     Add a file-level review thread.
 *
 *   gssh review add-line <file> --start <n> [--end <n>] [--side LEFT|RIGHT] --body <text>
 *     Add a line-range review thread.
 */

import open from 'open';
import { readProjectConfig, readGlobalConfig, getGitspaceDir } from '../core/config.js';
import { executeLocalReviewOperation } from '../core/review-executor.js';
import { logger } from '../utils/logger.js';
import { normalizeHunkHeader } from '../utils/hunk-header.js';
import { detectWorkspaceContextFromCwd } from '../utils/workspace-id.js';
import type { HunkDecision, ReviewChangedFile, ReviewThread } from '../types/review.js';

// Match the port used by `gssh serve` local relay (overridable via RELAY_PORT env)
const DEFAULT_PORT = parseInt(process.env.RELAY_PORT ?? '4480', 10);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the current workspace name from the global config / cwd.
 * Returns null if no workspace context is available.
 */
function detectWorkspaceFromCwd(): { projectName: string; workspaceName: string } | null {
  return detectWorkspaceContextFromCwd(process.cwd(), getGitspaceDir());
}

function resolveCurrentWorkspace(options: {
  workspace?: string;
  project?: string;
}): { projectName: string; workspaceName: string } | null {
  const envProject = process.env.GSSH_SPACE_PROJECT;
  const envWorkspace = process.env.GSSH_SPACE_WORKSPACE;
  const cwdContext = detectWorkspaceFromCwd();
  const globalConfig = readGlobalConfig();
  const projectName =
    options.project ??
    envProject ??
    cwdContext?.projectName ??
    globalConfig.currentProject ??
    null;

  if (!projectName) {
    return null;
  }

  if (options.workspace) {
    return { projectName, workspaceName: options.workspace };
  }

  if (envWorkspace && (!envProject || envProject === projectName)) {
    return { projectName, workspaceName: envWorkspace };
  }

  if (cwdContext && cwdContext.projectName === projectName) {
    return { projectName, workspaceName: cwdContext.workspaceName };
  }

  // Try to derive workspace name from the global state marker
  // (reads from <project>/.config.json currentWorkspace if set)
  try {
    const projectConfig = readProjectConfig(projectName);
    const workspaceValue = (projectConfig as { currentWorkspace?: unknown }).currentWorkspace;
    const workspaceName = typeof workspaceValue === 'string' ? workspaceValue : undefined;
    if (workspaceName) {
      return { projectName, workspaceName };
    }
  } catch {
    // ignore
  }

  return null;
}

export interface SpaceContextOptions {
  workspace?: string;
  project?: string;
  json?: boolean;
}

export async function showSpaceContext(options: SpaceContextOptions = {}): Promise<void> {
  const context = resolveCurrentWorkspace(options);
  const payload = {
    mode: process.env.GSSH_SESSION_MODE ?? null,
    tmuxSessionId: process.env.TMUX_LITE ?? null,
    context,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!context) {
    logger.log('No workspace context resolved.');
    return;
  }

  logger.log(`Project: ${context.projectName}`);
  logger.log(`Workspace: ${context.workspaceName}`);
}

function parseHunksFromDiff(diff: string): Array<{
  index: number;
  header: string;
  context: string | null;
  targetRef: string;
}> {
  const lines = diff.split('\n');
  const hunks: Array<{
    index: number;
    header: string;
    context: string | null;
    targetRef: string;
  }> = [];

  let index = 1;
  for (const line of lines) {
    if (!line.startsWith('@@')) continue;
    const header = normalizeHunkHeader(line);
    const contextMatch = header.match(/^@@[^@]*@@(?:\s+(.*))?$/);
    const context = contextMatch && contextMatch[1] ? contextMatch[1] : null;
    hunks.push({
      index,
      header,
      context,
      targetRef: `hunk:${index}`,
    });
    index++;
  }

  return hunks;
}

function formatThreadTarget(
  target: ReviewThread['target']
): { targetRef: string; targetSummary: string } {
  switch (target.kind) {
    case 'hunk':
      return {
        targetRef: `hunk:${target.file}:${target.hunkHeader}`,
        targetSummary: `hunk in ${target.file} (${target.hunkHeader})`,
      };
    case 'line':
      return {
        targetRef: `line:${target.file}:${target.side}:${target.startLine}-${target.endLine}`,
        targetSummary: `lines ${target.startLine}-${target.endLine} (${target.side}) in ${target.file}`,
      };
    case 'file':
      return {
        targetRef: `file:${target.file}`,
        targetSummary: `file ${target.file}`,
      };
    case 'workspace':
      return {
        targetRef: 'workspace',
        targetSummary: 'workspace',
      };
  }
}

function parseDecisionFlags(options: {
  approve?: boolean;
  reject?: boolean;
  pending?: boolean;
}): HunkDecision | undefined {
  const selected = [
    options.approve ? 'approved' : null,
    options.reject ? 'rejected' : null,
    options.pending ? 'pending' : null,
  ].filter((value): value is HunkDecision => value !== null);

  if (selected.length > 1) {
    throw new Error('Choose only one decision flag: --approve, --reject, or --pending.');
  }

  return selected[0];
}

function defaultDecisionBody(decision?: HunkDecision): string {
  if (decision === 'approved') return 'Approved hunk via CLI.';
  if (decision === 'rejected') return 'Rejected hunk via CLI.';
  if (decision === 'pending') return 'Marked hunk as pending via CLI.';
  return '';
}

async function getChangedFilesForContext(ctx: {
  projectName: string;
  workspaceName: string;
}): Promise<ReviewChangedFile[]> {
  const result = await executeLocalReviewOperation({
    op: 'get_changed_files',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
  });

  if (result.op !== 'changed_files') {
    throw new Error(`Unexpected response from get_changed_files: ${result.op}`);
  }

  return result.files;
}

function resolveChangedFile(
  changedFiles: ReviewChangedFile[],
  inputFile: string
): ReviewChangedFile {
  const exact = changedFiles.find(
    (file) => file.filePath === inputFile || file.prevFilePath === inputFile
  );
  if (exact) return exact;

  const suffixMatches = changedFiles.filter(
    (file) =>
      file.filePath.endsWith(`/${inputFile}`) ||
      (file.prevFilePath ? file.prevFilePath.endsWith(`/${inputFile}`) : false)
  );

  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  if (suffixMatches.length > 1) {
    const choices = suffixMatches.slice(0, 8).map((file) => `- ${file.filePath}`).join('\n');
    throw new Error(
      `File path is ambiguous: ${inputFile}\nMatches:\n${choices}\nPlease provide a full path.`
    );
  }

  const sample = changedFiles.slice(0, 12).map((file) => `- ${file.filePath}`).join('\n');
  throw new Error(
    `File is not changed in this workspace: ${inputFile}\nChanged files:\n${sample}`
  );
}

/**
 * Open a URL in the default browser.
 */
async function openBrowser(url: string): Promise<void> {
  try {
    await open(url, { wait: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warning(`Could not open browser automatically: ${message}`);
  }
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
  await openBrowser(url);
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

  const formatted = threads.map((thread) => {
    const { targetRef, targetSummary } = formatThreadTarget(thread.target);
    return {
      ...thread,
      targetRef,
      targetSummary,
      targetKind: thread.target.kind,
      ...(thread.target.kind === 'hunk' ? { hunkHeader: thread.target.hunkHeader } : {}),
    };
  });

  if (options.format === 'text') {
    if (threads.length === 0) {
      logger.log('No review threads found.');
      return;
    }
    for (const thread of formatted) {
      const decision = thread.decision ? ` [${thread.decision.toUpperCase()}]` : '';
      const resolved = thread.resolved ? ' (resolved)' : '';
      logger.log(`\n--- Thread: ${thread.id}${decision}${resolved} ---`);
      logger.log(`Target: ${thread.targetSummary}`);
      logger.log(`Target Ref: ${thread.targetRef}`);
      if (thread.targetKind === 'hunk' && thread.hunkHeader) {
        logger.log(`Hunk Header: ${thread.hunkHeader}`);
      }
      for (const comment of thread.comments) {
        logger.log(`  [${comment.author} @ ${comment.createdAt}]: ${comment.body}`);
      }
    }
    return;
  }

  // Default: JSON output for LLM consumption
  console.log(JSON.stringify({ threads: formatted }, null, 2));
}

// ============================================================================
// gssh review hunks
// ============================================================================

export interface ReviewHunksOptions {
  workspace?: string;
  project?: string;
  format?: 'json' | 'text';
}

export async function listReviewHunks(file: string, options: ReviewHunksOptions = {}): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  const changed = await getChangedFilesForContext(ctx);
  const resolvedFile = resolveChangedFile(changed, file);

  const result = await executeLocalReviewOperation({
    op: 'get_file_diff',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
    filePath: resolvedFile.filePath,
    prevFilePath: resolvedFile.prevFilePath,
  });

  if (result.op !== 'file_diff') {
    logger.error('Unexpected response from get_file_diff operation');
    process.exit(1);
  }

  const hunks = parseHunksFromDiff(result.diff).map((hunk) => ({
    ...hunk,
    file: resolvedFile.filePath,
    targetRef: `hunk:${resolvedFile.filePath}:${hunk.index}`,
  }));

  if (options.format === 'text') {
    if (hunks.length === 0) {
      logger.log(`No hunks found in ${resolvedFile.filePath}.`);
      return;
    }
    logger.log(`Hunks in ${resolvedFile.filePath}:`);
    for (const hunk of hunks) {
      const context = hunk.context ? `  ${hunk.context}` : '';
      logger.log(`  [${hunk.index}] ${hunk.header}${context}`);
    }
    return;
  }

  console.log(
    JSON.stringify(
      {
        file: resolvedFile.filePath,
        prevFilePath: resolvedFile.prevFilePath,
        hunks,
      },
      null,
      2
    )
  );
}

// ============================================================================
// gssh review add-hunk
// ============================================================================

export interface ReviewAddHunkOptions {
  workspace?: string;
  project?: string;
  index: number;
  body?: string;
  approve?: boolean;
  reject?: boolean;
  pending?: boolean;
  json?: boolean;
}

export async function addHunkReview(file: string, options: ReviewAddHunkOptions): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  if (!Number.isFinite(options.index) || options.index < 1) {
    logger.error('--index must be a positive integer (1-based).');
    process.exit(1);
  }

  const decision = parseDecisionFlags(options);
  const body = options.body?.trim() ?? '';
  if (!decision && !body) {
    logger.error('Provide at least one of: --approve/--reject/--pending or --body <text>.');
    process.exit(1);
  }

  const changed = await getChangedFilesForContext(ctx);
  const resolvedFile = resolveChangedFile(changed, file);

  const diffResult = await executeLocalReviewOperation({
    op: 'get_file_diff',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
    filePath: resolvedFile.filePath,
    prevFilePath: resolvedFile.prevFilePath,
  });

  if (diffResult.op !== 'file_diff') {
    logger.error('Unexpected response from get_file_diff operation');
    process.exit(1);
  }

  const hunks = parseHunksFromDiff(diffResult.diff);
  const chosen = hunks.find((hunk) => hunk.index === options.index);
  if (!chosen) {
    logger.error(`Hunk index ${options.index} not found in ${resolvedFile.filePath}.`);
    process.exit(1);
  }
  const chosenHeader = normalizeHunkHeader(chosen.header);

  const threadsResult = await executeLocalReviewOperation({
    op: 'get_threads',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
  });

  if (threadsResult.op !== 'threads') {
    logger.error('Unexpected response from get_threads operation');
    process.exit(1);
  }

  const existing = threadsResult.threads.find(
    (thread) =>
      thread.target.kind === 'hunk' &&
      thread.target.file === resolvedFile.filePath &&
      normalizeHunkHeader(thread.target.hunkHeader) === chosenHeader
  );

  let createdOrUpdatedThreadId = existing?.id;

  if (existing && decision) {
    await executeLocalReviewOperation({
      op: 'update_thread',
      projectName: ctx.projectName,
      workspaceName: ctx.workspaceName,
      threadId: existing.id,
      decision,
    });
  }

  if (existing && body) {
    await executeLocalReviewOperation({
      op: 'add_reply',
      projectName: ctx.projectName,
      workspaceName: ctx.workspaceName,
      threadId: existing.id,
      body,
    });
  }

  if (!existing) {
    const createResult = await executeLocalReviewOperation({
      op: 'create_thread',
      projectName: ctx.projectName,
      workspaceName: ctx.workspaceName,
      target: {
        kind: 'hunk',
        file: resolvedFile.filePath,
        hunkHeader: chosenHeader,
      },
      body: body || defaultDecisionBody(decision),
      decision,
    });

    if (createResult.op !== 'thread_created') {
      logger.error('Unexpected response from create_thread operation');
      process.exit(1);
    }
    createdOrUpdatedThreadId = createResult.thread.id;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          file: resolvedFile.filePath,
          hunkIndex: chosen.index,
          hunkHeader: chosenHeader,
          targetRef: `hunk:${resolvedFile.filePath}:${chosen.index}`,
          decision: decision ?? null,
          threadId: createdOrUpdatedThreadId ?? null,
          reusedThread: Boolean(existing),
          bodyAdded: body.length > 0,
        },
        null,
        2
      )
    );
    return;
  }

  logger.success(
    `${existing ? 'Updated' : 'Added'} hunk review on ${resolvedFile.filePath} [${chosen.index}] (${chosenHeader})`
  );
}

// ============================================================================
// gssh review add-file
// ============================================================================

export interface ReviewAddFileOptions {
  workspace?: string;
  project?: string;
  body: string;
  json?: boolean;
}

export async function addFileReview(file: string, options: ReviewAddFileOptions): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  const body = options.body?.trim();
  if (!body) {
    logger.error('--body is required for add-file.');
    process.exit(1);
  }

  const changed = await getChangedFilesForContext(ctx);
  const resolvedFile = resolveChangedFile(changed, file);

  const result = await executeLocalReviewOperation({
    op: 'create_thread',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
    target: { kind: 'file', file: resolvedFile.filePath },
    body,
  });

  if (result.op !== 'thread_created') {
    logger.error('Unexpected response from create_thread operation');
    process.exit(1);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          threadId: result.thread.id,
          targetRef: `file:${resolvedFile.filePath}`,
          file: resolvedFile.filePath,
        },
        null,
        2
      )
    );
    return;
  }

  logger.success(`Added file review thread for ${resolvedFile.filePath}.`);
}

// ============================================================================
// gssh review add-line
// ============================================================================

export interface ReviewAddLineOptions {
  workspace?: string;
  project?: string;
  start: number;
  end?: number;
  side?: 'LEFT' | 'RIGHT' | string;
  body: string;
  json?: boolean;
}

export async function addLineReview(file: string, options: ReviewAddLineOptions): Promise<void> {
  const ctx = resolveCurrentWorkspace(options);
  if (!ctx) {
    logger.error('Could not determine current project/workspace. Use --project and --workspace flags.');
    process.exit(1);
  }

  if (!Number.isFinite(options.start) || options.start < 1) {
    logger.error('--start must be a positive integer.');
    process.exit(1);
  }

  const normalizedEnd = options.end && Number.isFinite(options.end)
    ? Math.max(options.start, options.end)
    : options.start;

  const normalizedSide = String(options.side ?? 'RIGHT').toUpperCase();
  if (normalizedSide !== 'LEFT' && normalizedSide !== 'RIGHT') {
    logger.error('--side must be LEFT or RIGHT.');
    process.exit(1);
  }

  const body = options.body?.trim();
  if (!body) {
    logger.error('--body is required for add-line.');
    process.exit(1);
  }

  const changed = await getChangedFilesForContext(ctx);
  const resolvedFile = resolveChangedFile(changed, file);

  const result = await executeLocalReviewOperation({
    op: 'create_thread',
    projectName: ctx.projectName,
    workspaceName: ctx.workspaceName,
    target: {
      kind: 'line',
      file: resolvedFile.filePath,
      startLine: options.start,
      endLine: normalizedEnd,
      side: normalizedSide,
    },
    body,
  });

  if (result.op !== 'thread_created') {
    logger.error('Unexpected response from create_thread operation');
    process.exit(1);
  }

  const targetRef = `line:${resolvedFile.filePath}:${normalizedSide}:${options.start}-${normalizedEnd}`;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          threadId: result.thread.id,
          targetRef,
          file: resolvedFile.filePath,
          side: normalizedSide,
          start: options.start,
          end: normalizedEnd,
        },
        null,
        2
      )
    );
    return;
  }

  logger.success(
    `Added line review thread for ${resolvedFile.filePath}:${options.start}-${normalizedEnd} (${normalizedSide}).`
  );
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

  logger.success(`Imported ${result.imported} new thread(s) from GitHub (${result.threads.length} total).`);
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
