import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AnyModel } from '@earendil-works/pi-ai';
import { getAllBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  applyCatalogOverrides, applyModelOverride, CatalogModelSchema, CatalogSchema,
  GITSPACE_MODEL_OVERRIDES, selectEditTool, visibleCatalogModels,
} from '../src/index.js';

const model = {
  id: 'gpt-6-sol', provider: 'cursor', name: 'original', api: 'cursor-agent', baseUrl: 'https://example.test',
  reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

describe('catalog boundaries', () => {
  test('rejects inconsistent keys and preserves hidden rows without exposing them in the picker', () => {
    expect(CatalogSchema.safeParse({ other: { [model.id]: model } }).success).toBe(false);
    const catalog = CatalogSchema.parse({ cursor: { [model.id]: { ...model, hidden: true } } });
    expect(visibleCatalogModels(catalog)).toEqual([]);
    expect(catalog.cursor?.[model.id]?.hidden).toBe(true);
  });

  test('keeps consumer schema extensions and rejects incompatible API overrides', () => {
    const schema = CatalogModelSchema.extend({ api: z.literal('cursor-agent'), admission: z.string() });
    const original = schema.parse({ ...model, admission: 'profile-a' });
    const result = applyModelOverride(original, { name: 'renamed' }, schema);
    expect(result.isOk() && result.value.admission).toBe('profile-a');
    expect(applyModelOverride(original, { api: 'anthropic-messages' }, schema).isErr()).toBe(true);
  });

  test('preserves all nine intentional Bedrock profiles supplied by current Pi without overwriting metadata', () => {
    const bedrock = Object.fromEntries(getAllBuiltinModels('amazon-bedrock').map(row => [row.id, row]));
    const source = CatalogSchema.parse({
      'amazon-bedrock': bedrock,
      cursor: { 'claude-opus-5-5-fast': { ...model, id: 'claude-opus-5-5-fast', cost: { ...model.cost, longContext: { ...model.cost, inputThreshold: 10 } } } },
    });
    const result = applyCatalogOverrides(source);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.cursor).toEqual(source.cursor);
    // These formerly authored additions now ship in Pi's generated Bedrock
    // data. Preserve their availability, not a second copy of their prices.
    for (const id of [
      'global.anthropic.claude-sonnet-5-5', 'global.moonshotai.kimi-k3',
      'global.openai.gpt-6-luna', 'global.openai.gpt-6-sol',
      'openai.gpt-6-luna', 'openai.gpt-6-sol',
      'us.moonshotai.kimi-k3', 'us.openai.gpt-6-luna', 'us.openai.gpt-6-sol',
    ]) {
      expect(result.value['amazon-bedrock']?.[id]?.id).toBe(id);
      expect(result.value['amazon-bedrock']?.[id]).toEqual(source['amazon-bedrock']?.[id]);
    }
  });

  test('replaces explicitly authored rate cards rather than retaining stale upstream tiers', () => {
    const source = CatalogSchema.parse({ cursor: { [model.id]: { ...model, cost: { ...model.cost, longContext: { ...model.cost, inputThreshold: 10 } } } } });
    const cost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    const result = applyCatalogOverrides(source, { cursor: { [model.id]: { cost } } });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.cursor?.[model.id]?.cost).toEqual(cost);
  });

  test('every override field differs from the current bundled Pi catalog', () => {
    // Pi's exported builtin reader reads the installed release's generated model
    // data, not GitSpace's patched catalog or a frozen copy of upstream prices.
    // Never call refreshModels here: this regression must remain entirely offline.
    const upstreamByProvider = new Map<string, AnyModel[]>(
      getBuiltinProviders().map(provider => [provider, getAllBuiltinModels(provider)]),
    );
    for (const [provider, rows] of Object.entries(GITSPACE_MODEL_OVERRIDES)) {
      const upstream = new Map((upstreamByProvider.get(provider) ?? []).map(row => [row.id, row]));
      for (const [id, patch] of Object.entries(rows)) {
        const original = upstream.get(id);
        expect(original, `Override has no current upstream model: ${provider}/${id}`).toBeDefined();
        for (const [field, value] of Object.entries(patch)) {
          const upstreamValue = original && Reflect.get(original, field);
          expect(value, `Redundant override: ${provider}/${id}.${field}`).not.toEqual(upstreamValue);
        }
      }
    }
  });


  test('selects the trained edit format independently of provider and honors exact overrides', () => {
    expect(selectEditTool({ provider: 'openrouter', id: 'openai/gpt-6-sol' })).toBe('apply_patch');
    expect(selectEditTool({ provider: 'amazon-bedrock', id: 'global.openai.gpt-6-sol' })).toBe('apply_patch');
    expect(selectEditTool({ provider: 'amazon-bedrock', id: 'openai.gpt-6-luna' })).toBe('apply_patch');
    expect(selectEditTool({ provider: 'gateway', id: 'us.vendor.gpt-6-luna' })).toBe('apply_patch');
    expect(selectEditTool({ provider: 'openai', id: 'gpt-oss-120b' })).toBe('edit');
    expect(selectEditTool({ provider: 'openai', id: 'gpt-6-sol' }, { openai: { 'gpt-6-sol': 'edit' } })).toBe('edit');
  });
});
