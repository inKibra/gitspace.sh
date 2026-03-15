export const REPLAY_FORMAT_VERSION = 1 as const;

export type ReplayStatus = 'running' | 'closed' | 'crashed';

export interface ReplayRetentionPolicy {
  expiresAt?: number;
  dismissedAt?: number;
  dismissedBy?: string;
}

export interface ReplayManifestStats {
  lastSeq: number;
  eventCount: number;
  checkpointCount: number;
  durationMs: number;
}

export interface ReplayManifestMetadata {
  title?: string;
  processTitle?: string;
  exitCode?: number;
}

export interface ReplayManifest {
  version: typeof REPLAY_FORMAT_VERSION;
  replayId: string;
  sessionId: string;
  sessionName: string;
  cwd: string;
  workspaceId?: string;
  projectName?: string;
  workspaceName?: string;
  startedAt: number;
  endedAt?: number;
  status: ReplayStatus;
  initialTerminal: {
    cols: number;
    rows: number;
    termType?: string;
  };
  metadata: ReplayManifestMetadata;
  retention?: ReplayRetentionPolicy;
  stats: ReplayManifestStats;
}

interface ReplayEventBase {
  v: typeof REPLAY_FORMAT_VERSION;
  seq: number;
  t: number;
}

export interface ReplayOutputEvent extends ReplayEventBase {
  type: 'output';
  encoding: 'base64';
  data: string;
}

export interface ReplayInputEvent extends ReplayEventBase {
  type: 'input';
  encoding: 'base64';
  data: string;
}

export interface ReplayResizeEvent extends ReplayEventBase {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface ReplayMarkerEvent extends ReplayEventBase {
  type: 'marker';
  label?: string;
}

export interface ReplayTitleEvent extends ReplayEventBase {
  type: 'title';
  title: string;
}

export interface ReplayProcessTitleEvent extends ReplayEventBase {
  type: 'process-title';
  processTitle: string;
}

export interface ReplayExitEvent extends ReplayEventBase {
  type: 'exit';
  code: number;
}

export type ReplayEvent =
  | ReplayOutputEvent
  | ReplayInputEvent
  | ReplayResizeEvent
  | ReplayMarkerEvent
  | ReplayTitleEvent
  | ReplayProcessTitleEvent
  | ReplayExitEvent;

export interface ReplayCheckpoint {
  version: typeof REPLAY_FORMAT_VERSION;
  checkpointId: string;
  seq: number;
  t: number;
  terminal: {
    cols: number;
    rows: number;
  };
  metadata: ReplayManifestMetadata;
  serializer: {
    kind: 'xterm-serialize';
    scrollbackLines: number;
  };
  ansiPath: string;
}

export interface ReplayInfo {
  replayId: string;
  sessionId: string;
  sessionName: string;
  cwd: string;
  workspaceId?: string;
  projectName?: string;
  workspaceName?: string;
  startedAt: number;
  endedAt?: number;
  status: ReplayStatus;
  durationMs: number;
  eventCount: number;
  checkpointCount: number;
  lastSeq: number;
  title?: string;
  processTitle?: string;
  exitCode?: number;
  dismissedAt?: number;
  dismissedBy?: string;
  expiresAt?: number;
}

export interface ReplayStorageInfo {
  replayId: string;
  sessionName: string;
  status: ReplayStatus;
  durationMs: number;
  totalBytes: number;
  eventsBytes: number;
  checkpointsBytes: number;
  manifestBytes: number;
  dismissedAt?: number;
  expiresAt?: number;
}

export interface ReplayStorageSummary {
  totalBytes: number;
  replayCount: number;
  replays: ReplayStorageInfo[];
}

export interface ReplayFrameTarget {
  atMs?: number;
  atSeq?: number;
}

export interface ReplayTimelineStep {
  timeMs: number;
  seq: number;
}

export interface ReplayTimeline {
  replayId: string;
  durationMs: number;
  latestTimeMs: number;
  steps: ReplayTimelineStep[];
  checkpointSteps: ReplayTimelineStep[];
}

export interface ReplayFrameEvent {
  seq: number;
  t: number;
  type: 'output' | 'resize';
  data?: string;   // base64 for output
  cols?: number;
  rows?: number;
}

export interface ReplayFrameCheckpoint {
  checkpointId: string;
  seq: number;
  t: number;
  cols: number;
  rows: number;
  ansi: string;  // base64-encoded checkpoint ANSI (xterm serialization)
}

export interface ReplayFrame {
  replayId: string;
  checkpoint: ReplayFrameCheckpoint | null;
  events: ReplayFrameEvent[];
}

export interface TerminalSnapshot {
  version: typeof REPLAY_FORMAT_VERSION;
  replayId: string;
  sessionId: string;
  workspaceId?: string;
  source: 'live' | 'replay';
  timeMs: number;
  seq: number;
  terminal: {
    cols: number;
    rows: number;
    cursorX: number;
    cursorY: number;
    viewportY: number;
    baseY: number;
  };
  metadata: {
    title?: string;
    processTitle?: string;
    exitCode?: number;
    attached?: boolean;
    checkpointId?: string;
  };
  screen: {
    visible: string[];
    scrollbackTail: string[];
    currentLine?: string;
  };
}
