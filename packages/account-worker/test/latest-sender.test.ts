import { expect, it } from 'vitest';
import { createLatestSender } from '../src/latest-sender.js';

/** A sender whose deliveries fail while `failing` is set, and whose retries wait for the test to run them. */
function scene() {
  const state = { failing: true };
  const sent: string[] = [];
  const failures: unknown[] = [];
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  const sender = createLatestSender<string>(async value => {
    sent.push(value);
    if (state.failing) throw new Error('Subrequest depth limit exceeded.');
  }, error => { failures.push(error); }, (run, delayMs) => { timers.push({ run, delayMs }); });
  const next = () => {
    const timer = timers.at(-1);
    if (!timer) throw new Error('No retry waits');
    timer.run();
  };
  return { state, sent, failures, timers, sender, next };
}
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

it('sends a status that did not arrive again, the newest one, until it arrives', async () => {
  const s = scene();
  expect(s.sender.owed()).toBe(true);
  s.sender.send('failed');
  await settle();
  expect(s.timers.map(timer => timer.delayMs)).toEqual([2_000]);
  s.next();
  await settle();
  expect(s.timers.map(timer => timer.delayMs)).toEqual([2_000, 4_000]);
  // A newer status replaces the one waiting: the waiting retry sends nothing.
  s.state.failing = false;
  s.sender.send('idle');
  await settle();
  expect(s.sender.owed()).toBe(false);
  s.next();
  await settle();
  expect(s.sent).toEqual(['failed', 'failed', 'idle']);
  // Two failures in a row were reported once.
  expect(s.failures).toHaveLength(1);
});

it('stops retrying after five, but keeps the status owed so the next publication sends it', async () => {
  const s = scene();
  s.sender.send('failed');
  await settle();
  for (let retry = 0; retry < 5; retry++) { s.next(); await settle(); }
  expect(s.sent).toHaveLength(6);
  expect(s.timers.map(timer => timer.delayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  expect(s.sender.owed()).toBe(true);
  s.state.failing = false;
  s.sender.send('failed');
  await settle();
  expect(s.sender.owed()).toBe(false);
  expect(s.failures).toHaveLength(1);
});
