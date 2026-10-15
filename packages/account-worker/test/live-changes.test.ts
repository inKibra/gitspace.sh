import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { LiveNotice } from '@gitspace/protocol/live-notice';
import { LiveChanges } from '../src/live-changes.js';

describe('live change notices', () => {
  it('notices each changed resource once per committed write, and nothing when nothing changed', async () => {
    await runInDurableObject(env.USER_PROJECTS.getByName('change-notices'), (_instance, state) => {
      const notify = vi.fn<(notices: LiveNotice[]) => void>();
      const changes = new LiveChanges(state.storage, notify);
      state.storage.transactionSync(() => {
        changes.mark('settings');
        changes.mark('space:workspace-a');
        changes.mark('settings');
      });
      changes.wake();
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith([
        { project: null, workspace: null, resource: 'settings', version: expect.any(Number) },
        { project: null, workspace: 'workspace-a', resource: 'space', version: expect.any(Number) },
      ]);
      changes.wake();
      expect(notify).toHaveBeenCalledOnce();
    });
  });
});
