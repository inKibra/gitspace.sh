/**
 * Offline replay service.
 *
 * Reads replay artifacts directly from disk without requiring a live tmux-lite
 * daemon. Use this for replay browsing, screenshot export, and dismissal flows
 * so they remain usable after a daemon crash.
 *
 * The tmux-lite daemon path (cli.ts) is still available for operations that
 * require live server state (e.g. creating new sessions). This module is
 * specifically for historical replay access.
 */

import { reconstructReplayAt } from './reconstruct.js';
import { getReplaySnapshot } from './snapshot.js';
import { extractStyledRows, writeReplayScreenshot, type StyledRow, type StyledSpan } from './screenshot.js';
import {
  listReplayInfos,
  listReplayCheckpoints,
  readReplayEvents,
  readReplayManifest,
  dismissReplay,
  undismissReplay,
  deleteReplay,
  pruneExpiredReplays,
  getReplayStorageSummary,
  type ReplayListFilter,
} from './store.js';
import type {
  ReplayFrameTarget,
  ReplayInfo,
  ReplayTimeline,
  ReplayTimelineStep,
  TerminalSnapshot,
} from './types.js';
import { SpacesError } from '../../../types/errors.js';
import { logger } from '../../../utils/logger.js';

export type { ReplayInfo, TerminalSnapshot, ReplayListFilter, StyledRow, StyledSpan };

export interface OfflineReplayTextOptions {
  atMs?: number;
  scrollbackLines?: number;
  includeScrollback?: boolean;
  trimTrailingBlankRows?: boolean;
}

export interface OfflineReplaySnapshotOptions {
  atMs?: number;
  scrollbackLines?: number;
}

export interface OfflineReplayScreenshotOptions {
  outputPath: string;
  atMs?: number;
  scrollbackLines?: number;
  includeScrollback?: boolean;
}

function getLatestReplayTime(
  durationMs: number,
  checkpoints: Array<{ t: number }>,
  events: Array<{ t: number }>,
): number {
  const latestEventTime = events.length > 0 ? events[events.length - 1]?.t ?? 0 : 0;
  const latestCheckpointTime = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1]?.t ?? 0 : 0;
  return Math.max(durationMs, latestEventTime, latestCheckpointTime);
}

function appendUniqueStep(steps: ReplayTimelineStep[], next: ReplayTimelineStep): void {
  const previous = steps[steps.length - 1];
  if (previous && previous.timeMs === next.timeMs && previous.seq === next.seq) {
    return;
  }
  steps.push(next);
}

// ============================================================================
// List
// ============================================================================

export function listReplaysOffline(filter: ReplayListFilter = {}): ReplayInfo[] {
  return listReplayInfos(filter);
}

export function resolveReplayOffline(ref: string, filter: ReplayListFilter = {}): ReplayInfo {
  const all = listReplayInfos({
    ...filter,
    includeDismissed: filter.includeDismissed ?? false,
  });

  const exactMatches = all.filter(
    (r) => r.replayId === ref || r.sessionId === ref || r.sessionName === ref,
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  if (exactMatches.length > 1) {
    logger.error(`[replay.service] Replay reference is ambiguous: ${ref}`);
    throw new SpacesError(`Replay reference is ambiguous: ${ref}`, 'USER_ERROR', 1);
  }

  const prefixMatches = all.filter((r) => r.replayId.startsWith(ref));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    logger.error(`[replay.service] Replay reference matches multiple replay IDs: ${ref}`);
    throw new SpacesError(`Replay reference matches multiple replay IDs: ${ref}`, 'USER_ERROR', 1);
  }

  logger.error(`[replay.service] Replay not found: ${ref}`);
  throw new SpacesError(`Replay not found: ${ref}`, 'USER_ERROR', 1);
}

export function getReplayTimelineOffline(replayId: string): ReplayTimeline {
  const manifest = readReplayManifest(replayId);
  if (!manifest) {
    logger.error(`[replay.service] Replay manifest not found: ${replayId}`);
    throw new SpacesError(`Replay manifest not found: ${replayId}`, 'USER_ERROR', 1);
  }

  const events = readReplayEvents(replayId);
  const checkpoints = listReplayCheckpoints(replayId);
  const latestTimeMs = getLatestReplayTime(manifest.stats.durationMs, checkpoints, events);

  const steps: ReplayTimelineStep[] = [];
  appendUniqueStep(steps, { timeMs: 0, seq: 0 });

  for (const event of events) {
    if (event.type === 'input' || event.type === 'marker') {
      continue;
    }
    appendUniqueStep(steps, { timeMs: event.t, seq: event.seq });
  }

  appendUniqueStep(steps, {
    timeMs: latestTimeMs,
    seq: manifest.stats.lastSeq,
  });

  return {
    replayId,
    durationMs: manifest.stats.durationMs,
    latestTimeMs,
    steps,
    checkpointSteps: checkpoints.map((checkpoint) => ({
      timeMs: checkpoint.t,
      seq: checkpoint.seq,
    })),
  };
}

// ============================================================================
// Read
// ============================================================================

export async function getReplayTextOffline(
  replayId: string,
  options: OfflineReplayTextOptions = {},
): Promise<string> {
  const snapshot = await getReplaySnapshot(replayId, {
    atMs: options.atMs,
    scrollbackLines: options.scrollbackLines,
  });
  const lines = options.includeScrollback
    ? [...snapshot.screen.scrollbackTail, ...snapshot.screen.visible]
    : [...snapshot.screen.visible];

  if (options.trimTrailingBlankRows !== false) {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === '') {
      end--;
    }
    return lines.slice(0, end).join('\n');
  }

  return lines.join('\n');
}

export async function getReplaySnapshotOffline(
  replayId: string,
  options: OfflineReplaySnapshotOptions = {},
): Promise<TerminalSnapshot> {
  return getReplaySnapshot(replayId, options);
}

export async function getReplayStyledRowsOffline(
  replayId: string,
  atMs?: number,
  atSeq?: number,
): Promise<StyledRow[]> {
  const state = await reconstructReplayAt(replayId, atMs, atSeq);
  try {
    return extractStyledRows(state.xterm, { trimTrailingBlank: true });
  } finally {
    state.xterm.dispose();
  }
}

// ============================================================================
// ANSI encoder — styled rows → escape sequences for Ghostty/TUI rendering
// ============================================================================

function hexColorToRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    return null;
  }
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function spanToSgr(span: StyledSpan): string {
  const codes: number[] = [0]; // always reset first

  if (span.bold) codes.push(1);
  if (span.dim) codes.push(2);
  if (span.italic) codes.push(3);
  if (span.underline) codes.push(4);
  if (span.strikethrough) codes.push(9);

  const fgRgb = hexColorToRgb(span.fg);
  if (fgRgb) {
    codes.push(38, 2, fgRgb[0], fgRgb[1], fgRgb[2]);
  }

  if (span.bg !== null) {
    const bgRgb = hexColorToRgb(span.bg);
    if (bgRgb) {
      codes.push(48, 2, bgRgb[0], bgRgb[1], bgRgb[2]);
    }
  }

  return `\x1b[${codes.join(';')}m`;
}

export function styledRowsToAnsi(rows: StyledRow[]): Buffer {
  const parts: string[] = ['\x1b[2J\x1b[H']; // clear + cursor home

  for (const row of rows) {
    for (const span of row) {
      parts.push(spanToSgr(span));
      parts.push(span.text);
    }
    parts.push('\x1b[0m\r\n');
  }

  parts.push('\x1b[0m');
  return Buffer.from(parts.join(''), 'utf8');
}

export async function getReplayAnsiBufferOffline(
  replayId: string,
  target: ReplayFrameTarget = {},
): Promise<Buffer> {
  const state = await reconstructReplayAt(replayId, target.atMs, target.atSeq);
  try {
    const rows = extractStyledRows(state.xterm, { trimTrailingBlank: true });
    return styledRowsToAnsi(rows);
  } finally {
    state.xterm.dispose();
  }
}

// ============================================================================
// Screenshot
// ============================================================================

export async function screenshotReplayOffline(
  replayId: string,
  options: OfflineReplayScreenshotOptions,
): Promise<string> {
  return writeReplayScreenshot(replayId, options);
}

// ============================================================================
// Lifecycle
// ============================================================================

export function dismissReplayOffline(replayId: string, dismissedBy?: string): void {
  dismissReplay(replayId, dismissedBy);
}

export function undismissReplayOffline(replayId: string): void {
  undismissReplay(replayId);
}

export function deleteReplayOffline(replayId: string): void {
  deleteReplay(replayId);
}

export function pruneExpiredReplaysOffline(now?: number): number {
  return pruneExpiredReplays(now);
}

export function getReplayStorageSummaryOffline(filter?: ReplayListFilter): import('./types.js').ReplayStorageSummary {
  return getReplayStorageSummary(filter);
}
