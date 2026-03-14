import { Terminal as XTerminal } from '@xterm/headless';
import { listReplayCheckpoints, readReplayCheckpoint, readReplayEvents, readReplayManifest } from './store.js';
import { SpacesError } from '../../../types/errors.js';
import { logger } from '../../../utils/logger.js';

function getDefaultTargetTime(
  manifest: { status: string; stats: { durationMs: number } },
  checkpoints: Array<{ t: number }>,
  events: Array<{ t: number }>
): number {
  if (manifest.status !== 'running') {
    return manifest.stats.durationMs;
  }

  const latestEventTime = events.length > 0 ? events[events.length - 1]?.t ?? 0 : 0;
  const latestCheckpointTime = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1]?.t ?? 0 : 0;
  return Math.max(manifest.stats.durationMs, latestEventTime, latestCheckpointTime);
}

export interface ReconstructedTerminalState {
  replayId: string;
  sessionId: string;
  workspaceId?: string;
  timeMs: number;
  seq: number;
  cols: number;
  rows: number;
  title?: string;
  processTitle?: string;
  exitCode?: number;
  checkpointId?: string;
  xterm: XTerminal;
}

function writeToTerminal(xterm: XTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    xterm.write(data, () => resolve());
  });
}

export async function reconstructReplayAt(
  replayId: string,
  atMs?: number
): Promise<ReconstructedTerminalState> {
  const manifest = readReplayManifest(replayId);
  if (!manifest) {
    logger.error(`[replay.reconstruct] Replay manifest not found: ${replayId}`);
    throw new SpacesError(`Replay manifest not found: ${replayId}`, 'USER_ERROR', 1);
  }

  const checkpoints = listReplayCheckpoints(replayId);
  const events = readReplayEvents(replayId);
  const latestAvailableTime = getDefaultTargetTime(manifest, checkpoints, events);
  const targetTime = Math.max(0, atMs === undefined ? latestAvailableTime : Math.min(atMs, latestAvailableTime));
  const checkpoint = [...checkpoints]
    .reverse()
    .find((entry) => entry.t <= targetTime);
  const checkpointRecord = checkpoint
    ? readReplayCheckpoint(replayId, checkpoint.checkpointId)
    : null;

  const xterm = new XTerminal({
    cols: checkpointRecord?.checkpoint.terminal.cols ?? manifest.initialTerminal.cols,
    rows: checkpointRecord?.checkpoint.terminal.rows ?? manifest.initialTerminal.rows,
    scrollback: 10_000,
    allowProposedApi: true,
  });

  if (checkpointRecord) {
    if (xterm.cols !== checkpointRecord.checkpoint.terminal.cols || xterm.rows !== checkpointRecord.checkpoint.terminal.rows) {
      xterm.resize(checkpointRecord.checkpoint.terminal.cols, checkpointRecord.checkpoint.terminal.rows);
    }
    await writeToTerminal(xterm, '\x1bc\x1b[2J\x1b[H');
    await writeToTerminal(xterm, checkpointRecord.ansi);
  }

  let seq = checkpointRecord?.checkpoint.seq ?? 0;
  let title = checkpointRecord?.checkpoint.metadata.title;
  let processTitle = checkpointRecord?.checkpoint.metadata.processTitle;
  let exitCode = checkpointRecord?.checkpoint.metadata.exitCode;

  for (const event of events) {
    if (event.seq <= seq) {
      continue;
    }
    if (event.t > targetTime) {
      break;
    }

    switch (event.type) {
      case 'output':
        await writeToTerminal(xterm, Buffer.from(event.data, 'base64'));
        break;
      case 'input':
      case 'marker':
        break;
      case 'resize':
        xterm.resize(event.cols, event.rows);
        break;
      case 'title':
        title = event.title;
        break;
      case 'process-title':
        processTitle = event.processTitle;
        break;
      case 'exit':
        exitCode = event.code;
        break;
    }

    seq = event.seq;
  }

  if (targetTime >= manifest.stats.durationMs) {
    title ??= manifest.metadata.title;
    processTitle ??= manifest.metadata.processTitle;
    exitCode ??= manifest.metadata.exitCode;
  }

  return {
    replayId,
    sessionId: manifest.sessionId,
    workspaceId: manifest.workspaceId,
    timeMs: targetTime,
    seq,
    cols: xterm.cols,
    rows: xterm.rows,
    title,
    processTitle,
    exitCode,
    checkpointId: checkpointRecord?.checkpoint.checkpointId,
    xterm,
  };
}
