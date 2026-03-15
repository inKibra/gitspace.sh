/**
 * Shared replay playback utilities used by both TUI and web replay terminals.
 */

import type {
  ReplayFrame,
  ReplayFrameEvent,
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

// ============================================================================
// Replay frame application
// ============================================================================

const TERMINAL_RESET = '\x1bc\x1b[2J\x1b[H';

/**
 * Decode base64 string to binary data.
 * Works in both Node.js (Buffer) and browser (atob) environments.
 */
function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(data, 'base64');
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Build ANSI resize sequence (DECSET 8-bit control).
 */
function resizeSequence(cols: number, rows: number): string {
  return `\x1b[8;${rows};${cols}t`;
}

/**
 * Get the checkpoint ID from a replay frame (null if no checkpoint).
 */
export function frameCheckpointId(frame: ReplayFrame): string | null {
  return frame.checkpoint?.checkpointId ?? null;
}

/**
 * Apply a replay frame to a terminal write function.
 *
 * If `previousCheckpointId` matches the frame's checkpoint, skips re-writing
 * the checkpoint ANSI and only applies events after `fromSeq`.
 * Otherwise, resets the terminal, writes the checkpoint, then applies all events.
 *
 * Returns the checkpoint ID that was applied.
 */
export function applyReplayFrame(
  frame: ReplayFrame,
  write: (data: string | Uint8Array) => void,
  previousCheckpointId: string | null,
  fromSeq: number,
): string | null {
  const checkpointId = frame.checkpoint?.checkpointId ?? null;
  const sameCheckpoint = checkpointId !== null && checkpointId === previousCheckpointId;

  if (!sameCheckpoint) {
    // Different checkpoint (or no previous) — reset and write full checkpoint
    write(TERMINAL_RESET);
    if (frame.checkpoint) {
      const checkpointBytes = decodeBase64(frame.checkpoint.ansi);
      write(checkpointBytes);
    }
    // Apply all events
    for (const event of frame.events) {
      applyFrameEvent(event, write);
    }
  } else {
    // Same checkpoint — only apply events after our current position
    for (const event of frame.events) {
      if (event.seq <= fromSeq) {
        continue;
      }
      applyFrameEvent(event, write);
    }
  }

  return checkpointId;
}

function applyFrameEvent(
  event: ReplayFrameEvent,
  write: (data: string | Uint8Array) => void,
): void {
  if (event.type === 'output' && event.data) {
    write(decodeBase64(event.data));
  } else if (event.type === 'resize' && event.cols !== undefined && event.rows !== undefined) {
    write(resizeSequence(event.cols, event.rows));
  }
}

/**
 * Get the last seq number from a replay frame's events,
 * falling back to the checkpoint seq or 0.
 */
export function frameLastSeq(frame: ReplayFrame): number {
  if (frame.events.length > 0) {
    return frame.events[frame.events.length - 1]!.seq;
  }
  return frame.checkpoint?.seq ?? 0;
}
