import { describe, expect, it } from 'vitest';
import { createRequestGate, type RequestGate, type RequestPermit } from './request-gate';

/** Runs every queued promise reaction: a grant the gate made is observed by then. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

/** Asks the gate for each name in order and records the order permits arrive. */
function waiters(gate: RequestGate, names: readonly string[], signals: Record<string, AbortSignal> = {}) {
  const granted: string[] = [];
  const permits = new Map<string, Promise<RequestPermit>>();
  for (const name of names) permits.set(name, gate.acquire(signals[name]).then(permit => { granted.push(name); return permit; }));
  return { granted, permits };
}

describe('request gate', () => {
  it('holds requests beyond its places and grants each freed place to the oldest waiter', async () => {
    const gate = createRequestGate();
    const first = await gate.acquire();
    const second = await gate.acquire();
    const queue = waiters(gate, ['c', 'd', 'e']);
    await drain();
    expect(queue.granted).toEqual([]);
    second.release();
    await drain();
    expect(queue.granted).toEqual(['c']);
    first.release();
    (await queue.permits.get('c')!).release();
    await drain();
    expect(queue.granted).toEqual(['c', 'd', 'e']);
  });

  it('frees a place once however often its permit is released', async () => {
    const gate = createRequestGate();
    const first = await gate.acquire();
    await gate.acquire();
    first.release();
    first.release();
    const queue = waiters(gate, ['c', 'd']);
    await drain();
    expect(queue.granted).toEqual(['c']);
  });

  it('rejects a waiting request whose signal aborts with its reason and gives the place to the next', async () => {
    const gate = createRequestGate();
    const first = await gate.acquire();
    await gate.acquire();
    const stop = new AbortController();
    const queue = waiters(gate, ['stopped', 'next'], { stopped: stop.signal });
    const reason = new Error('Conversation stopped');
    stop.abort(reason);
    await expect(queue.permits.get('stopped')).rejects.toBe(reason);
    await expect(gate.acquire(stop.signal)).rejects.toBe(reason);
    first.release();
    await drain();
    expect(queue.granted).toEqual(['next']);
  });
});
