import { applyInferenceSettings, extractInferenceSettings, inferenceSettingSection, inferenceSettingsSchema, type InferenceProfile } from '@gitspace/protocol/inference';
import type { OmpSettingValue } from '@gitspace/protocol';
import type { OmpSettingView } from './SettingsPage.js';

/** Never read shared account values as a profile fallback, even with an older metadata producer. */
export function profileSettingViews(schema: readonly OmpSettingView[], profile: InferenceProfile): { items: OmpSettingView[]; missingDefaults: string[] } {
  const config = applyInferenceSettings({}, profile.settings);
  const items: OmpSettingView[] = [];
  const missingDefaults: string[] = [];
  const metadata = schema.some((item) => item.path === 'providers.models') ? schema : [...schema, {
    path: 'providers.models', tab: 'Providers', label: 'Custom provider models',
    description: 'Non-secret ModelsConfig.providers JSON for custom endpoints and models. Connect all credentials through the vault above; never put API keys, authorization headers, tokens, or key helpers here.',
    kind: 'record' as const, valueJson: '{}', defaultJson: '{}', options: [], credential: false,
  }];
  for (const item of metadata) {
    if (!inferenceSettingSection(item.path) || item.credential) continue;
    let value: unknown = config;
    for (const part of item.path.split('.')) {
      value = value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
    }
    const valueJson = value === undefined ? item.defaultJson : JSON.stringify(value);
    if (valueJson === undefined) { missingDefaults.push(item.path); continue; }
    items.push({ ...item, valueJson });
  }
  return { items, missingDefaults };
}

/** A schema-path edit replaces its subtree without losing custom siblings or retaining stale child overrides. */
export function updatedProfileSettings(profile: InferenceProfile, path: string, value: OmpSettingValue): InferenceProfile['settings'] {
  const settings = extractInferenceSettings(applyInferenceSettings({}, profile.settings));
  // First canonicalize subtrees, then apply the edited path so parent/child ordering is deterministic.
  for (const key of Object.keys(settings)) if (key === path || key.startsWith(`${path}.`)) delete settings[key];
  const next = extractInferenceSettings(applyInferenceSettings({}, { ...settings, [path]: value }));
  const parsed = inferenceSettingsSchema.safeParse(next);
  if (!parsed.success) throw new Error('Only non-secret inference configuration can be saved. Connect credentials through this profile’s Providers controls.');
  return parsed.data;
}
