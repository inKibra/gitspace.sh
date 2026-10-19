import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { STORAGE_BREAKER_ROWS } from '@gitspace/protocol/storage-breaker';
import type { UserSettingsDO } from '../src/user-settings.js';

// One statement writes one row more than the budget allows.
const RUNAWAY = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= ${STORAGE_BREAKER_ROWS}) INSERT INTO runaway SELECT i FROM n`;

async function rejection(work: () => unknown): Promise<string> {
  try { await work(); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  return 'resolved';
}

/** Restarts the object; the stub returned constructs it again from stored state. */
async function restart(stub: DurableObjectStub<UserSettingsDO>): Promise<DurableObjectStub<UserSettingsDO>> {
  await rejection(() => runInDurableObject(stub, (_instance, state) => { state.abort('restart'); }));
  return env.USER_SETTINGS.get(stub.id);
}

test('an object that writes past its budget refuses all storage, stays quarantined across restarts, and tells the account', async () => {
  let stub = env.USER_SETTINGS.getByName(crypto.randomUUID());
  const id = stub.id.toString();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE runaway(i INTEGER)');
    state.storage.sql.exec(RUNAWAY);
  });

  await runInDurableObject(stub, async (_instance, state) => {
    expect(await rejection(() => state.storage.sql.exec('SELECT 1').toArray())).toMatch(/quarantined/u);
    expect(await rejection(() => state.storage.get('key'))).toMatch(/quarantined/u);
    expect(await rejection(() => state.storage.put('key', 1))).toMatch(/quarantined/u);
    expect(await rejection(() => state.storage.transaction(async tx => { await tx.put('key', 1); }))).toMatch(/quarantined/u);
  });
  stub = await restart(stub);
  const held = await stub.storageBreakerStatus();
  expect(held).toMatchObject({ quarantined: true, reason: expect.stringMatching(/limit 2,000,000/u) });
  expect(await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).toContainEqual(expect.objectContaining({ objectId: id, className: 'UserSettingsDO', kind: 'quarantine' }));

  expect(await stub.resumeStorage()).toMatchObject({ quarantined: false, rowsWritten: 0 });
  stub = await restart(stub);
  expect(await stub.storageBreakerStatus()).toMatchObject({ quarantined: false, resumedAt: expect.any(String) });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM runaway').one().n).toBe(STORAGE_BREAKER_ROWS + 1);
    await state.storage.put('key', 1);
  });
});

test('a quarantine tripped inside a transaction outlives the transaction it aborts', async () => {
  const stub = env.USER_SETTINGS.getByName(crypto.randomUUID());
  const failure = await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE runaway(i INTEGER)');
    return rejection(() => state.storage.transactionSync(() => {
      state.storage.sql.exec(RUNAWAY);
      state.storage.sql.exec('INSERT INTO runaway VALUES (0)');
    }));
  });
  expect(failure).toMatch(/quarantined/u);
  expect(await (await restart(stub)).storageBreakerStatus()).toMatchObject({ quarantined: true });
});

test('the platform quarantines and resumes an object by id, and a resume silences its alerts', async () => {
  const stub = env.PROJECT_CRONS.getByName(crypto.randomUUID());
  const id = stub.id.toString();
  const control = (body: object, token = env.PLATFORM_TOKEN) => SELF.fetch('https://tenant.test/__platform/storage', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  expect((await control({ action: 'status', objectId: id }, 'wrong')).status).toBe(401);
  expect((await control({ action: 'quarantine', objectId: id, reason: 'wrote 6,000,000 rows in an hour', className: 'ProjectCronsDO' })).status).toBe(200);
  expect(await stub.storageBreakerStatus()).toMatchObject({ quarantined: true, reason: 'wrote 6,000,000 rows in an hour' });
  expect(await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).toContainEqual(expect.objectContaining({ objectId: id, kind: 'quarantine' }));
  // An alert never hides a quarantine.
  await control({ action: 'alert', objectId: id, reason: 'wrote 1,200,000 rows in an hour', className: 'ProjectCronsDO' });
  expect(await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).toContainEqual(expect.objectContaining({ objectId: id, kind: 'quarantine' }));

  const resumed = await control({ action: 'resume', objectId: id });
  expect(await resumed.json()).toMatchObject({ quarantined: false });
  expect(await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).not.toContainEqual(expect.objectContaining({ objectId: id }));
  // The hour that tripped the watchdog still counts after the resume; its alerts stay silent.
  await control({ action: 'alert', objectId: id, reason: 'wrote 6,000,000 rows in the last hour', className: 'ProjectCronsDO' });
  expect(await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).not.toContainEqual(expect.objectContaining({ objectId: id }));
  expect((await control({ action: 'status', objectId: 'f'.repeat(64) })).status).toBe(404);
});
