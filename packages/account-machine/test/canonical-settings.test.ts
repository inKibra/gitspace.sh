import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { resetSettingsForTest } from '@oh-my-pi/pi-coding-agent/config/settings';
import type { OmpConfigDocument, UserSettings, UserSettingsUpdate } from '@gitspace/protocol';
import { CanonicalSettingsCoordinator, type CanonicalSettingsCloud } from '../src/canonical-settings.js';

const roots: string[] = [];
function hash(content: string): `sha256:${string}` { return `sha256:${new Bun.CryptoHasher('sha256').update(content).digest('hex')}`; }
function waitFor(check: () => boolean, timeout = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('Timed out waiting for settings synchronization'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

class FakeCloud implements CanonicalSettingsCloud {
  document: OmpConfigDocument;
  private listeners = new Set<(event: { userRevision: number; ompGeneration: number }) => void>();
  constructor(content: string) {
    this.document = { generation: content ? 1 : 0, content, checksum: hash(content), updatedAt: new Date().toISOString(), updatedBy: 'cloud' };
  }
  async getUserSettings(): Promise<UserSettings> {
    return { version: 1, revision: 0, onboardingComplete: false, profile: { displayName: '', handle: null }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, updatedAt: new Date(0).toISOString(), updatedBy: 'cloud' };
  }
  async updateUserSettings(_input: UserSettingsUpdate): Promise<UserSettings> { throw new Error('unused'); }
  async reserveUserHandle(_expectedRevision: number, _handle: string): Promise<UserSettings> { throw new Error('unused'); }
  async getOmpConfig(): Promise<OmpConfigDocument> { return { ...this.document }; }
  async updateOmpConfig(input: { expectedGeneration: number; content: string; checksum: `sha256:${string}` }): Promise<OmpConfigDocument> {
    if (input.expectedGeneration !== this.document.generation) throw new Error('stale');
    this.document = { generation: this.document.generation + 1, content: input.content, checksum: input.checksum, updatedAt: new Date().toISOString(), updatedBy: 'machine-a' };
    return { ...this.document };
  }
  subscribeSettings(onChange: (event: { userRevision: number; ompGeneration: number }) => void, onState: (state: 'connecting' | 'open' | 'offline') => void): () => void {
    this.listeners.add(onChange);
    onState('open');
    return () => this.listeners.delete(onChange);
  }
  publish(): void {
    for (const listener of this.listeners) listener({ userRevision: 0, ompGeneration: this.document.generation });
  }
}

afterEach(() => {
  resetSettingsForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical OMP settings synchronization', () => {
  it('materializes cloud config, publishes native writes, and pulls newer generations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-settings-'));
    roots.push(root);
    const agentDir = join(root, '.pi');
    const cloud = new FakeCloud('cycleOrder:\n  - default\n');
    let reloads = 0;
    const coordinator = new CanonicalSettingsCoordinator(cloud, 'machine-a', agentDir, root, async () => { reloads += 1; });
    await coordinator.start();
    const observed: number[] = [];
    const unsubscribe = coordinator.subscribe((event) => observed.push(event.ompGeneration));
    expect(readFileSync(join(agentDir, 'config.yml'), 'utf8')).toBe(cloud.document.content);

    const localEdit = 'cycleOrder:\n  - slow\n';
    writeFileSync(join(agentDir, 'config.yml'), localEdit);
    await waitFor(() => cloud.document.content === localEdit);
    expect(cloud.document.generation).toBe(2);

    const remoteEdit = 'cycleOrder:\n  - smol\n';
    cloud.document = { generation: 3, content: remoteEdit, checksum: hash(remoteEdit), updatedAt: new Date().toISOString(), updatedBy: 'machine-b' };
    cloud.publish();
    await waitFor(() => readFileSync(join(agentDir, 'config.yml'), 'utf8') === remoteEdit);
    expect(reloads).toBeGreaterThan(0);
    await coordinator.stop();
    expect(observed).toContain(3);
    unsubscribe();
  });

  it('starts from the writable local replica while cloud control is offline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-settings-offline-'));
    roots.push(root);
    const agentDir = join(root, '.pi');
    mkdirSync(agentDir, { recursive: true });
    const content = 'cycleOrder:\n  - slow\n';
    writeFileSync(join(agentDir, 'config.yml'), content);
    const cloud = new FakeCloud('');
    cloud.getOmpConfig = async () => { throw new Error('offline'); };
    const coordinator = new CanonicalSettingsCoordinator(cloud, 'machine-a', agentDir, root, async () => undefined);
    await coordinator.start();
    expect(readFileSync(join(agentDir, 'config.yml'), 'utf8')).toBe(content);
    expect((await coordinator.getOmpSettings()).document).toMatchObject({ generation: 0, content });
    await coordinator.stop();
  });
});
