import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot } from '../../../core/paths.js';
import { SpacesError } from '../../../types/errors.js';
import { logger } from '../../../utils/logger.js';
import { getReplayDir as getTmuxLiteReplayDir } from '../protocol.js';

const VALID_REPLAY_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function getConfiguredReplayRootDir(): string {
  const configured = process.env.TMUX_LITE_REPLAY_DIR?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.TMUX_LITE_SANDBOX?.trim()) {
    return getTmuxLiteReplayDir();
  }
  return join(getWorkspaceRoot(), '.tmux-lite', 'replays');
}

export function assertValidReplayId(replayId: string): void {
  if (!replayId || !VALID_REPLAY_ID_PATTERN.test(replayId)) {
    logger.error(`[replay.paths] Invalid replay ID: ${String(replayId)}`);
    throw new SpacesError(`Invalid replay ID: ${replayId}`, 'USER_ERROR', 1);
  }
}

export function assertValidCheckpointId(checkpointId: string): void {
  if (!checkpointId || !VALID_REPLAY_ID_PATTERN.test(checkpointId)) {
    logger.error(`[replay.paths] Invalid checkpoint ID: ${String(checkpointId)}`);
    throw new SpacesError(`Invalid checkpoint ID: ${checkpointId}`, 'USER_ERROR', 1);
  }
}

export function getReplayRootDir(): string {
  return getConfiguredReplayRootDir();
}

export function ensureReplayRootDir(): string {
  const dir = getReplayRootDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getReplayDir(replayId: string): string {
  assertValidReplayId(replayId);
  return join(getReplayRootDir(), replayId);
}

export function ensureReplayDir(replayId: string): string {
  ensureReplayRootDir();
  const dir = getReplayDir(replayId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getReplayManifestPath(replayId: string): string {
  return join(getReplayDir(replayId), 'manifest.json');
}

export function getReplayEventsPath(replayId: string): string {
  return join(getReplayDir(replayId), 'events.ndjson');
}

export function getReplayCheckpointsDir(replayId: string): string {
  return join(getReplayDir(replayId), 'checkpoints');
}

export function ensureReplayCheckpointsDir(replayId: string): string {
  const dir = getReplayCheckpointsDir(replayId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getReplayCheckpointMetaPath(replayId: string, checkpointId: string): string {
  assertValidCheckpointId(checkpointId);
  return join(getReplayCheckpointsDir(replayId), `${checkpointId}.json`);
}

export function getReplayCheckpointAnsiPath(replayId: string, checkpointId: string): string {
  assertValidCheckpointId(checkpointId);
  return join(getReplayCheckpointsDir(replayId), `${checkpointId}.ansi`);
}
