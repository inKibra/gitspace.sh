/**
 * Shared replay playback utilities used by both TUI and web replay terminals.
 */

import type {
  ReplayFrame,
  ReplayFrameEvent,
  ReplayFrameTarget,
  ReplayTimeline,
  ReplayTimelineStep,
} from '../lib/tmux-lite/replay/index.js';

// ============================================================================
// Constants
// ============================================================================

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4] as const;
export const DEFAULT_PLAYBACK_SPEED_INDEX = 2;

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

export function findCheckpointStepIndex(
  timeline: ReplayTimeline,
  currentSeq: number,
  direction: -1 | 1,
): number {
  if (timeline.steps.length === 0) {
    return -1;
  }

  const checkpoint = direction < 0
    ? [...timeline.checkpointSteps].reverse().find((step) => step.seq < currentSeq)
    : timeline.checkpointSteps.find((step) => step.seq > currentSeq);

  if (!checkpoint) {
    return direction < 0 ? 0 : timeline.steps.length - 1;
  }

  const stepIndex = timeline.steps.findIndex(
    (step) => step.seq >= checkpoint.seq && step.timeMs >= checkpoint.timeMs,
  );

  return stepIndex >= 0 ? stepIndex : (direction < 0 ? 0 : timeline.steps.length - 1);
}

export function getCheckpointPosition(
  timeline: ReplayTimeline | null,
  currentSeq: number,
): { current: number; total: number } | null {
  if (!timeline || timeline.checkpointSteps.length === 0) {
    return null;
  }

  let current = 0;
  for (const checkpoint of timeline.checkpointSteps) {
    if (checkpoint.seq <= currentSeq) {
      current += 1;
    } else {
      break;
    }
  }

  return {
    current,
    total: timeline.checkpointSteps.length,
  };
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
  if (typeof atob === 'function') {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(data, 'base64'));
  }

  throw new Error('No base64 decoder available');
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
  // Two null checkpoints count as "same" only if we've already applied events (fromSeq > 0),
  // otherwise it's a fresh load that needs a terminal reset.
  const sameCheckpoint = checkpointId === previousCheckpointId && (checkpointId !== null || fromSeq > 0);
  const lastEventSeq = frame.events.length > 0 ? frame.events[frame.events.length - 1]!.seq : 0;
  const isForward = sameCheckpoint && lastEventSeq > fromSeq;

  if (sameCheckpoint && isForward) {
    // Same checkpoint, forward step — only apply events after our current position
    for (const event of frame.events) {
      if (event.seq <= fromSeq) {
        continue;
      }
      applyFrameEvent(event, write);
    }
  } else {
    // Different checkpoint, backward step, or first load — reset and replay from checkpoint
    write(TERMINAL_RESET);
    if (frame.checkpoint) {
      const checkpointBytes = decodeBase64(frame.checkpoint.ansi);
      if (checkpointBytes.byteLength > 0) {
        write(checkpointBytes);
      }
    }
    for (const event of frame.events) {
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
    const bytes = decodeBase64(event.data);
    if (bytes.byteLength > 0) {
      write(bytes);
    }
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
