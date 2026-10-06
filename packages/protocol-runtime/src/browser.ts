import { z } from 'zod';
import { BrowserOriginPatternSchema, browserOriginMatches } from '@gitspace/protocol-environment';
import { RuntimeDispatchSelectionSchema } from './scheduling.js';

const id = z.string().min(1).max(256);
const source = z.enum(['relay', 'headless']).default('headless');
const selection = { source, on: RuntimeDispatchSelectionSchema.shape.on };
const tab = { ...selection, targetId: id };
export const RuntimeBrowserArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), ...selection, targetId: id.optional(), url: z.string().max(8192).optional() }),
  z.strictObject({ action: z.literal('tabs'), ...selection }),
  z.strictObject({ action: z.literal('navigate'), ...tab, url: z.string().max(8192) }),
  z.strictObject({ action: z.literal('observe'), ...tab, screenshot: z.boolean().default(false), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) }),
  z.strictObject({ action: z.literal('act'), ...tab, ref: id, operation: z.enum(['click', 'fill', 'press']), value: z.string().max(16384).optional() }),
  z.strictObject({ action: z.literal('evaluate'), ...tab, expression: z.string().min(1).max(32768) }),
  z.strictObject({ action: z.literal('screenshot'), ...tab }),
  z.strictObject({ action: z.literal('close'), ...tab }),
]);
export type RuntimeBrowserArguments = z.infer<typeof RuntimeBrowserArgumentsSchema>;
const executionScope = { projectId: id, workspaceId: id, machineId: id, attachmentId: id, generation: z.number().int().nonnegative() };
export const RuntimeBrowserGrantSchema = z.strictObject({ ...executionScope, groupId: z.string().uuid(), groupName: id, source: z.enum(['relay', 'headless']), origins: z.array(BrowserOriginPatternSchema), expiresAt: z.iso.datetime() });
export type RuntimeBrowserGrant = z.infer<typeof RuntimeBrowserGrantSchema>;
export const RuntimeBrowserPreparationSchema = RuntimeBrowserGrantSchema.extend({ id, action: z.enum(['open', 'tabs', 'navigate', 'observe', 'act', 'evaluate', 'screenshot', 'close']), requiresApproval: z.boolean() });
export type RuntimeBrowserPreparation = z.infer<typeof RuntimeBrowserPreparationSchema>;
export const RuntimeBrowserApprovalCardSchema = RuntimeBrowserPreparationSchema;
export type RuntimeBrowserApprovalCard = z.infer<typeof RuntimeBrowserApprovalCardSchema>;
export const RuntimeBrowserManagementSchema = z.strictObject({ action: z.enum(['status', 'revoke', 'reconcile', 'discard', 'artifact']), groupId: z.string().uuid().optional(), recordId: id.optional(), artifactId: id.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional() });
export type RuntimeBrowserManagement = z.infer<typeof RuntimeBrowserManagementSchema>;
export const RuntimeBrowserAuthorityCertificateBodySchema = z.strictObject({
  accountId: id, projectId: id, workspaceId: id,
  publicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
});
export type RuntimeBrowserAuthorityCertificateBody = z.infer<typeof RuntimeBrowserAuthorityCertificateBodySchema>;
export const RuntimeBrowserAuthorityCertificateSchema = z.strictObject({ body: RuntimeBrowserAuthorityCertificateBodySchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128) });
export type RuntimeBrowserAuthorityCertificate = z.infer<typeof RuntimeBrowserAuthorityCertificateSchema>;
export const RuntimeBrowserSignedGrantSchema = z.strictObject({ body: RuntimeBrowserGrantSchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128), authority: RuntimeBrowserAuthorityCertificateSchema });
export type RuntimeBrowserSignedGrant = z.infer<typeof RuntimeBrowserSignedGrantSchema>;
export const RuntimeBrowserAuthorizationBodySchema = z.strictObject({
  scope: z.strictObject({ ...executionScope, conversationId: id, taskId: id, requestId: id, attemptId: id }),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  dispatch: z.strictObject({ version: z.literal(1), tool: z.enum(['browser', 'browser_control']), deadlineAt: z.iso.datetime(), replay: z.enum(['safe', 'unsafe']), parentAttemptId: id.optional() }),
  command: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('prepare'), args: RuntimeBrowserArgumentsSchema, groupId: z.string().uuid() }),
    z.strictObject({ type: z.literal('execute'), args: RuntimeBrowserArgumentsSchema, grant: RuntimeBrowserSignedGrantSchema }),
    z.strictObject({ type: z.literal('manage'), ...RuntimeBrowserManagementSchema.shape }),
    z.strictObject({ type: z.literal('tabs'), groupId: z.string().uuid() }),
  ]),
});
export type RuntimeBrowserAuthorizationBody = z.infer<typeof RuntimeBrowserAuthorizationBodySchema>;
export const RuntimeBrowserAuthorizationSchema = z.strictObject({ body: RuntimeBrowserAuthorizationBodySchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128), authority: RuntimeBrowserAuthorityCertificateSchema });
export type RuntimeBrowserAuthorization = z.infer<typeof RuntimeBrowserAuthorizationSchema>;
export const RuntimeBrowserPublicKeySchema = z.strictObject({ algorithm: z.literal('Ed25519'), publicKey: z.string().max(128) });
export const RuntimeBrowserTrustSchema = RuntimeBrowserPublicKeySchema.extend({ accountId: id });
export type RuntimeBrowserTrust = z.infer<typeof RuntimeBrowserTrustSchema>;
export const RuntimeBrowserArtifactSchema = z.strictObject({ id, url: z.string().max(8192), mediaType: z.string().max(128), bytes: z.number().int().nonnegative(), expiresAt: z.iso.datetime() });
export const RuntimeBrowserArtifactPageSchema = z.strictObject({ artifact: RuntimeBrowserArtifactSchema, offset: z.number().int().nonnegative(), data: z.string().max(90000), nextOffset: z.number().int().nonnegative().nullable() });
export type RuntimeBrowserArtifact = z.infer<typeof RuntimeBrowserArtifactSchema>;
export type RuntimeBrowserArtifactPage = z.infer<typeof RuntimeBrowserArtifactPageSchema>;
export const RuntimeBrowserStatusSchema = z.strictObject({
  groups: z.array(RuntimeBrowserGrantSchema.extend({ state: z.enum(['active', 'revoked', 'expired', 'fenced', 'closed']), reason: z.string().max(1024).optional() })).max(200),
  records: z.array(z.strictObject({ id, groupId: z.string().uuid().optional(), projectId: id, workspaceId: id, state: z.enum(['uncertain', 'fenced', 'stopped']), reason: z.string().max(1024), expiresAt: z.iso.datetime().optional(), actions: z.array(z.enum(['reconcile', 'discard'])).max(2) })).max(200),
});
export type RuntimeBrowserStatus = z.infer<typeof RuntimeBrowserStatusSchema>;
export function browserNeedsExplicitApproval(args: RuntimeBrowserArguments): boolean { return args.action === 'open' && args.source === 'relay'; }

/** Domain-separated canonical JSON: signatures never accept a key supplied by the command. */
export function canonicalBrowserAuthorization(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    return `{${Object.entries(input).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`;
  };
  return `gitspace.browser.authorization.v1\n${encode(value)}`;
}
export function browserBase64(bytes: Uint8Array): string { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')); }
export function browserUnbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
export function canonicalBrowserAuthorityCertificate(value: unknown): string {
  return canonicalBrowserAuthorization(value).replace('gitspace.browser.authorization.v1\n', 'gitspace.browser.authority.v1\n');
}
export async function signRuntimeBrowserAuthorityCertificate(body: RuntimeBrowserAuthorityCertificateBody, privateKey: CryptoKey): Promise<RuntimeBrowserAuthorityCertificate> {
  const parsed = RuntimeBrowserAuthorityCertificateBodySchema.parse(body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserAuthorityCertificate(parsed)));
  return { body: parsed, signature: browserBase64(new Uint8Array(signature)) };
}
export function canonicalBrowserGrant(value: unknown): string {
  return canonicalBrowserAuthorization(value).replace('gitspace.browser.authorization.v1\n', 'gitspace.browser.grant.v1\n');
}
export async function signRuntimeBrowserGrant(body: RuntimeBrowserGrant, privateKey: CryptoKey, authority: RuntimeBrowserAuthorityCertificate): Promise<RuntimeBrowserSignedGrant> {
  const parsed = RuntimeBrowserGrantSchema.parse(body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserGrant(parsed)));
  return { body: parsed, signature: browserBase64(new Uint8Array(signature)), authority: RuntimeBrowserAuthorityCertificateSchema.parse(authority) };
}
export async function verifyRuntimeBrowserGrant(grant: unknown, trustedKey: CryptoKey, now = Date.now()): Promise<RuntimeBrowserGrant> {
  const { body, signature, authority } = RuntimeBrowserSignedGrantSchema.parse(grant);
  if (!await crypto.subtle.verify('Ed25519', trustedKey, browserUnbase64(authority.signature), new TextEncoder().encode(canonicalBrowserAuthorityCertificate(authority.body)))) throw new Error('Invalid browser authority signature');
  if (authority.body.projectId !== body.projectId || authority.body.workspaceId !== body.workspaceId) throw new Error('Browser authority scope mismatch');
  if (Date.parse(authority.body.issuedAt) - now > 120_000) throw new Error('Browser clock skew: cloud authority exceeds maximum 120 seconds');
  if (Date.parse(authority.body.expiresAt) <= now || Date.parse(authority.body.expiresAt) <= Date.parse(authority.body.issuedAt) || Date.parse(body.expiresAt) > Date.parse(authority.body.expiresAt)) throw new Error('Browser authority expired or not yet valid');
  const workspaceKey = await crypto.subtle.importKey('raw', browserUnbase64(authority.body.publicKey), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', workspaceKey, browserUnbase64(signature), new TextEncoder().encode(canonicalBrowserGrant(body)))) throw new Error('Invalid browser grant signature');
  if (Date.parse(body.expiresAt) <= now) throw new Error('Browser grant expired');
  return body;
}
export async function signRuntimeBrowserAuthorization(body: RuntimeBrowserAuthorizationBody, privateKey: CryptoKey, authority: RuntimeBrowserAuthorityCertificate): Promise<RuntimeBrowserAuthorization> {
  const parsed = RuntimeBrowserAuthorizationBodySchema.parse(body);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonicalBrowserAuthorization(parsed)));
  return { body: parsed, signature: browserBase64(new Uint8Array(signature)), authority: RuntimeBrowserAuthorityCertificateSchema.parse(authority) };
}
export async function verifyRuntimeBrowserAuthorization(authorization: unknown, dispatch: { projectId: string; workspaceId: string; conversationId: string; machineId: string; attachmentId: string; generation: number; taskId: string; requestId: string; attemptId: string; version: number; tool: string; args: unknown; deadlineAt: string; replay: string; parentAttemptId?: string }, trustedKey: CryptoKey, now = Date.now()): Promise<RuntimeBrowserAuthorizationBody> {
  const { body, signature, authority } = RuntimeBrowserAuthorizationSchema.parse(authorization);
  const maxIssuedAtSkewMs = 120_000;
  if (!await crypto.subtle.verify('Ed25519', trustedKey, browserUnbase64(authority.signature), new TextEncoder().encode(canonicalBrowserAuthorityCertificate(authority.body)))) throw new Error('Invalid browser authority signature');
  if (authority.body.projectId !== body.scope.projectId || authority.body.workspaceId !== body.scope.workspaceId) throw new Error('Browser authority scope mismatch');
  if (Date.parse(authority.body.issuedAt) - now > maxIssuedAtSkewMs) throw new Error(`Browser clock skew: cloud authority is ${Math.ceil((Date.parse(authority.body.issuedAt) - now) / 1000)} seconds ahead (maximum 120 seconds). Synchronize the machine and browser clocks.`);
  if (Date.parse(authority.body.expiresAt) <= now || Date.parse(authority.body.expiresAt) <= Date.parse(authority.body.issuedAt) || Date.parse(body.expiresAt) > Date.parse(authority.body.expiresAt)) throw new Error('Browser authority expired or not yet valid');
  const workspaceKey = await crypto.subtle.importKey('raw', browserUnbase64(authority.body.publicKey), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', workspaceKey, browserUnbase64(signature), new TextEncoder().encode(canonicalBrowserAuthorization(body)))) throw new Error('Invalid browser authorization signature');
  if (Date.parse(body.issuedAt) - now > maxIssuedAtSkewMs) throw new Error(`Browser clock skew: cloud authorization is ${Math.ceil((Date.parse(body.issuedAt) - now) / 1000)} seconds ahead (maximum 120 seconds). Synchronize the machine and browser clocks.`);
  if (Date.parse(body.expiresAt) <= now || Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)) throw new Error('Browser authorization expired or not yet valid');
  for (const key of ['projectId', 'workspaceId', 'conversationId', 'machineId', 'attachmentId', 'generation', 'taskId', 'requestId', 'attemptId'] as const) if (dispatch[key] !== body.scope[key]) throw new Error('Browser authorization scope mismatch');
  for (const key of ['version', 'tool', 'deadlineAt', 'replay', 'parentAttemptId'] as const) if (body.dispatch[key] !== dispatch[key]) throw new Error('Browser dispatch mismatch');
  const { type: commandType, ...commandFields } = body.command;
  const expected = commandType === 'manage' ? RuntimeBrowserManagementSchema.parse(commandFields) : commandType === 'tabs' ? commandFields : 'args' in body.command ? body.command.args : null;
  if (canonicalBrowserAuthorization(expected) !== canonicalBrowserAuthorization(dispatch.args)) throw new Error('Browser authorization arguments mismatch');
  if (body.dispatch.tool !== (commandType === 'execute' ? 'browser' : 'browser_control')) throw new Error('Browser command tool mismatch');
  if (body.command.type === 'execute') {
    const grant = await verifyRuntimeBrowserGrant(body.command.grant, trustedKey, now);
    if (body.command.grant.authority.body.accountId !== authority.body.accountId) throw new Error('Browser grant account mismatch');
    for (const key of ['projectId', 'workspaceId', 'machineId', 'attachmentId', 'generation'] as const) if (grant[key] !== body.scope[key]) throw new Error('Browser grant scope mismatch');
    if (Date.parse(body.expiresAt) > Date.parse(grant.expiresAt)) throw new Error('Browser grant expired');
    const args = body.command.args;
    if (args.source !== grant.source) throw new Error('Browser grant source mismatch');
    if (grant.source === 'relay' && (args.action === 'navigate' || args.action === 'open') && args.url && args.url !== 'about:blank') {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol) || !grant.origins.some(pattern => browserOriginMatches(pattern, url.hostname))) throw new Error('Browser origin outside approved patterns');
    }
  }
  return body;
}
