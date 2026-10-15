import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { LiveNotice } from '@gitspace/protocol/live-notice';
import { DurableChangeLog } from '../src/durable-stream.js';

describe('change log notices and bounded reads', () => {
  it('notices each changed resource once per committed write, at its newest cursor', async () => {
    await runInDurableObject(env.USER_PROJECTS.getByName('change-log-notices'), (_instance, state) => {
      const notify = vi.fn<(notices: LiveNotice[]) => void>();
      const changes = new DurableChangeLog(state.storage, notify);
      state.storage.transactionSync(() => {
        changes.append('settings', 1);
        changes.append('space:workspace-a', 1);
        changes.append('account-directory', 1);
      });
      const settings = changes.append('settings', 2);
      changes.wake();
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith([
        { project: null, workspace: null, resource: 'settings', version: settings },
        { project: null, workspace: 'workspace-a', resource: 'space', version: changes.head('space:workspace-a') },
      ]);
      changes.wake();
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it('answers a read after its cursor with only newer changes, and a reader far behind with the snapshot', async () => {
    await runInDurableObject(env.USER_PROJECTS.getByName('change-log-replay'), (_instance, state) => {
      const changes = new DurableChangeLog(state.storage);
      const first = changes.append('settings', 'first');
      const second = changes.append('settings', 'second');
      expect(changes.replay('settings', first, () => 'now', false)).toEqual([{ type: 'change', resource: 'settings', cursor: second, revision: second, previous: first, value: 'second' }]);
      expect(changes.replay('settings', second, () => 'now', false)).toEqual([]);
      for (let index = 0; index < 70; index++) changes.append('settings', index);
      const head = changes.head('settings');
      expect(changes.replay('settings', second, () => 'now', false)).toEqual([{ type: 'snapshot', resource: 'settings', cursor: head, revision: head, previous: null, value: 'now' }]);
    });
  });
});
