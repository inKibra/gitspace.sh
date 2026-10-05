import { z } from 'zod';
import { storedOAuthCredentialSchema } from './schemas';
const apiKeySchema = z.strictObject({ type: z.literal('api_key'), key: z.string().min(1), source: z.literal('login').optional() });
const oauthSchema = storedOAuthCredentialSchema.omit({ provider: true }).extend({ type: z.literal('oauth'), apiEndpoint: z.string().optional(), enterpriseUrl: z.string().optional(), orgName: z.string().optional(), authorizedAt: z.number().optional() });
export const storedVaultCredentialSchema = z.union([
  apiKeySchema.extend({ provider: z.string().min(1) }),
  storedOAuthCredentialSchema.extend({ type: z.literal('oauth').optional(), apiEndpoint: z.string().optional(), enterpriseUrl: z.string().optional(), orgName: z.string().optional(), authorizedAt: z.number().optional() }),
]);
export type StoredVaultCredential = z.infer<typeof storedVaultCredentialSchema>;
export const credentialEntrySchema = z.object({ id: z.number().int().positive(), provider: z.string(), identityKey: z.string().nullable(), credential: z.discriminatedUnion('type', [apiKeySchema, oauthSchema]) });
export const credentialRefreshResponseSchema = z.object({ entry: credentialEntrySchema });
export type CredentialRefreshResponse = z.infer<typeof credentialRefreshResponseSchema>;
export const credentialUploadResponseSchema = z.object({ entries: z.array(credentialEntrySchema) });
export type CredentialUploadResponse = z.infer<typeof credentialUploadResponseSchema>;
export const snapshotResponseSchema = z.object({ generation: z.number(), generatedAt: z.number(), serverNowMs: z.number(), refresher: z.object({ enabled: z.boolean(), intervalMs: z.number(), skewMs: z.number(), nextSweepInMs: z.number().nullable() }), credentials: z.array(credentialEntrySchema.extend({ rotatesInMs: z.number().nullable() })) });
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;
