import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
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

/** The platform's storage route, as its watchdog calls it. */
function platformStorage(body: object, token = env.PLATFORM_TOKEN): Promise<Response> {
  return SELF.fetch('https://tenant.test/__platform/storage', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
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

test('the platform quarantines and resumes an object by id: the quarantine outlasts a healthy report, and a resume resolves it and silences its alerts', async () => {
  const stub = env.PROJECT_AUTOMATIONS.getByName(crypto.randomUUID());
  const id = stub.id.toString();
  const incidents = async () => (await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).filter(item => item.objectId === id);

  expect((await platformStorage({ action: 'status', objectId: id }, 'wrong')).status).toBe(401);
  expect((await platformStorage({ action: 'quarantine', objectId: id, reason: 'wrote 6,000,000 rows in an hour', className: 'ProjectAutomationsDO' })).status).toBe(200);
  expect(await stub.storageBreakerStatus()).toMatchObject({ quarantined: true, reason: 'wrote 6,000,000 rows in an hour' });
  expect(await incidents()).toEqual([expect.objectContaining({ kind: 'quarantine', resolvedAt: null })]);
  // An alert never hides a quarantine, and the watchdog finding the object under its thresholds does not resolve it.
  await platformStorage({ action: 'alert', objectId: id, reason: 'wrote 1,200,000 rows in an hour', className: 'ProjectAutomationsDO' });
  expect((await platformStorage({ action: 'healthy', objectId: id })).status).toBe(204);
  expect(await incidents()).toEqual([expect.objectContaining({ kind: 'quarantine', resolvedAt: null })]);

  const resumed = await platformStorage({ action: 'resume', objectId: id });
  expect(await resumed.json()).toMatchObject({ quarantined: false });
  expect(await incidents()).toEqual([expect.objectContaining({ kind: 'quarantine', resolvedAt: expect.any(String) })]);
  // The hour that tripped the watchdog still counts after the resume; its alerts stay silent.
  await platformStorage({ action: 'alert', objectId: id, reason: 'wrote 6,000,000 rows in the last hour', className: 'ProjectAutomationsDO' });
  expect(await incidents()).toEqual([expect.objectContaining({ kind: 'quarantine', resolvedAt: expect.any(String) })]);
  expect((await platformStorage({ action: 'status', objectId: 'f'.repeat(64) })).status).toBe(404);
});

test('an alert resolves when the watchdog finds the object healthy, and stays listed as resolved for seven days', async () => {
  const id = env.USER_SETTINGS.getByName(crypto.randomUUID()).id.toString();
  const incidents = async () => (await env.ACCOUNT_STATE.getByName('account').listStorageIncidents()).filter(item => item.objectId === id);
  const alert = (reason: string) => platformStorage({ action: 'alert', objectId: id, reason, className: 'UserSettingsDO' });

  await alert('was awake 22.9 of the last 24 hours');
  expect(await incidents()).toEqual([expect.objectContaining({ kind: 'alert', reason: 'was awake 22.9 of the last 24 hours', resolvedAt: null })]);
  expect((await platformStorage({ action: 'healthy', objectId: id })).status).toBe(204);
  const [resolved] = await incidents();
  expect(resolved).toMatchObject({ kind: 'alert', reason: 'was awake 22.9 of the last 24 hours', resolvedAt: expect.any(String) });

  // The problem returns: a new alert opens, and the resolved one stays as history.
  await alert('ran 3,500 alarms in the last hour');
  expect(await incidents()).toEqual([
    expect.objectContaining({ reason: 'was awake 22.9 of the last 24 hours', resolvedAt: resolved?.resolvedAt }),
    expect.objectContaining({ reason: 'ran 3,500 alarms in the last hour', resolvedAt: null }),
  ]);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.parse(resolved?.resolvedAt ?? '') + 7 * 24 * 60 * 60_000 + 1);
    expect(await incidents()).toEqual([expect.objectContaining({ reason: 'ran 3,500 alarms in the last hour', resolvedAt: null })]);
  } finally { vi.useRealTimers(); }
});

test('a resume sets again the alarm the quarantine cancelled', async () => {
  let stub = env.USER_SETTINGS.getByName(crypto.randomUUID());
  const due = Date.now() + 60 * 60_000;
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.setAlarm(due);
    state.storage.sql.exec('CREATE TABLE runaway(i INTEGER)');
    state.storage.sql.exec(RUNAWAY);
  });
  stub = await restart(stub);
  await runInDurableObject(stub, async (instance, state) => {
    expect(instance.storageBreakerStatus().quarantined).toBe(true);
    instance.resumeStorage();
    await expect.poll(() => state.storage.getAlarm()).toBe(due);
  });
});

test('an object that never trips stores nothing for the breaker', async () => {
  const stub = env.USER_SETTINGS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE ordinary(i INTEGER)');
    state.storage.sql.exec('INSERT INTO ordinary VALUES (1)');
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE '\\_storage%' ESCAPE '\\'").toArray()).toEqual([]);
  });
});

test('incidents recorded before resolution existed stay listed as active', async () => {
  const account = env.ACCOUNT_STATE.getByName('account');
  const id = env.USER_SETTINGS.getByName(crypto.randomUUID()).id.toString();
  // A record as stored before incidents had `resolvedAt`.
  await runInDurableObject(account, async (_instance, state) => {
    const stored = await state.storage.get('storage-incidents');
    await state.storage.put('storage-incidents', [...(Array.isArray(stored) ? stored : []), { objectId: id, className: 'SpaceAuthorityDO', name: null, kind: 'alert', reason: 'was awake 21.3 of the last 24 hours', at: '2026-10-24T22:20:29.000Z' }]);
  });
  expect((await account.listStorageIncidents()).filter(item => item.objectId === id)).toEqual([expect.objectContaining({ kind: 'alert', reason: 'was awake 21.3 of the last 24 hours', resolvedAt: null })]);
});
