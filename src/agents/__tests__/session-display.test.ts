import { describe, expect, it } from 'bun:test';

import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../session-display.js';

describe('agent session display helpers', () => {
  it('hides sessions with parent IDs', () => {
    expect(
      shouldDisplayAgentSession({
        id: 'ses-1234',
        title: 'Nested helper',
        parentID: 'ses-parent',
      }),
    ).toBe(false);
  });

  it('hides sessions that look like subagent titles', () => {
    expect(
      shouldDisplayAgentSession({
        id: 'ses-1234',
        rawTitle: 'Planner (@build subagent)',
      }),
    ).toBe(false);
  });

  it('relabels opaque untitled session IDs', () => {
    expect(getAgentSessionDisplayTitle({ id: 'ses-3039abc', title: 'ses-3039abc' })).toBe(
      'Untitled agent session',
    );
  });

  it('preserves explicit human titles', () => {
    expect(getAgentSessionDisplayTitle({ id: 'ses-3039abc', title: 'Refactor Bot' })).toBe(
      'Refactor Bot',
    );
  });
});
