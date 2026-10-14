import { afterEach, expect, it, vi } from 'vitest';
import { accountLiveKey, workspaceLiveKey } from '@gitspace/protocol/live-notice';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { LiveNotices, liveSource } from './live-notices.js';
import { SynchronizationOwner } from './synchronization.js';

const key = workspaceLiveKey('workspace', 'environment');
type Read = { after: number | null; resolve(events: StreamEvent<string>[]): void };
const owners: SynchronizationOwner[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); });

function scene() {
  const notices = new LiveNotices();
  const reads: Read[] = [];
  const read = vi.fn((after: number | null) => {
    const { promise, resolve } = Promise.withResolvers<{ status: 'ok'; value: StreamEvent<string>[] }>();
    reads.push({ after, resolve: (events) => resolve({ status: 'ok', value: events }) });
    return promise;
  });
  const owner = new SynchronizationOwner();
  owners.push(owner);
  const channel = owner.channel('environment:workspace', liveSource([key], read, notices));
  channel.subscribe(() => {});
  return { notices, reads, read, channel };
}
const change = (previous: number, cursor: number, value: string): StreamEvent<string> => ({ type: 'change', resource: 'environment:workspace', cursor, revision: cursor, previous, value });
/** Lets every queued continuation run, so a refetch that would happen has happened. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
it('refetches once per notice with its cursor, and a burst during a read queues exactly one more', async () => {
  const { notices, reads, read, channel } = scene();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  expect(reads[0]!.after).toBeNull();
  reads[0]!.resolve([{ type: 'snapshot', resource: 'environment:workspace', cursor: 1, revision: 1, previous: null, value: 'first' }]);
  await vi.waitFor(() => expect(channel.snapshot()).toMatchObject({ cursor: 1, value: 'first', connection: 'open' }));

  notices.receive({ ...key, version: 2 });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(reads[1]!.after).toBe(1);
  for (let version = 3; version < 8; version++) notices.receive({ ...key, version });
  reads[1]!.resolve([change(1, 2, 'second')]);
  await vi.waitFor(() => expect(reads).toHaveLength(3));
  expect(reads[2]!.after).toBe(2);
  reads[2]!.resolve([change(2, 3, 'third')]);
  await vi.waitFor(() => expect(channel.snapshot()).toMatchObject({ cursor: 3, value: 'third' }));
  await settle();
  expect(read).toHaveBeenCalledTimes(3);
});

it('ignores notices for keys it does not watch, and stops watching when unobserved', async () => {
  const { notices, reads, read, channel } = scene();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  reads[0]!.resolve([{ type: 'snapshot', resource: 'environment:workspace', cursor: 1, revision: 1, previous: null, value: 'first' }]);
  await vi.waitFor(() => expect(channel.snapshot().cursor).toBe(1));
  notices.receive({ ...workspaceLiveKey('other', 'environment'), version: 2 });
  notices.receive({ ...accountLiveKey('environment'), version: 2 });
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
  owners.splice(0).forEach((owner) => owner.dispose());
  notices.receive({ ...key, version: 2 });
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
});

it('reports the channel open after a reconnect read finds nothing new', async () => {
  const { notices, reads, channel } = scene();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  reads[0]!.resolve([{ type: 'snapshot', resource: 'environment:workspace', cursor: 1, revision: 1, previous: null, value: 'first' }]);
  await vi.waitFor(() => expect(channel.snapshot().cursor).toBe(1));
  const socket = { readyState: 1, send: vi.fn() };
  notices.attach(socket as unknown as WebSocket);
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', keys: [key] }));
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(reads[1]!.after).toBe(1);
  reads[1]!.resolve([]);
  await settle();
  expect(channel.snapshot()).toMatchObject({ cursor: 1, value: 'first', connection: 'open', transportError: null });
});
