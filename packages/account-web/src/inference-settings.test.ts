import { describe, expect, it } from 'vitest';
import { applyInferenceSettings, type InferenceProfile } from '@gitspace/protocol/inference';
import { profileSettingViews, updatedProfileSettings } from './inference-settings.js';
import type { OmpSettingView } from './SettingsPage.js';

const profile: InferenceProfile = {
  version: 1, id: 'client-a', name: 'Client A', revision: 4,
  settings: { agents: { enabled: false, custom: { keep: 'unchanged' } }, providers: { models: { private: { baseUrl: 'https://models.example.test', models: [] } } }, modelRoles: { default: 'private/missing-model' } },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};
const field = (path: string, valueJson: string, defaultJson?: string): OmpSettingView => ({ path, tab: 'runtime', label: path, description: null, kind: 'record', valueJson, defaultJson, options: [], credential: false });

describe('profile settings projection', () => {
  it('reads nested owned subtrees and schema defaults without borrowing account configuration', () => {
    const view = profileSettingViews([
      field('agents.enabled', 'true', 'true'),
      field('task.agentModelOverrides', '{"task":"account-private/model"}', '{}'),
      field('modelRoles', '{"default":"account/model"}', '{}'),
      field('terminal.shell', '"account shell"', '"bash"'),
    ], profile);
    const values = Object.fromEntries(view.items.map((item) => [item.path, JSON.parse(item.valueJson)]));
    expect(values['agents.enabled']).toBe(false);
    expect(values['task.agentModelOverrides']).toEqual({});
    expect(values.modelRoles).toEqual({ default: 'private/missing-model' });
    expect(values['providers.models']).toEqual({ private: { baseUrl: 'https://models.example.test', models: [] } });
    expect(values).not.toHaveProperty('terminal.shell');
  });

  it('reports missing default metadata instead of exposing the account value', () => {
    const view = profileSettingViews([field('task.agentModelOverrides', '{"task":"private-account/model"}')], profile);
    expect(view.missingDefaults).toEqual(['task.agentModelOverrides']);
    expect(view.items.some((item) => item.path === 'task.agentModelOverrides')).toBe(false);
  });

  it('replaces nested edits without losing custom siblings and replaces a whole subtree without resurrecting stale children', () => {
    const edited = updatedProfileSettings(profile, 'agents.enabled', true);
    expect(applyInferenceSettings({}, edited).agents).toEqual({ enabled: true, custom: { keep: 'unchanged' } });
    expect(profile.settings.agents).toEqual({ enabled: false, custom: { keep: 'unchanged' } });
    const replaced = updatedProfileSettings({ ...profile, settings: { ...profile.settings, 'providers.models.private.baseUrl': 'https://old.example.test' } }, 'providers.models', { next: { models: [] } });
    expect(applyInferenceSettings({}, replaced).providers).toEqual({ models: { next: { models: [] } } });
  });

  it('rejects raw credentials before any profile update can be submitted', () => {
    expect(() => updatedProfileSettings(profile, 'providers.models', { private: { apiKey: 'fixture-not-a-secret' } })).toThrow(/credential/i);
    expect(() => updatedProfileSettings(profile, 'providers.models', { private: { headers: { Authorization: 'fixture-not-a-token' } } })).toThrow(/credential/i);
    expect(() => updatedProfileSettings(profile, 'terminal.shell', 'bash')).toThrow();
  });
});
