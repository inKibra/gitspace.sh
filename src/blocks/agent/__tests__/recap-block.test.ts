/**
 * The recap block's contract.
 *
 * Pi's recap is a VIEW over a conversation, not part of it: produced by an
 * ephemeral turn, never written to the session, withdrawn as soon as the session
 * moves on. These pin the parts that make that true, because a persisted or
 * stale recap describes a state the reader has already left.
 */
import { describe, expect, it } from 'bun:test';
import { getBlockDefinition } from '../../index.js';
import { recapData } from '../../types/transcript.js';

describe('recap block', () => {
  it('is registered as a transcript block', () => {
    const def = getBlockDefinition('recap');
    expect(def).toBeTruthy();
    expect(def?.tier).toBe('transcript');
  });

  it('accepts the shape the server emits', () => {
    const parsed = recapData.safeParse({ text: 'Goal: ship the branch. Next: run the gate.' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a recap with no text — there is nothing to orient with', () => {
    expect(recapData.safeParse({}).success).toBe(false);
    expect(recapData.safeParse({ text: 42 }).success).toBe(false);
  });
});
