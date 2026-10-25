import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { SpaceAuthorityDO } from '../src/space-authority.js';

it('an alarm drive with nothing due leaves no alarm: a wake of an earlier release, and an LFS wake with no placement', async () => {
  const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:alarm-idle`);
  await runInDurableObject(space, async (_instance, state) => {
    // A lease wake an earlier release armed (it has no handler now), and an LFS wake for a space with no placement.
    state.storage.sql.exec("INSERT INTO runtime_alarms(owner,timestamp) VALUES('leases',?),('lfs',?)", Date.now() + 60_000, Date.now() - 1_000);
    // Armed in the future so the test, not the scheduler, runs it.
    await state.storage.setAlarm(Date.now() + 60_000);
    // The instance a deploy starts, driving the alarm.
    await new SpaceAuthorityDO(state, env).alarm();
    expect(state.storage.sql.exec('SELECT owner FROM runtime_alarms').toArray()).toEqual([]);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
