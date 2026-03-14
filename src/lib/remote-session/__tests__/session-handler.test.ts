import { describe, expect, it } from 'bun:test';
import { canAccessReplayForSession, filterReplaysForSessionAccess } from '../session-handler.js';

describe('remote replay session access', () => {
  it('allows full access to all replays', () => {
    const replays = [
      { replayId: 'r1', sessionId: 's1' },
      { replayId: 'r2', sessionId: 's2' },
    ];

    expect(filterReplaysForSessionAccess('full', undefined, replays)).toEqual(replays);
    expect(canAccessReplayForSession('full', undefined, { sessionId: 's1' })).toBe(true);
  });

  it('limits view access to the granted session only', () => {
    const replays = [
      { replayId: 'r1', sessionId: 's1' },
      { replayId: 'r2', sessionId: 's2' },
    ];

    expect(filterReplaysForSessionAccess('view', 's2', replays)).toEqual([{ replayId: 'r2', sessionId: 's2' }]);
    expect(canAccessReplayForSession('view', 's2', { sessionId: 's2' })).toBe(true);
    expect(canAccessReplayForSession('view', 's2', { sessionId: 's1' })).toBe(false);
  });

  it('denies replay access when no session grant is present', () => {
    const replays = [{ replayId: 'r1', sessionId: 's1' }];
    expect(filterReplaysForSessionAccess('view', undefined, replays)).toEqual([]);
    expect(canAccessReplayForSession('view', undefined, { sessionId: 's1' })).toBe(false);
    expect(canAccessReplayForSession(undefined, undefined, { sessionId: 's1' })).toBe(false);
  });
});
