/**
 * Edit breadcrumbs (docs/REVIEW-GUIDE.md, grounding tier 1).
 *
 * The agent coordinator observes every mutating tool call and records
 * {sessionId, toolName, file, ts} into a per-workspace buffer. At turn end
 * (agent idle) the buffer flushes to the workspace's artifacts mount as
 * blame/edits.jsonl — append-only, committed through captureArtifacts so the
 * log is versioned and rolls up with the branch.
 *
 * Attribution for the review-guide narrator becomes a lookup instead of a
 * post-hoc fuzzy match. When the workspace has no artifacts mount the
 * breadcrumbs are dropped silently (graceful degradation — the narrator
 * falls back to transcript matching).
 */

import { existsSync, readFileSync } from 'fs';
import { join, isAbsolute, relative } from 'path';

export interface EditBreadcrumb {
  ts: string;
  sessionId: string;
  toolName: string;
  /** Workspace-relative path of the mutated file (absolute if outside). */
  file: string;
}

/** Tool names whose successful execution mutates the tree. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'multiedit', 'bash', 'patch', 'apply_patch']);

/** input keys that carry the target path, in precedence order. */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'target'] as const;

const buffers = new Map<string, EditBreadcrumb[]>();

export function extractBreadcrumbFile(toolName: string, input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const rec = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  // bash mutations have no structured target; record the command head so the
  // narrator can at least see "something ran here" without trusting it.
  if (toolName === 'bash' && typeof rec.command === 'string') {
    return null; // command-only breadcrumbs add noise, not attribution — skip.
  }
  return null;
}

/** Record a mutating tool call against a workspace. No-op for non-mutating tools. */
export function recordEditBreadcrumb(
  workspacePath: string,
  sessionId: string,
  toolName: string | undefined,
  input: unknown,
  now: Date = new Date(),
): void {
  const tool = (toolName ?? '').toLowerCase();
  if (!MUTATING_TOOLS.has(tool)) return;
  const rawFile = extractBreadcrumbFile(tool, input);
  if (!rawFile) return;
  const file = isAbsolute(rawFile) && rawFile.startsWith(workspacePath)
    ? relative(workspacePath, rawFile)
    : rawFile;
  const buffer = buffers.get(workspacePath) ?? [];
  buffer.push({ ts: now.toISOString(), sessionId, toolName: tool, file });
  buffers.set(workspacePath, buffer);
}

/** Pending crumbs for a workspace (test/introspection helper). */
export function pendingBreadcrumbs(workspacePath: string): readonly EditBreadcrumb[] {
  return buffers.get(workspacePath) ?? [];
}

const BREADCRUMB_LOG = 'blame/edits.jsonl';

/**
 * Flush a workspace's buffered crumbs to the artifacts mount, appending to
 * blame/edits.jsonl in one commit. Returns the number flushed (0 when the
 * buffer is empty or the workspace has no artifacts mount).
 */
export async function flushEditBreadcrumbs(workspacePath: string, projectDir: string): Promise<number> {
  const buffer = buffers.get(workspacePath);
  if (!buffer || buffer.length === 0) return 0;
  const mountDir = join(workspacePath, '.gitspace', 'artifacts');
  if (!existsSync(join(mountDir, '.git'))) return 0; // no mount — degrade silently, keep buffering bounded
  buffers.set(workspacePath, []);
  const logPath = join(mountDir, BREADCRUMB_LOG);
  const existing = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const appended = existing + buffer.map((c) => JSON.stringify(c)).join('\n') + '\n';
  const { captureArtifacts } = await import('../../../core/artifacts.js');
  await captureArtifacts(projectDir, mountDir, [
    { path: BREADCRUMB_LOG, content: appended },
  ], {
    message: `blame: ${buffer.length} edit breadcrumb${buffer.length === 1 ? '' : 's'}`,
    provenance: { tool: 'edit-breadcrumbs' },
  });
  return buffer.length;
}

/** Drop a workspace's buffer without flushing (workspace removal). */
export function discardEditBreadcrumbs(workspacePath: string): void {
  buffers.delete(workspacePath);
}
