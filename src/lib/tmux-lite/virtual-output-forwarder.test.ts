import { describe, expect, it } from 'bun:test';
import { forwardVirtualTerminalOutput, type VirtualOutputSessionState } from './virtual-output-forwarder.js';

describe('forwardVirtualTerminalOutput', () => {
  function makeSession(attaching = false): VirtualOutputSessionState {
    return { pendingWrites: 0, attaching, attachDirty: false };
  }

  it('forwards live output before xterm write callback settles', () => {
    const session = makeSession(false);
    const live: string[] = [];
    let callback: () => void = () => { throw new Error('xterm callback was not captured'); };

    forwardVirtualTerminalOutput(
      session,
      (_data, cb) => { callback = cb; },
      (data) => live.push(data),
      'tool output',
    );

    expect(live).toEqual(['tool output']);
    expect(session.pendingWrites).toBe(1);
    expect(session.attachDirty).toBe(false);

    callback();

    expect(session.pendingWrites).toBe(0);
    expect(session.attachDirty).toBe(false);
  });

  it('suppresses live output while attaching and marks the attach dirty after xterm settles', () => {
    const session = makeSession(true);
    const live: string[] = [];
    let callback: () => void = () => { throw new Error('xterm callback was not captured'); };

    forwardVirtualTerminalOutput(
      session,
      (_data, cb) => { callback = cb; },
      (data) => live.push(data),
      'snapshot-only output',
    );

    expect(live).toEqual([]);
    expect(session.pendingWrites).toBe(1);
    expect(session.attachDirty).toBe(false);

    callback();

    expect(session.pendingWrites).toBe(0);
    expect(session.attachDirty).toBe(true);
  });

  it('does not mark a later attach dirty for output already forwarded live', () => {
    const session = makeSession(false);
    let callback: () => void = () => { throw new Error('xterm callback was not captured'); };

    forwardVirtualTerminalOutput(
      session,
      (_data, cb) => { callback = cb; },
      () => {},
      'pre-attach output',
    );

    session.attaching = true;
    callback();

    expect(session.pendingWrites).toBe(0);
    expect(session.attachDirty).toBe(false);
  });
});
