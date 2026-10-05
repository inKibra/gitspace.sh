import { afterEach, expect, it, mock, spyOn } from 'bun:test';
import { pollUntilReady } from '../scripts/poll-until-ready.js';

afterEach(() => mock.restore());

it('waits for readiness across a forward wall-clock jump', async () => {
  let monotonic = 0;
  let wall = 1_000;
  let connected = false;
  spyOn(Date, 'now').mockImplementation(() => wall);
  await pollUntilReady(async () => connected, {
    timeoutMs: 125,
    message: 'Relay did not connect',
    now: () => monotonic,
    pause: async milliseconds => {
      monotonic += milliseconds;
      wall += 3_600_000;
      connected = monotonic >= 100;
    },
  });
  expect(connected).toBe(true);
  expect(monotonic).toBe(100);
});

it('expires at the elapsed budget despite a backward wall-clock jump', async () => {
  let monotonic = 0;
  let wall = 1_000;
  spyOn(Date, 'now').mockImplementation(() => wall);
  await expect(pollUntilReady(async () => false, {
    timeoutMs: 125,
    message: 'Relay did not reconnect',
    now: () => monotonic,
    pause: async milliseconds => {
      monotonic += milliseconds;
      wall -= 3_600_000;
      if (monotonic > 250) throw new Error('Exceeded the original polling budget');
    },
  })).rejects.toThrow('Relay did not reconnect');
  expect(monotonic).toBe(125);
});

it('propagates a failed readiness probe without continuing to poll', async () => {
  const failure = new Error('Relay status unavailable');
  await expect(pollUntilReady(async () => { throw failure; }, {
    timeoutMs: 125,
    message: 'Relay did not connect',
    now: () => 0,
    pause: async () => { throw new Error('Failed probes must not keep polling'); },
  })).rejects.toBe(failure);
});
