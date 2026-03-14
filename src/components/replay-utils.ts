/**
 * Shared replay playback utilities used by both TUI and web replay terminals.
 */

import type {
  ReplayFrameTarget,
  ReplayTimelineStep,
} from '../lib/tmux-lite/replay/index.js';

// ============================================================================
// Constants
// ============================================================================

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4] as const;
export const DEFAULT_PLAYBACK_SPEED_INDEX = 2;
export const FAST_SCRUB_STEP_COUNT = 5;

// ============================================================================
// Formatting
// ============================================================================

export function formatReplayTime(timeMs: number): string {
  const totalSeconds = Math.max(0, timeMs) / 1000;
  if (totalSeconds < 59.95) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const wholeSeconds = Math.round(totalSeconds);
  const seconds = wholeSeconds % 60;
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  const hours = Math.floor(wholeSeconds / 3600);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ============================================================================
// Replay frame targeting
// ============================================================================

export function targetKey(target: ReplayFrameTarget | ReplayTimelineStep | null): string | null {
  if (!target) {
    return null;
  }

  const timeMs = 'timeMs' in target ? target.timeMs : target.atMs;
  const seq = 'seq' in target ? target.seq : target.atSeq;
  return `${timeMs ?? -1}:${seq ?? -1}`;
}

export function toFrameTarget(step: ReplayTimelineStep | null, fallback: ReplayFrameTarget): ReplayFrameTarget {
  if (!step) {
    return fallback;
  }

  return {
    atMs: step.timeMs,
    atSeq: step.seq,
  };
}

// ============================================================================
// Math
// ============================================================================

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
