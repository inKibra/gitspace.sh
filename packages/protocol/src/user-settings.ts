import { z } from 'zod';

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

export const userSettingsSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  onboardingComplete: z.boolean(),
  profile: userProfileSettingsSchema,
  git: userGitSettingsSchema,
  defaults: userDefaultSettingsSchema,
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
});
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;

export const ompConfigDocumentSchema = z.object({
  generation: z.number().int().nonnegative(),
  content: z.string().max(262_144),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(160),
});
export type OmpConfigDocument = z.infer<typeof ompConfigDocumentSchema>;

export const ompConfigUpdateSchema = z.object({
  expectedGeneration: z.number().int().nonnegative(),
  content: z.string().max(262_144),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export type OmpConfigUpdate = z.infer<typeof ompConfigUpdateSchema>;
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


export const ompSettingValueSchema = z.json();
export type OmpSettingValue = z.infer<typeof ompSettingValueSchema>;

export const ompSettingSchemaItemSchema = z.object({
  path: z.string().min(1),
  tab: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(['boolean', 'enum', 'number', 'string', 'array', 'record', 'other']),
  value: ompSettingValueSchema,
  options: z.array(z.string()).optional(),
  credential: z.boolean(),
});
export type OmpSettingSchemaItem = z.infer<typeof ompSettingSchemaItemSchema>;
