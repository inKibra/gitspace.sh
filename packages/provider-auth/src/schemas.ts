import { z } from 'zod';

export const workerOAuthProviderSchema = z.enum(['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity', 'cursor']);
export type WorkerOAuthProvider = z.infer<typeof workerOAuthProviderSchema>;
export const oauthProviderNames: Record<WorkerOAuthProvider, string> = {
  anthropic: 'Anthropic (Claude Pro/Max)',
  'openai-codex': 'OpenAI Codex (ChatGPT)',
  'google-gemini-cli': 'Google Cloud Code Assist (Gemini CLI)',
  'google-antigravity': 'Google Antigravity',
  cursor: 'Cursor',
};
export const storedOAuthCredentialSchema = z.object({
  provider: workerOAuthProviderSchema, refresh: z.string().min(1), access: z.string().min(1), expires: z.number().finite(),
  accountId: z.string().optional(), email: z.string().optional(), orgId: z.string().optional(), projectId: z.string().optional(),
});
export type StoredOAuthCredential = z.infer<typeof storedOAuthCredentialSchema>;
const base = { provider: workerOAuthProviderSchema, expiresAt: z.iso.datetime() };
const pending = { ...base, authorizationUrl: z.url(), nextPollAt: z.iso.datetime() };
/** Secret server-side state. Encrypt at rest; never return this through management RPC. */
export const loginStateSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('code'), provider: z.enum(['anthropic', 'google-gemini-cli', 'google-antigravity']), authorizationUrl: z.url(), verifier: z.string().min(43), csrf: z.string().min(32), redirectUri: z.url(), projectId: z.string().optional() }),
  z.object({ ...pending, kind: z.literal('device'), provider: z.literal('openai-codex'), deviceAuthId: z.string().min(1), userCode: z.string().min(1), intervalMs: z.number().positive() }),
  z.object({ ...pending, kind: z.literal('cursor'), provider: z.literal('cursor'), verifier: z.string().min(43), uuid: z.string().uuid(), intervalMs: z.number().positive() }),
  z.object({ ...base, kind: z.literal('project'), credential: storedOAuthCredentialSchema, operation: z.string().min(1), nextPollAt: z.iso.datetime() }),
  z.object({ ...base, kind: z.literal('project-input'), credential: storedOAuthCredentialSchema }),
  z.object({ ...base, kind: z.literal('complete') }),
  z.object({ ...base, kind: z.literal('cancelled') }),
]);
export type LoginState = z.infer<typeof loginStateSchema>;
export const loginViewSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('code'), authorizationUrl: z.url(), prompt: z.string() }),
  z.object({ ...base, kind: z.literal('device'), authorizationUrl: z.url(), userCode: z.string(), nextPollAt: z.iso.datetime() }),
  z.object({ ...base, kind: z.literal('poll'), authorizationUrl: z.url().optional(), nextPollAt: z.iso.datetime() }),
  z.object({ ...base, kind: z.literal('project-input'), prompt: z.string() }),
  z.object({ ...base, kind: z.literal('complete') }),
  z.object({ ...base, kind: z.literal('cancelled') }),
]);
export type LoginView = z.infer<typeof loginViewSchema>;
export const beginLoginInputSchema = z.object({ provider: workerOAuthProviderSchema, projectId: z.string().min(1).optional() });
export const loginResponseSchema = z.object({ code: z.string().min(1).max(16_384) });
export const loginTransitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), state: loginStateSchema, view: loginViewSchema }),
  z.object({ kind: z.literal('complete'), state: loginStateSchema, view: loginViewSchema, credential: storedOAuthCredentialSchema }),
]);
export type LoginTransition = z.infer<typeof loginTransitionSchema>;
