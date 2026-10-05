import { describe, expect, it } from 'bun:test';
import {
  applyInferenceSettings,
  extractInferenceSettings,
  inferenceCredentialPaths,
  inferenceSettingsSchema,
  stripInferenceSettings,
} from '../src/inference.js';

describe('inference profile configuration boundaries', () => {
  it('replaces all inherited inference fields while retaining shared Advanced settings', () => {
    const source = {
      modelRoles: { default: 'old/main', reviewer: 'old/reviewer' },
      providers: { models: { old: { baseUrl: 'https://old.example' } } },
      task: { agentModelOverrides: { reviewer: 'old/reviewer' }, maxConcurrency: 3 },
      terminal: { rows: 40 },
    };
    const settings = { modelRoles: { default: 'new/main' } };
    const composed = applyInferenceSettings(source, settings);
    expect(composed).toEqual({
      modelRoles: { default: 'new/main' },
      task: { maxConcurrency: 3 },
      terminal: { rows: 40 },
    });
    expect(source.modelRoles.reviewer).toBe('old/reviewer');
    (composed.modelRoles as Record<string, string>).default = 'changed';
    expect(settings.modelRoles.default).toBe('new/main');
  });

  it('keeps repository skill, agent and plugin discovery switches out of profile ownership', () => {
    // A repository that stops OMP loading Claude plugins and agents must not conflict with, or be stripped by, a profile.
    const repository = { disabledProviders: ['claude', 'claude-plugins'], enabledProviders: ['cursor'], modelRoles: { default: 'repo/model' } };
    expect(extractInferenceSettings(repository)).toEqual({ modelRoles: { default: 'repo/model' } });
    expect(applyInferenceSettings(repository, { modelRoles: { default: 'anthropic/claude' } })).toEqual({
      disabledProviders: ['claude', 'claude-plugins'], enabledProviders: ['cursor'], modelRoles: { default: 'anthropic/claude' },
    });
    expect(inferenceSettingsSchema.safeParse({ disabledProviders: ['claude'] }).success).toBe(false);
  });


  it('preserves custom role, agent and provider names during migration without mistaking names for credentials', () => {
    const source = {
      modelRoles: { auth: 'provider/model-a', token: 'provider/model-b' },
      modelTags: { token: 'provider/model-a' },
      providers: {
        models: { token: { baseUrl: 'https://provider.example/v1', models: [{ id: 'model-a', name: 'Custom' }] } },
        maxInFlightRequests: { token: 2 },
      },
      task: { agentModelOverrides: { auth: 'provider/model-b' }, maxConcurrency: 4 },
    };
    const settings = extractInferenceSettings(source);
    expect(inferenceSettingsSchema.parse(settings)).toEqual(settings);
    expect(applyInferenceSettings(stripInferenceSettings(source), settings)).toEqual(source);
    expect(inferenceSettingsSchema.safeParse({ 'modelRoles.auth': 'provider/model-a' }).success).toBe(true);
  });

  it('applies explicit field edits after stored parent objects regardless of insertion order', () => {
    const settings = {
      'providers.models.custom.baseUrl': 'https://new.example/v1',
      providers: { models: { custom: { baseUrl: 'https://old.example/v1', models: [{ id: 'custom' }] } } },
    };
    expect(applyInferenceSettings({}, settings)).toEqual({
      providers: { models: { custom: { baseUrl: 'https://new.example/v1', models: [{ id: 'custom' }] } } },
    });
  });

  it('rejects provider secrets and authentication headers without including their values in diagnostics', () => {
    const settings = {
      providers: { models: { custom: { apiKey: 'private-key', headers: { 'X-Goog-Api-Key': 'private-header' } } } },
    };
    const result = inferenceSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
    expect(inferenceCredentialPaths(settings)).toEqual([
      'providers.models.custom.apiKey',
      'providers.models.custom.headers.X-Goog-Api-Key',
    ]);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain('private-key');
      expect(JSON.stringify(result.error.issues)).not.toContain('private-header');
    }
  });

  it('rejects credentials hidden in endpoint URLs for both subtree and dotted edits', () => {
    expect(inferenceSettingsSchema.safeParse({
      providers: { models: { custom: { baseUrl: 'https://user:secret@provider.example/v1' } } },
    }).success).toBe(false);
    expect(inferenceSettingsSchema.safeParse({
      'providers.models.custom.baseUrl': 'https://provider.example/v1?key=private-key',
    }).success).toBe(false);
  });

  it('rejects shared-setting and prototype paths rather than letting profiles overwrite unrelated configuration', () => {
    expect(() => applyInferenceSettings({}, { 'task.maxConcurrency': 99 })).toThrow();
    expect(() => applyInferenceSettings({}, { 'providers.__proto__.polluted': true })).toThrow();
    expect(inferenceSettingsSchema.safeParse({ 'providers.constructor.prototype.polluted': true }).success).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});
