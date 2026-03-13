import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendReplayEvent,
  initializeReplay,
  listReplayCheckpoints,
  listReplayInfos,
  reconcileRunningReplaysAsCrashed,
  readReplayCheckpoint,
  readReplayEvents,
  readReplayManifest,
  updateReplayManifest,
  writeReplayCheckpoint,
} from './store.js';
import type { ReplayCheckpoint, ReplayEvent, ReplayManifest } from './types.js';

describe('replay store', () => {
  let replayRoot: string;
  const originalReplayDir = process.env.TMUX_LITE_REPLAY_DIR;

  beforeEach(() => {
    replayRoot = mkdtempSync(join(tmpdir(), 'gitspace-replay-store-'));
    process.env.TMUX_LITE_REPLAY_DIR = replayRoot;
  });

  afterEach(() => {
    rmSync(replayRoot, { recursive: true, force: true });
    if (originalReplayDir === undefined) {
      delete process.env.TMUX_LITE_REPLAY_DIR;
    } else {
      process.env.TMUX_LITE_REPLAY_DIR = originalReplayDir;
    }
  });

  function makeManifest(overrides: Partial<ReplayManifest> = {}): ReplayManifest {
    return {
      version: 1,
      replayId: 'replay_1',
      sessionId: 'session_1',
      sessionName: 'project:workspace:1',
      cwd: '/tmp/project/workspace',
      workspaceId: 'project:workspace',
      projectName: 'project',
      workspaceName: 'workspace',
      startedAt: 1000,
      status: 'running',
      initialTerminal: {
        cols: 120,
        rows: 40,
        termType: 'xterm-256color',
      },
      metadata: {},
      stats: {
        lastSeq: 0,
        eventCount: 0,
        checkpointCount: 0,
        durationMs: 0,
      },
      ...overrides,
    };
  }

  function makeEvent(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
    return {
      v: 1,
      seq: 1,
      t: 50,
      type: 'output',
      encoding: 'base64',
      data: Buffer.from('hello').toString('base64'),
      ...overrides,
    } as ReplayEvent;
  }

  function makeCheckpoint(overrides: Partial<ReplayCheckpoint> = {}): ReplayCheckpoint {
    return {
      version: 1,
      checkpointId: 'checkpoint_0001',
      seq: 12,
      t: 500,
      terminal: {
        cols: 120,
        rows: 40,
      },
      metadata: {
        processTitle: 'npm test',
      },
      serializer: {
        kind: 'xterm-serialize',
        scrollbackLines: 1000,
      },
      ansiPath: 'checkpoints/checkpoint_0001.ansi',
      ...overrides,
    };
  }

  it('initializes and reads a replay manifest', () => {
    const manifest = makeManifest();
    initializeReplay(manifest);

    const stored = readReplayManifest(manifest.replayId);
    expect(stored).toEqual(manifest);
  });

  it('appends and reads replay events', () => {
    const manifest = makeManifest();
    initializeReplay(manifest);

    appendReplayEvent(manifest.replayId, makeEvent({ seq: 1, t: 10 }));
    appendReplayEvent(manifest.replayId, makeEvent({ seq: 2, t: 25, data: Buffer.from('world').toString('base64') }));

    const events = readReplayEvents(manifest.replayId);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it('writes and reads checkpoints', () => {
    const manifest = makeManifest();
    initializeReplay(manifest);

    const checkpoint = makeCheckpoint();
    writeReplayCheckpoint(manifest.replayId, checkpoint, '\u001bc\u001b[2J\u001b[Hhello');

    const stored = readReplayCheckpoint(manifest.replayId, checkpoint.checkpointId);
    expect(stored).not.toBeNull();
    expect(stored?.checkpoint).toEqual(checkpoint);
    expect(stored?.ansi).toContain('hello');
    expect(listReplayCheckpoints(manifest.replayId)).toEqual([checkpoint]);
  });

  it('updates manifest data and lists replay infos with filters', () => {
    initializeReplay(
      makeManifest({
        replayId: 'replay_a',
        sessionId: 'session_a',
        startedAt: 1000,
        status: 'closed',
        stats: {
          lastSeq: 20,
          eventCount: 20,
          checkpointCount: 2,
          durationMs: 1200,
        },
      })
    );
    initializeReplay(
      makeManifest({
        replayId: 'replay_b',
        sessionId: 'session_b',
        workspaceId: 'project:other',
        workspaceName: 'other',
        startedAt: 2000,
        status: 'crashed',
      })
    );

    const updated = updateReplayManifest('replay_b', (manifest) => ({
      ...manifest,
      metadata: {
        ...manifest.metadata,
        processTitle: 'bun test',
      },
      stats: {
        ...manifest.stats,
        durationMs: 900,
      },
    }));

    expect(updated.metadata.processTitle).toBe('bun test');

    const allInfos = listReplayInfos();
    expect(allInfos).toHaveLength(2);
    expect(allInfos[0].replayId).toBe('replay_b');
    expect(allInfos[1].replayId).toBe('replay_a');

    const filtered = listReplayInfos({ workspaceId: 'project:workspace', status: ['closed'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].replayId).toBe('replay_a');
  });

  it('reconciles running replays as crashed', () => {
    initializeReplay(makeManifest({ replayId: 'running_replay', startedAt: 1000 }));
    initializeReplay(makeManifest({ replayId: 'closed_replay', status: 'closed', endedAt: 1500 }));

    const reconciled = reconcileRunningReplaysAsCrashed(5000);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].replayId).toBe('running_replay');

    const running = readReplayManifest('running_replay');
    const closed = readReplayManifest('closed_replay');
    expect(running?.status).toBe('crashed');
    expect(running?.endedAt).toBe(5000);
    expect(running?.stats.durationMs).toBe(4000);
    expect(closed?.status).toBe('closed');
  });
});
