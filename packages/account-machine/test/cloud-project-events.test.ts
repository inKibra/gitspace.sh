import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factEvents, GitSpaceDatabase } from '@gitspace/core';
import type { ProjectEvent } from '@gitspace/protocol';
import { asc } from 'drizzle-orm';
import { CloudProjectEventWriter, type ProjectEventAuthority } from '../src/cloud-project-events.js';

type EventInput = Parameters<ProjectEventAuthority['appendProjectEvent']>[0];
interface Delivery {
  input: EventInput;
  succeed: () => void;
  fail: (error: unknown) => void;
}

class DeferredAuthority implements ProjectEventAuthority {
  readonly calls: Delivery[] = [];
  readonly delivered: ProjectEvent[] = [];
  private readonly waiters = new Map<number, (call: Delivery) => void>();

  appendProjectEvent(input: EventInput): Promise<ProjectEvent> {
    const completion = Promise.withResolvers<ProjectEvent>();
    const call: Delivery = {
      input,
      succeed: () => {
        const event = { ...input, offset: this.delivered.length + 1, createdAt: new Date().toISOString() };
        this.delivered.push(event);
        completion.resolve(event);
      },
      fail: completion.reject,
    };
    const index = this.calls.push(call) - 1;
    this.waiters.get(index)?.(call);
    this.waiters.delete(index);
    return completion.promise;
  }

  call(index: number): Promise<Delivery> {
    const existing = this.calls[index];
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<Delivery>();
    this.waiters.set(index, resolve);
    return promise;
  }
}

let now = 0;
let nextTimer = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
let root: string;
let database: GitSpaceDatabase;

beforeEach(() => {
  now = 0;
  nextTimer = 0;
  timers.clear();
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, callback });
    return id;
  }) as typeof setTimeout);
  spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout);
  root = mkdtempSync(join(tmpdir(), 'gitspace-cloud-events-'));
  database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  expect(database.createProject({ id: 'project-a', name: 'Project', repositoryPath: root }).status).toBe('ok');
});

afterEach(() => {
  mock.restore();
  timers.clear();
  database.close();
  rmSync(root, { recursive: true, force: true });
});

function advance(ms: number): void {
  const until = now + ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].callback();
  }
  now = until;
}

function append(writer: CloudProjectEventWriter, revision: number, projectId = 'project-a'): void {
  writer.append({
    projectId, scope: 'session', entity: 'message', entityId: 'session-a',
    revision, operation: 'append', payload: { text: `Message ${revision}` },
  });
}

describe('CloudProjectEventWriter', () => {
  it('flushes a healthy project while another project retains failed facts and backoff', async () => {
    expect(database.createProject({ id: 'project-b', name: 'Healthy', repositoryPath: root }).status).toBe('ok');
    const authority = new DeferredAuthority();
    const writer = new CloudProjectEventWriter(authority, database, () => {});
    append(writer, 1);
    const failed = await authority.call(0);
    const overload = new Error('Project A overloaded');
    const ownFlush = writer.flush('project-a').catch((error: unknown) => error);
    failed.fail(overload);
    expect(await ownFlush).toBe(overload);

    append(writer, 2);
    append(writer, 1, 'project-b');
    const healthy = await authority.call(1);
    expect(healthy.input.projectId).toBe('project-b');
    const healthyFlush = writer.flush('project-b');
    healthy.succeed();
    await healthyFlush;
    await expect(writer.flush('project-a')).rejects.toBe(overload);
    await expect(writer.flush()).rejects.toBe(overload);
    expect(authority.calls.map((call) => call.input.projectId)).toEqual(['project-a', 'project-b']);
    expect(database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all().map((event) => event.cloudSynced)).toEqual([false, false, true]);

    advance(1000);
    const retry = await authority.call(2);
    expect(retry.input.eventId).toBe(failed.input.eventId);
    retry.succeed();
    const next = await authority.call(3);
    expect(next.input.revision).toBe(2);
    next.succeed();
    await writer.flush();
    expect(database.orm.select().from(factEvents).all().every((event) => event.cloudSynced)).toBe(true);
  });

  it('flushes a project independently of three hung projects without duplicating delivery', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudProjectEventWriter(authority, database, () => {});
    const projects = ['project-a', 'project-b', 'project-c', 'project-d'];
    for (const projectId of projects) {
      if (projectId !== 'project-a') {
        expect(database.createProject({ id: projectId, name: projectId, repositoryPath: root }).status).toBe('ok');
      }
      append(writer, 1, projectId);
    }
    await authority.call(3);
    expect(authority.calls).toHaveLength(4);
    let globallySettled = false;
    const globalFlush = writer.flush().then(() => { globallySettled = true; });
    const scopedFlush = writer.flush('project-d');
    const duplicateFlush = writer.flush('project-d');
    const healthy = await authority.call(3);
    expect(healthy.input.projectId).toBe('project-d');
    healthy.succeed();
    await Promise.all([scopedFlush, duplicateFlush]);
    expect(authority.calls).toHaveLength(4);
    expect(globallySettled).toBe(false);
    expect(database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all().map((event) => event.cloudSynced)).toEqual([false, false, false, true]);

    for (const call of authority.calls.slice(0, 3)) call.succeed();
    await globalFlush;
    expect(globallySettled).toBe(true);
    expect(database.orm.select().from(factEvents).all().every((event) => event.cloudSynced)).toBe(true);
  });

  it('keeps scoped requests within capacity and ignores unrelated failure while waiting for a slot', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudProjectEventWriter(authority, database, () => {});
    for (const projectId of ['project-a', 'project-b', 'project-c', 'project-d', 'project-e']) {
      if (projectId !== 'project-a') {
        expect(database.createProject({ id: projectId, name: projectId, repositoryPath: root }).status).toBe('ok');
      }
      append(writer, 1, projectId);
    }
    await authority.call(3);
    const scopedFlush = writer.flush('project-e');
    const sameProjectFlush = writer.flush('project-e');
    await Promise.resolve();
    expect(authority.calls).toHaveLength(4);
    authority.calls[0]!.fail(new Error('Unrelated failure'));
    const healthy = await authority.call(4);
    expect(healthy.input.projectId).toBe('project-e');
    healthy.succeed();
    await Promise.all([scopedFlush, sameProjectFlush]);
    expect(authority.calls).toHaveLength(5);
    for (const call of authority.calls.slice(1, 4)) call.succeed();
    await Promise.all(['project-b', 'project-c', 'project-d'].map((projectId) => writer.flush(projectId)));
    expect(database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all().map((event) => event.cloudSynced)).toEqual([false, true, true, true, true]);
  });

  it('keeps new facts and flushes behind backoff, resetting the delay only after successful delivery', async () => {
    const authority = new DeferredAuthority();
    const errors: unknown[] = [];
    const writer = new CloudProjectEventWriter(authority, database, (error) => errors.push(error));
    append(writer, 1);
    const first = await authority.call(0);
    const firstFlush = writer.flush().catch((error: unknown) => error);
    const overload = new Error('Authority overloaded');
    first.fail(overload);
    expect(await firstFlush).toBe(overload);
    expect(database.orm.select().from(factEvents).all()).toMatchObject([{ cloudSynced: false, revision: 1 }]);

    advance(500);
    append(writer, 2);
    await expect(writer.flush()).rejects.toBe(overload);
    await Promise.resolve();
    expect(authority.calls).toHaveLength(1);
    advance(499);
    await Promise.resolve();
    expect(authority.calls).toHaveLength(1);
    advance(1);
    const firstRetry = await authority.call(1);
    expect(firstRetry.input.eventId).toBe(first.input.eventId);
    const retryFlush = writer.flush().catch((error: unknown) => error);
    firstRetry.fail(overload);
    expect(await retryFlush).toBe(overload);

    advance(1000);
    append(writer, 3);
    writer.committed();
    await expect(writer.flush()).rejects.toBe(overload);
    advance(999);
    await Promise.resolve();
    expect(authority.calls).toHaveLength(2);
    advance(1);
    const secondRetry = await authority.call(2);
    expect(secondRetry.input.eventId).toBe(first.input.eventId);
    secondRetry.succeed();
    const second = await authority.call(3);
    expect(second.input.revision).toBe(2);
    expect(database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all().map((event) => event.cloudSynced)).toEqual([true, false, false]);
    const secondFlush = writer.flush().catch((error: unknown) => error);
    second.fail(overload);
    expect(await secondFlush).toBe(overload);

    // Successful delivery of the oldest fact reset exponential backoff before the next failure.
    advance(999);
    await Promise.resolve();
    expect(authority.calls).toHaveLength(4);
    advance(1);
    const secondEventRetry = await authority.call(4);
    expect(secondEventRetry.input.eventId).toBe(second.input.eventId);
    let settled = false;
    const finalFlush = writer.flush().then(() => { settled = true; });
    secondEventRetry.succeed();
    const third = await authority.call(5);
    expect(third.input.revision).toBe(3);
    expect(settled).toBe(false);
    third.succeed();
    await finalFlush;
    const history = database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all();
    expect(history.map((event) => event.revision)).toEqual([1, 2, 3]);
    expect(history.map((event) => event.cloudSynced)).toEqual([true, true, true]);
    expect(authority.delivered.map((event) => event.eventId)).toEqual(history.map((event) => event.eventId));
    expect(errors).toEqual([overload, overload, overload]);
    await writer.flush();
  });

  it('does not strand a fact committed between the empty outbox read and delivery completion', async () => {
    const authority = new DeferredAuthority();
    const writer = new CloudProjectEventWriter(authority, database, () => {});
    // The constructor's scheduled delivery has read an empty outbox, but has not settled yet.
    await Promise.resolve();
    append(writer, 1);
    let settled = false;
    const flushed = writer.flush().then(() => { settled = true; });
    const delivery = await authority.call(0);
    expect(settled).toBe(false);
    expect(database.orm.select().from(factEvents).all()).toMatchObject([{ cloudSynced: false }]);
    delivery.succeed();
    await flushed;
    expect(database.orm.select().from(factEvents).all()).toMatchObject([{ cloudSynced: true }]);
    expect(authority.delivered.map((event) => event.revision)).toEqual([1]);
  });

  it('recovers only unacknowledged facts on restart without deleting acknowledged history', async () => {
    const firstAuthority = new DeferredAuthority();
    const writer = new CloudProjectEventWriter(firstAuthority, database, () => {});
    append(writer, 1);
    append(writer, 2);
    const first = await firstAuthority.call(0);
    first.succeed();
    const second = await firstAuthority.call(1);
    const failedFlush = writer.flush().catch((error: unknown) => error);
    const disconnected = new Error('Disconnected');
    second.fail(disconnected);
    expect(await failedFlush).toBe(disconnected);
    const beforeRestart = database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all();
    database.close();
    database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const recoveredAuthority = new DeferredAuthority();
    const recovered = new CloudProjectEventWriter(recoveredAuthority, database, () => {});
    const pending = await recoveredAuthority.call(0);
    expect(pending.input.eventId).toBe(second.input.eventId);
    pending.succeed();
    await recovered.flush();
    expect(recoveredAuthority.delivered.map((event) => event.revision)).toEqual([2]);
    const history = database.orm.select().from(factEvents).orderBy(asc(factEvents.offset)).all();
    expect(history.map((event) => event.eventId)).toEqual(beforeRestart.map((event) => event.eventId));
    expect(history.map((event) => event.cloudSynced)).toEqual([true, true]);
  });
});
