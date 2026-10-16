import { describe, expect, it } from 'vitest';
import { applyInferenceSettings, type InferenceProfile } from '@gitspace/protocol/inference';
import { profileSettingViews, updatedProfileSettings } from './inference-settings.js';
import type { RuntimeSettingView } from './SettingsPage.js';

const profile: InferenceProfile = {
  version: 1, id: 'client-a', name: 'Client A', revision: 4,
  settings: { providers: { models: { private: { baseUrl: 'https://models.example.test', models: [] } } }, modelRoles: { default: 'private/missing-model', taste: 'private/taste-model' } },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};
const field = (path: string, valueJson: string, defaultJson?: string): RuntimeSettingView => ({ path, tab: 'runtime', label: path, description: null, kind: 'record', valueJson, defaultJson, options: [], credential: false });

describe('profile settings projection', () => {
  it('reads nested owned subtrees and schema defaults without borrowing account configuration', () => {
    const view = profileSettingViews([
      field('enabledModels', '["account-private/*"]', '[]'),
      field('modelRoles', '{"default":"account/model"}', '{}'),
      field('terminal.shell', '"account shell"', '"bash"'),
    ], profile);
    const values = Object.fromEntries(view.items.map((item) => [item.path, JSON.parse(item.valueJson)]));
    expect(values.enabledModels).toEqual([]);
    expect(values.modelRoles).toEqual({ default: 'private/missing-model', taste: 'private/taste-model' });
    expect(values['providers.models']).toEqual({ private: { baseUrl: 'https://models.example.test', models: [] } });
    expect(values).not.toHaveProperty('terminal.shell');
  });

  it('reports missing default metadata instead of exposing the account value', () => {
    const view = profileSettingViews([field('enabledModels', '["private-account/*"]')], profile);
    expect(view.missingDefaults).toEqual(['enabledModels']);
    expect(view.items.some((item) => item.path === 'enabledModels')).toBe(false);
  });

  it('replaces nested edits without losing custom siblings and replaces a whole subtree without resurrecting stale children', () => {
    const edited = updatedProfileSettings(profile, 'modelRoles.default', 'private/next-model');
    expect(applyInferenceSettings({}, edited).modelRoles).toEqual({ default: 'private/next-model', taste: 'private/taste-model' });
    expect(profile.settings.modelRoles).toEqual({ default: 'private/missing-model', taste: 'private/taste-model' });
    const replaced = updatedProfileSettings({ ...profile, settings: { ...profile.settings, 'providers.models.private.baseUrl': 'https://old.example.test' } }, 'providers.models', { next: { models: [] } });
    expect(applyInferenceSettings({}, replaced).providers).toEqual({ models: { next: { models: [] } } });
  });

  it('rejects raw credentials before any profile update can be submitted', () => {
    expect(() => updatedProfileSettings(profile, 'providers.models', { private: { apiKey: 'fixture-not-a-secret' } })).toThrow(/credential/i);
    expect(() => updatedProfileSettings(profile, 'providers.models', { private: { headers: { Authorization: 'fixture-not-a-token' } } })).toThrow(/credential/i);
    expect(() => updatedProfileSettings(profile, 'terminal.shell', 'bash')).toThrow();
  });
});
