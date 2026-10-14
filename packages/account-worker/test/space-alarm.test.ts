import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('drops a due wake that no handler takes instead of re-arming it in the past forever', async () => {
  const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:alarm-stale`);
  // A directory wake with nothing pending in the outbox: its handler neither clears nor moves it.
  await runInDurableObject(space, async (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_alarms(owner TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)');
    state.storage.sql.exec("INSERT INTO runtime_alarms(owner,timestamp) VALUES('directory',?)", Date.now() - 1_000);
    // Armed in the future so the test, not the scheduler, runs it.
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(space)).toBe(true);
  await runInDurableObject(space, async (_instance, state) => {
    expect(state.storage.sql.exec('SELECT owner FROM runtime_alarms').toArray()).toEqual([]);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
