import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { RuntimeConfigDocument, UserSettings } from '@gitspace/protocol';
import { CanonicalSettingsConflict, CanonicalSettingsCoordinator, type CanonicalSettingsCloud } from '../src/canonical-settings.js';

function cloudSettings(): CanonicalSettingsCloud {
  let document: RuntimeConfigDocument = { generation: 0, content: '{}', checksum: `sha256:${createHash('sha256').update('{}').digest('hex')}`, updatedAt: new Date(0).toISOString(), updatedBy: 'cloud' };
  const user: UserSettings = { version: 1, revision: 0, onboardingComplete: false, profile: { displayName: '', handle: null }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, updatedAt: new Date(0).toISOString(), updatedBy: 'cloud' };
  return {
    async getUserSettings() { return user; },
    async updateUserSettings(input) { return { ...user, ...input, revision: user.revision + 1 }; },
    async reserveUserHandle() { return user; },
    async getRuntimeConfig() { return document; },
    async updateRuntimeConfig(input) {
      if (input.expectedGeneration !== document.generation) throw new CanonicalSettingsConflict('runtime-config', input.expectedGeneration, document.generation);
      document = { ...document, content: input.content, checksum: input.checksum, generation: document.generation + 1 };
      return document;
    },
  };
}
describe('cloud-owned canonical settings', () => {
  it('rejects stale edits without replacing a newer cloud value', async () => {
    const coordinator = new CanonicalSettingsCoordinator(cloudSettings());
    await coordinator.setRuntimeSetting('toolExecution', 'sequential', 0);
    await expect(coordinator.setRuntimeSetting('toolExecution', 'parallel', 0)).rejects.toBeInstanceOf(CanonicalSettingsConflict);
    expect(JSON.parse((await coordinator.getRuntimeSettings()).document.content)).toEqual({ toolExecution: 'sequential' });
  });
  it('rejects inference and credential settings before publishing', async () => {
    const coordinator = new CanonicalSettingsCoordinator(cloudSettings());
    await expect(coordinator.setRuntimeSetting('modelRoles', {}, 0)).rejects.toThrow();
    await expect(coordinator.setRuntimeSetting('auth.broker.token', 'private-token', 0)).rejects.toThrow();
    await expect(coordinator.setRuntimeSetting('compaction.enabled', 'yes', 0)).rejects.toThrow();
    expect((await coordinator.getRuntimeSettings()).document.generation).toBe(0);
  });
});
