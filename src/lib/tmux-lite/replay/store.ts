import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  assertValidCheckpointId,
  assertValidReplayId,
  ensureReplayCheckpointsDir,
  ensureReplayDir,
  ensureReplayRootDir,
  getReplayCheckpointAnsiPath,
  getReplayCheckpointMetaPath,
  getReplayDir,
  getReplayEventsPath,
  getReplayManifestPath,
  getReplayRootDir,
} from './paths.js';
import type {
  ReplayCheckpoint,
  ReplayEvent,
  ReplayInfo,
  ReplayManifest,
  ReplayStatus,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTextFile(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function parseManifest(value: unknown): ReplayManifest | null {
  if (!isRecord(value)) {
    return null;
  }

  const {
    version,
    replayId,
    sessionId,
    sessionName,
    cwd,
    workspaceId,
    projectName,
    workspaceName,
    startedAt,
    endedAt,
    status,
    initialTerminal,
    metadata,
    retention,
    stats,
  } = value;

  if (version !== 1) {
    return null;
  }
  if (typeof replayId !== 'string' || typeof sessionId !== 'string' || typeof sessionName !== 'string') {
    return null;
  }
  if (typeof cwd !== 'string' || typeof startedAt !== 'number') {
    return null;
  }
  if (endedAt !== undefined && typeof endedAt !== 'number') {
    return null;
  }
  if (status !== 'running' && status !== 'closed' && status !== 'crashed') {
    return null;
  }
  if (!isRecord(initialTerminal) || typeof initialTerminal.cols !== 'number' || typeof initialTerminal.rows !== 'number') {
    return null;
  }
  if (!isRecord(metadata)) {
    return null;
  }
  if (
    !isRecord(stats) ||
    typeof stats.lastSeq !== 'number' ||
    typeof stats.eventCount !== 'number' ||
    typeof stats.checkpointCount !== 'number' ||
    typeof stats.durationMs !== 'number'
  ) {
    return null;
  }

  return {
    version: 1,
    replayId,
    sessionId,
    sessionName,
    cwd,
    workspaceId: typeof workspaceId === 'string' ? workspaceId : undefined,
    projectName: typeof projectName === 'string' ? projectName : undefined,
    workspaceName: typeof workspaceName === 'string' ? workspaceName : undefined,
    startedAt,
    endedAt,
    status,
    initialTerminal: {
      cols: initialTerminal.cols,
      rows: initialTerminal.rows,
      termType: typeof initialTerminal.termType === 'string' ? initialTerminal.termType : undefined,
    },
    metadata: {
      title: typeof metadata.title === 'string' ? metadata.title : undefined,
      processTitle: typeof metadata.processTitle === 'string' ? metadata.processTitle : undefined,
      exitCode: typeof metadata.exitCode === 'number' ? metadata.exitCode : undefined,
    },
    retention: isRecord(retention) && typeof retention.expiresAt === 'number'
      ? { expiresAt: retention.expiresAt }
      : undefined,
    stats: {
      lastSeq: stats.lastSeq,
      eventCount: stats.eventCount,
      checkpointCount: stats.checkpointCount,
      durationMs: stats.durationMs,
    },
  };
}

function parseEvent(value: unknown): ReplayEvent | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.seq !== 'number' || typeof value.t !== 'number') {
    return null;
  }

  switch (value.type) {
    case 'output':
      if (value.encoding !== 'base64' || typeof value.data !== 'string') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'output',
        encoding: 'base64',
        data: value.data,
      };
    case 'input':
      if (value.encoding !== 'base64' || typeof value.data !== 'string') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'input',
        encoding: 'base64',
        data: value.data,
      };
    case 'resize':
      if (typeof value.cols !== 'number' || typeof value.rows !== 'number') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'resize',
        cols: value.cols,
        rows: value.rows,
      };
    case 'marker':
      if (value.label !== undefined && typeof value.label !== 'string') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'marker',
        label: value.label,
      };
    case 'title':
      if (typeof value.title !== 'string') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'title',
        title: value.title,
      };
    case 'process-title':
      if (typeof value.processTitle !== 'string') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'process-title',
        processTitle: value.processTitle,
      };
    case 'exit':
      if (typeof value.code !== 'number') {
        return null;
      }
      return {
        v: 1,
        seq: value.seq,
        t: value.t,
        type: 'exit',
        code: value.code,
      };
    default:
      return null;
  }
}

function parseCheckpoint(value: unknown): ReplayCheckpoint | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.version !== 1 ||
    typeof value.checkpointId !== 'string' ||
    typeof value.seq !== 'number' ||
    typeof value.t !== 'number' ||
    !isRecord(value.terminal) ||
    typeof value.terminal.cols !== 'number' ||
    typeof value.terminal.rows !== 'number' ||
    !isRecord(value.metadata) ||
    !isRecord(value.serializer) ||
    value.serializer.kind !== 'xterm-serialize' ||
    typeof value.serializer.scrollbackLines !== 'number' ||
    typeof value.ansiPath !== 'string'
  ) {
    return null;
  }

  return {
    version: 1,
    checkpointId: value.checkpointId,
    seq: value.seq,
    t: value.t,
    terminal: {
      cols: value.terminal.cols,
      rows: value.terminal.rows,
    },
    metadata: {
      title: typeof value.metadata.title === 'string' ? value.metadata.title : undefined,
      processTitle: typeof value.metadata.processTitle === 'string' ? value.metadata.processTitle : undefined,
      exitCode: typeof value.metadata.exitCode === 'number' ? value.metadata.exitCode : undefined,
    },
    serializer: {
      kind: 'xterm-serialize',
      scrollbackLines: value.serializer.scrollbackLines,
    },
    ansiPath: value.ansiPath,
  };
}

function toReplayInfo(manifest: ReplayManifest): ReplayInfo {
  return {
    replayId: manifest.replayId,
    sessionId: manifest.sessionId,
    sessionName: manifest.sessionName,
    cwd: manifest.cwd,
    workspaceId: manifest.workspaceId,
    projectName: manifest.projectName,
    workspaceName: manifest.workspaceName,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    status: manifest.status,
    durationMs: manifest.stats.durationMs,
    eventCount: manifest.stats.eventCount,
    checkpointCount: manifest.stats.checkpointCount,
    lastSeq: manifest.stats.lastSeq,
    title: manifest.metadata.title,
    processTitle: manifest.metadata.processTitle,
    exitCode: manifest.metadata.exitCode,
  };
}

export interface ReplayListFilter {
  workspaceId?: string;
  sessionId?: string;
  status?: ReplayStatus[];
}

export interface ReplayCheckpointRecord {
  checkpoint: ReplayCheckpoint;
  ansi: string;
}

export interface ReplayReconciliationResult {
  replayId: string;
  previousDurationMs: number;
  endedAt: number;
}

export function initializeReplay(manifest: ReplayManifest): void {
  assertValidReplayId(manifest.replayId);
  ensureReplayDir(manifest.replayId);
  ensureReplayCheckpointsDir(manifest.replayId);
  writeReplayManifest(manifest);
  const eventsPath = getReplayEventsPath(manifest.replayId);
  if (!existsSync(eventsPath)) {
    writeFileSync(eventsPath, '', 'utf-8');
  }
}

export function writeReplayManifest(manifest: ReplayManifest): void {
  assertValidReplayId(manifest.replayId);
  ensureReplayDir(manifest.replayId);
  writeJsonFile(getReplayManifestPath(manifest.replayId), manifest);
}

export function readReplayManifest(replayId: string): ReplayManifest | null {
  assertValidReplayId(replayId);
  const raw = readTextFile(getReplayManifestPath(replayId));
  if (!raw) {
    return null;
  }

  try {
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function updateReplayManifest(
  replayId: string,
  updater: (manifest: ReplayManifest) => ReplayManifest
): ReplayManifest {
  const manifest = readReplayManifest(replayId);
  if (!manifest) {
    throw new Error(`Replay manifest not found: ${replayId}`);
  }
  const next = updater(manifest);
  writeReplayManifest(next);
  return next;
}

export function appendReplayEvent(replayId: string, event: ReplayEvent): void {
  assertValidReplayId(replayId);
  ensureReplayDir(replayId);
  appendFileSync(getReplayEventsPath(replayId), `${JSON.stringify(event)}\n`, 'utf-8');
}

export function readReplayEvents(replayId: string): ReplayEvent[] {
  assertValidReplayId(replayId);
  const raw = readTextFile(getReplayEventsPath(replayId));
  if (!raw) {
    return [];
  }

  const events: ReplayEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = parseEvent(JSON.parse(line));
      if (parsed) {
        events.push(parsed);
      }
    } catch {
      // Skip malformed event lines.
    }
  }
  return events;
}

export function writeReplayCheckpoint(replayId: string, checkpoint: ReplayCheckpoint, ansi: string): void {
  assertValidReplayId(replayId);
  assertValidCheckpointId(checkpoint.checkpointId);
  ensureReplayCheckpointsDir(replayId);
  writeFileSync(getReplayCheckpointAnsiPath(replayId, checkpoint.checkpointId), ansi, 'utf-8');
  writeJsonFile(getReplayCheckpointMetaPath(replayId, checkpoint.checkpointId), checkpoint);
}

export function readReplayCheckpoint(replayId: string, checkpointId: string): ReplayCheckpointRecord | null {
  assertValidReplayId(replayId);
  assertValidCheckpointId(checkpointId);
  const metaRaw = readTextFile(getReplayCheckpointMetaPath(replayId, checkpointId));
  const ansi = readTextFile(getReplayCheckpointAnsiPath(replayId, checkpointId));
  if (!metaRaw || ansi === null) {
    return null;
  }

  try {
    const checkpoint = parseCheckpoint(JSON.parse(metaRaw));
    if (!checkpoint) {
      return null;
    }
    return { checkpoint, ansi };
  } catch {
    return null;
  }
}

export function listReplayCheckpoints(replayId: string): ReplayCheckpoint[] {
  assertValidReplayId(replayId);
  const dir = join(getReplayDir(replayId), 'checkpoints');
  if (!existsSync(dir)) {
    return [];
  }

  const checkpoints: ReplayCheckpoint[] = [];
  const entries = readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  for (const entry of entries) {
    const raw = readTextFile(join(dir, entry));
    if (!raw) {
      continue;
    }
    try {
      const parsed = parseCheckpoint(JSON.parse(raw));
      if (parsed) {
        checkpoints.push(parsed);
      }
    } catch {
      // Skip malformed checkpoints.
    }
  }

  checkpoints.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return checkpoints;
}

export function listReplayInfos(filter: ReplayListFilter = {}): ReplayInfo[] {
  const root = getReplayRootDir();
  if (!existsSync(root)) {
    return [];
  }

  const statuses = filter.status ? new Set(filter.status) : null;
  const infos: ReplayInfo[] = [];
  for (const entry of readdirSync(root)) {
    let manifest: ReplayManifest | null;
    try {
      manifest = readReplayManifest(entry);
    } catch {
      continue;
    }
    if (!manifest) {
      continue;
    }
    if (filter.workspaceId && manifest.workspaceId !== filter.workspaceId) {
      continue;
    }
    if (filter.sessionId && manifest.sessionId !== filter.sessionId) {
      continue;
    }
    if (statuses && !statuses.has(manifest.status)) {
      continue;
    }
    infos.push(toReplayInfo(manifest));
  }

  infos.sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      return b.startedAt - a.startedAt;
    }
    return a.replayId.localeCompare(b.replayId);
  });
  return infos;
}

export function ensureReplayStorage(): string {
  const root = ensureReplayRootDir();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

export function reconcileRunningReplaysAsCrashed(endedAt = Date.now()): ReplayReconciliationResult[] {
  const runningReplays = listReplayInfos({ status: ['running'] });
  const results: ReplayReconciliationResult[] = [];

  for (const replay of runningReplays) {
    const manifest = readReplayManifest(replay.replayId);
    if (!manifest || manifest.status !== 'running') {
      continue;
    }

    const durationMs = Math.max(manifest.stats.durationMs, endedAt - manifest.startedAt);
    writeReplayManifest({
      ...manifest,
      endedAt,
      status: 'crashed',
      stats: {
        ...manifest.stats,
        durationMs,
      },
    });

    results.push({
      replayId: replay.replayId,
      previousDurationMs: manifest.stats.durationMs,
      endedAt,
    });
  }

  return results;
}
