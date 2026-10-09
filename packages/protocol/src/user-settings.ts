import { z } from 'zod';
import { RuntimeCachePolicySchema } from '@gitspace/protocol-runtime';

export const userProfileSettingsSchema = z.object({
  displayName: z.string().trim().max(160),
  handle: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u).nullable(),
});

export const userGitSettingsSchema = z.object({
  authorName: z.string().trim().max(160),
  authorEmail: z.string().trim().email().max(254).or(z.literal('')),
});

export const userDefaultSettingsSchema = z.object({
  machineId: z.string().min(1).max(160).nullable(),
  enterAction: z.enum(['queue', 'steer']),
  /** Interface colour scheme; `system` follows the OS. */
  appearance: z.enum(['system', 'light', 'dark']).default('system'),
});

export const userMachineSettingsSchema = z.object({
  /** Seconds a paused machine cache is retained before safe reclamation, for every workspace. */
  cacheReclaimSeconds: RuntimeCachePolicySchema.shape.reclaimSeconds,
});

export const userSettingsSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  onboardingComplete: z.boolean(),
  profile: userProfileSettingsSchema,
  git: userGitSettingsSchema,
  defaults: userDefaultSettingsSchema,
  machines: userMachineSettingsSchema,
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(160),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const userSettingsUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  onboardingComplete: z.boolean(),
  profile: userProfileSettingsSchema,
  git: userGitSettingsSchema,
  defaults: userDefaultSettingsSchema,
  machines: userMachineSettingsSchema,
});
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;

export const runtimeConfigDocumentSchema = z.object({
  generation: z.number().int().nonnegative(),
  content: z.string().max(262_144),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(160),
});
export type RuntimeConfigDocument = z.infer<typeof runtimeConfigDocumentSchema>;

export const runtimeConfigUpdateSchema = z.object({
  expectedGeneration: z.number().int().nonnegative(),
  content: z.string().max(262_144),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export type RuntimeConfigUpdate = z.infer<typeof runtimeConfigUpdateSchema>;
export const gitIdentityDocumentSchema = z.object({
  generation: z.number().int().positive(),
  privateKey: z.string().min(64).max(16_384),
  publicKey: z.string().startsWith('ssh-ed25519 ').max(4_096),
  fingerprint: z.string().startsWith('SHA256:').max(128),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(160),
});
export type GitIdentityDocument = z.infer<typeof gitIdentityDocumentSchema>;

export const gitIdentityUpdateSchema = z.object({
  expectedGeneration: z.number().int().nonnegative(),
  privateKey: z.string().min(64).max(16_384),
  publicKey: z.string().startsWith('ssh-ed25519 ').max(4_096),
  fingerprint: z.string().startsWith('SHA256:').max(128),
});
export type GitIdentityUpdate = z.infer<typeof gitIdentityUpdateSchema>;


/**
 * Named interfaces keep recursion lazy: Durable Object stub typing expands anonymous
 * recursive aliases (zod's JSONType) until TS2589.
 */
export type RuntimeSettingValue = string | number | boolean | null | RuntimeSettingArray | RuntimeSettingObject;
export interface RuntimeSettingArray extends Array<RuntimeSettingValue> {}
export interface RuntimeSettingObject { [key: string]: RuntimeSettingValue }
export const runtimeSettingValueSchema: z.ZodType<RuntimeSettingValue> = z.json();

export const runtimeSettingSchemaItemSchema = z.object({
  path: z.string().min(1),
  tab: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(['boolean', 'enum', 'number', 'string', 'array', 'record', 'other']),
  value: runtimeSettingValueSchema,
  /** Schema default, not another profile's effective value. */
  defaultJson: z.string().optional(),
  options: z.array(z.string()).optional(),
  optionLabels: z.record(z.string(), z.string()).optional(),
  credential: z.boolean(),
});
export type RuntimeSettingSchemaItem = z.infer<typeof runtimeSettingSchemaItemSchema>;

/** Only settings consumed by the cloud Pi harness are admitted here. */
export const runtimeSettingsSchema = z.strictObject({
  compaction: z.strictObject({
    enabled: z.boolean().optional(),
    reserveTokens: z.number().int().positive().max(1_000_000).optional(),
    keepRecentTokens: z.number().int().nonnegative().max(1_000_000).optional(),
    backgroundTokens: z.number().int().nonnegative().max(1_000_000).optional(),
  }).optional(),
  retry: z.strictObject({
    enabled: z.boolean().optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    baseDelayMs: z.number().int().nonnegative().max(60_000).optional(),
    maxAgentDelayMs: z.number().int().nonnegative().max(600_000).optional(),
  }).optional(),
  toolExecution: z.enum(['parallel', 'sequential']).optional(),
  steeringMode: z.enum(['all', 'one-at-a-time']).optional(),
  followUpMode: z.enum(['all', 'one-at-a-time']).optional(),
});
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  const parsed = runtimeSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Unsupported runtime configuration. Credentials, inference profile settings, and legacy OMP settings are not runtime settings.');
  return parsed.data;
}

export function runtimeSettingsView(value: RuntimeSettings): RuntimeSettingSchemaItem[] {
  const rows: Array<[string, string, RuntimeSettingSchemaItem['kind'], string[]]> = [
    ['compaction.enabled', 'Automatic compaction', 'boolean', []],
    ['compaction.reserveTokens', 'Compaction reserve tokens', 'number', []],
    ['compaction.keepRecentTokens', 'Recent tokens to retain', 'number', []],
    ['compaction.backgroundTokens', 'Background compaction tokens', 'number', []],
    ['retry.enabled', 'Retry transient failures', 'boolean', []],
    ['retry.maxRetries', 'Maximum retries', 'number', []],
    ['retry.baseDelayMs', 'Retry delay (ms)', 'number', []],
    ['retry.maxAgentDelayMs', 'Maximum agent retry delay (ms)', 'number', []],
    ['toolExecution', 'Tool execution', 'enum', ['parallel', 'sequential']],
    ['steeringMode', 'Steering delivery', 'enum', ['all', 'one-at-a-time']],
    ['followUpMode', 'Follow-up delivery', 'enum', ['all', 'one-at-a-time']],
  ];
  return rows.map(([path, label, kind, options]) => {
    let selected: unknown = value;
    for (const part of path.split('.')) selected = selected && typeof selected === 'object' ? (selected as Record<string, unknown>)[part] : undefined;
    return { path, label, tab: 'runtime', kind, value: (selected ?? null) as RuntimeSettingValue, options, credential: false, description: 'Applies to newly opened cloud sessions. Unset values use Pi runtime defaults.' };
  });
}

export function setRuntimeSetting(config: RuntimeSettings, path: string, value: RuntimeSettingValue): RuntimeSettings {
  if (!runtimeSettingsView(config).some((item) => item.path === path)) throw new Error('Unknown runtime setting; credentials and inference settings must use their dedicated management APIs.');
  const next = structuredClone(config) as Record<string, unknown>;
  const parts = path.split('.');
  const leaf = parts.pop()!;
  let target = next;
  for (const part of parts) target = (target[part] ??= {}) as Record<string, unknown>;
  if (value === null) delete target[leaf];
  else target[leaf] = value;
  return parseRuntimeSettings(next);
}
