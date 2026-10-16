import { wire } from './json-wire.js'
import { z } from 'zod';
import { runtimeConfigDocumentSchema, runtimeSettingValueSchema, type RuntimeSettingValue, type RuntimeSettingSchemaItem } from './user-settings.js';
import { RuntimeSubagentRecordSchema } from '@gitspace/protocol-runtime/session-controls';

export const DEFAULT_INFERENCE_PROFILE_ID = 'default';
export const INFERENCE_PROFILE_VERSION = 1 as const;
export type InferenceSettingSection = 'Models' | 'Providers';
/** Roles every profile offers; a profile may add its own. An unset role resolves to Default. */
export const BUILT_IN_MODEL_ROLES = ['default', 'deep', 'fast', 'taste'] as const;
export const MODEL_ROLE_LABELS: Readonly<Record<string, string>> = { default: 'Default', deep: 'Deep', fast: 'Fast', taste: 'Taste' };
export const modelRoleThinkingSchema = RuntimeSubagentRecordSchema.shape.thinking;
export type ModelRoleSelector = { selector: string; thinking: z.infer<typeof modelRoleThinkingSchema> };
/** Only a recognized terminal effort is syntax; provider model IDs may contain literal colons. */
export function parseModelRoleSelector(value: string): ModelRoleSelector {
  const separator = value.lastIndexOf(':');
  if (separator > value.indexOf('/')) {
    const thinking = modelRoleThinkingSchema.safeParse(value.slice(separator + 1));
    if (thinking.success) return { selector: value.slice(0, separator), thinking: thinking.data };
  }
  return { selector: value, thinking: null };
}
const unsafeSegments = new Set(['__proto__', 'prototype', 'constructor']);
const credentialFields: Record<string, true> = {
  apikey: true, accesstoken: true, refreshtoken: true, authorization: true, password: true,
  clientsecret: true, secretaccesskey: true, accesskeyid: true, sessiontoken: true,
  credential: true, credentials: true, apikeyhelper: true, authcommand: true, token: true,
  oauth: true, auth: true, cookie: true, authheaders: true,
};
const namedEntryMaps: Record<string, true> = {
  modelRoles: true, 'providers.models': true, 'providers.maxInFlightRequests': true,
};

const inferenceRootSections: Record<string, InferenceSettingSection> = {
  modelRoles: 'Models', enabledModels: 'Models', visionFallback: 'Models', providers: 'Providers',
};
/** One ownership map shared by migration, editors and isolated runtime composition. */
export function inferenceSettingSection(path: string): InferenceSettingSection | null {
  const dot = path.indexOf('.');
  const root = dot < 0 ? path : path.slice(0, dot);
  return Object.hasOwn(inferenceRootSections, root) ? inferenceRootSections[root]! : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safePath(path: string): boolean {
  return path.length > 0 && path.split('.').every(part => part.length > 0 && !unsafeSegments.has(part));
}

export function isInferenceCredentialField(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot >= 0 && Object.hasOwn(namedEntryMaps, path.slice(0, dot))) return false;
  const key = path.slice(path.lastIndexOf('.') + 1).replace(/[-_]/gu, '').toLowerCase();
  return Object.hasOwn(credentialFields, key) || key.endsWith('apikey') || key.endsWith('authorization') || key.endsWith('token');
}

/** Returns paths, never credential values. Migration must vault or reject these fields. */
export function inferenceCredentialPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string' && /(?:^|\.)(?:base_?url|url|endpoint)$/iu.test(prefix)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return [prefix];
      for (const name of url.searchParams.keys()) {
        if (name === 'key' || isInferenceCredentialField(name)) return [prefix];
      }
    } catch { /* Endpoint syntax is validated by the provider, not the credential classifier. */ }
    return [];
  }
  if (!record(value) && !Array.isArray(value)) return [];
  const paths: string[] = [];
  const namedEntries = Object.hasOwn(namedEntryMaps, prefix);
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!namedEntries && isInferenceCredentialField(path) && child !== null && child !== '' && child !== undefined) paths.push(path);
    else paths.push(...inferenceCredentialPaths(child, path));
  }
  return paths;
}

/** Preserve complete owned subtrees (including custom roles/provider configuration). */
export function extractInferenceSettings(config: Record<string, unknown>): Record<string, RuntimeSettingValue> {
  const settings: Record<string, RuntimeSettingValue> = {};
  const visit = (value: Record<string, unknown>, prefix: string): void => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!safePath(path)) throw new Error('Unsafe configuration path');
      if (inferenceSettingSection(path)) {
        if (child !== undefined) settings[path] = structuredClone(runtimeSettingValueSchema.parse(child));
      } else if (record(child)) visit(child, path);
    }
  };
  visit(config, '');
  return settings;
}

/** Remove account/repository inference fields before applying a profile, including omitted fields. */
export function stripInferenceSettings(config: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!safePath(path)) throw new Error('Unsafe configuration path');
      if (inferenceSettingSection(path)) continue;
      result[key] = record(child) ? visit(child, path) : structuredClone(child);
    }
    return result;
  };
  return visit(config, '');
}

export function applyInferenceSettings(config: Record<string, unknown>, settings: Record<string, RuntimeSettingValue>): Record<string, unknown> {
  const result = stripInferenceSettings(config);
  // A schema-path edit takes precedence over its stored parent subtree, independent of JSON key order.
  for (const path of Object.keys(settings).sort((left, right) => left.split('.').length - right.split('.').length || left.localeCompare(right))) {
    if (!safePath(path) || !inferenceSettingSection(path)) throw new Error(`Setting does not belong to an inference profile: ${path}`);
    const parts = path.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!record(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = structuredClone(settings[path]);
  }
  return result;
}

/** Profile editor metadata is independent of any machine-installed runtime schema. */
export const inferenceSettingMetadata: readonly RuntimeSettingSchemaItem[] = [
  { path: 'modelRoles', tab: 'Models', label: 'Model roles', kind: 'record', value: {}, defaultJson: '{}', credential: false },
  { path: 'enabledModels', tab: 'Models', label: 'Enabled models', kind: 'array', value: [], defaultJson: '[]', credential: false },
  { path: 'visionFallback', tab: 'Models', label: 'Vision fallback', kind: 'string', value: '', defaultJson: '""', credential: false, description: 'Describes images for a model that cannot read them. Not offered as a role.' },
  { path: 'providers.models', tab: 'Providers', label: 'Custom provider models', kind: 'record', value: {}, defaultJson: '{}', credential: false, description: 'Non-secret provider endpoints and model definitions. Store credentials through the profile credential vault.' },
];

const profileIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
const revisionSchema = z.number().int().nonnegative();
export const inferenceSettingsSchema = z.record(z.string(), runtimeSettingValueSchema).superRefine((settings, context) => {
  for (const [path, value] of Object.entries(settings)) {
    if (!safePath(path) || !inferenceSettingSection(path)) context.addIssue({ code: 'custom', path: [path], message: 'Setting is not owned by an inference profile' });
    if (isInferenceCredentialField(path) || inferenceCredentialPaths(value, path).length > 0) {
      context.addIssue({ code: 'custom', path: [path], message: 'Connect credentials through the profile credential vault, not configuration' });
    }
  }
});
export const inferenceProfileSchema = z.strictObject({
  version: z.literal(INFERENCE_PROFILE_VERSION),
  id: profileIdSchema,
  name: z.string().trim().min(1).max(160),
  revision: revisionSchema,
  settings: inferenceSettingsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InferenceProfile = z.infer<typeof inferenceProfileSchema>;
export const inferenceAssignmentSchema = z.strictObject({ projectId: z.string().min(1).max(160), profileId: profileIdSchema, revision: revisionSchema });
export type InferenceAssignment = z.infer<typeof inferenceAssignmentSchema>;
export const inferenceStateSchema = z.strictObject({ version: z.literal(INFERENCE_PROFILE_VERSION), revision: revisionSchema, profiles: z.array(inferenceProfileSchema), assignments: z.array(inferenceAssignmentSchema) });
export type InferenceState = z.infer<typeof inferenceStateSchema>;
export const inferenceCreateInputSchema = z.strictObject({ name: z.string().trim().min(1).max(160), sourceProfileId: profileIdSchema.nullable() });
export type InferenceCreateInput = z.infer<typeof inferenceCreateInputSchema>;
export const inferenceUpdateInputSchema = z.strictObject({ profileId: profileIdSchema, expectedRevision: revisionSchema, name: z.string().trim().min(1).max(160), settings: inferenceSettingsSchema });
export type InferenceUpdateInput = z.infer<typeof inferenceUpdateInputSchema>;
export const inferenceDeleteInputSchema = z.strictObject({ profileId: profileIdSchema, expectedRevision: revisionSchema });
export type InferenceDeleteInput = z.infer<typeof inferenceDeleteInputSchema>;
export const inferenceAssignInputSchema = z.strictObject({ projectId: z.string().min(1).max(160), profileId: profileIdSchema, expectedRevision: revisionSchema });
export type InferenceAssignInput = z.infer<typeof inferenceAssignInputSchema>;

/** Private machine/OMP IPC only: never send this bearer through browser state or events. */
export const inferenceExecutionContextSchema = z.strictObject({
  version: z.literal(INFERENCE_PROFILE_VERSION),
  projectId: z.string().min(1).max(160).nullable(),
  assignmentRevision: revisionSchema.nullable(),
  profile: inferenceProfileSchema,
  advanced: runtimeConfigDocumentSchema,
  broker: z.strictObject({ url: z.string().url(), token: z.string().min(1) }),
}).refine(value => (value.projectId === null) === (value.assignmentRevision === null), 'Project identity and assignment revision must be bound together');
export type InferenceExecutionContext = z.infer<typeof inferenceExecutionContextSchema>;

/**
 * Same credential scope: project, profile identity and broker binding. Only a scope
 * change needs a fresh agent worker; revisions of the same profile (roles, models,
 * providers), assignment revisions and shared Advanced settings apply in place.
 */
export function sameInferenceScope(left: InferenceExecutionContext, right: InferenceExecutionContext): boolean {
  return left.projectId === right.projectId && left.profile.id === right.profile.id
    && left.broker.url === right.broker.url && left.broker.token === right.broker.token;
}

export const InferenceStateCodec = wire.serializable((value): value is InferenceState => inferenceStateSchema.safeParse(value).success, { id: 'gitspace/inference-state/v1', jsonSchema: inferenceStateSchema });
export const InferenceCreateInputCodec = wire.serializable((value): value is InferenceCreateInput => inferenceCreateInputSchema.safeParse(value).success, { id: 'gitspace/inference-create/v1', jsonSchema: inferenceCreateInputSchema });
export const InferenceUpdateInputCodec = wire.serializable((value): value is InferenceUpdateInput => inferenceUpdateInputSchema.safeParse(value).success, { id: 'gitspace/inference-update/v1', jsonSchema: inferenceUpdateInputSchema });
export const InferenceDeleteInputCodec = wire.serializable((value): value is InferenceDeleteInput => inferenceDeleteInputSchema.safeParse(value).success, { id: 'gitspace/inference-delete/v1', jsonSchema: inferenceDeleteInputSchema });
export const InferenceAssignInputCodec = wire.serializable((value): value is InferenceAssignInput => inferenceAssignInputSchema.safeParse(value).success, { id: 'gitspace/inference-assign/v1', jsonSchema: inferenceAssignInputSchema });
