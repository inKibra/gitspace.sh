import { z } from 'zod';
import { deviceCapabilitySchema, signedDeviceInviteSchema } from './device-grant.js';

/**
 * OAuth for the account's `/mcp` (docs/GITSPACE-MCP-CAPABILITY-MATRIX.md, "OAuth"): the consent page and its API.
 * OAuth scope strings are capability ids, one to one.
 */

/** The consent page on the account origin; `?request=<authorization request id>`. */
export const MCP_OAUTH_CONSENT_PAGE = '/oauth/consent';
/** `POST <path>/view` reads an authorization request; `POST <path>/decide` allows or denies it. Signed by a browser. */
export const MCP_OAUTH_CONSENT_API = '/v1/mcp-oauth/consent';
/** An OAuth access token for `/mcp`: `gsoa_` and 256 random bits, base64url. Refresh tokens are `gsor_…`, authorization
 * codes `gsoc_…`, dynamic client secrets `gscs_…`; GitSpace keeps only their SHA-256. */
export const MCP_OAUTH_ACCESS_TOKEN = /^gsoa_[A-Za-z0-9_-]{43}$/u;

/** Permissions an MCP client is granted only after a passkey step-up: `mcp-oauth.grant` on the consent page (target:
 * the request id), `mcp-token.create` for a token connection made in Settings (target: its invitation id). */
export const MCP_STEP_UP_CAPABILITIES: Readonly<Record<string, true>> = {
  'operator.decide': true, 'account.admin': true, 'lifecycle.control': true, 'devices.manage': true, 'deployment.control': true,
};

/** Who asks, as the authorization server resolved it: from the client's metadata document (its `client_id` is that
 * document's https URL), or from a dynamic registration, which nobody vouches for. */
export const mcpOAuthClientViewSchema = z.object({
  clientId: z.string().min(1).max(2_048),
  name: z.string().min(1).max(160),
  logoUri: z.string().url().max(2_048).nullable(),
  clientUri: z.string().url().max(2_048).nullable(),
  /** The metadata document's host, or for a dynamic registration the host of its `client_uri`, if any. */
  host: z.string().max(253).nullable(),
  registration: z.enum(['metadata-document', 'dynamic']),
}).strict();
export type McpOAuthClientView = z.infer<typeof mcpOAuthClientViewSchema>;

export const mcpOAuthConsentViewSchema = z.object({
  requestId: z.string().min(1),
  client: mcpOAuthClientViewSchema,
  redirectUri: z.string().url(),
  redirectHost: z.string(),
  /** The redirect goes to this computer (`localhost`, `127.0.0.1`, `[::1]`): any program on it could receive the code. */
  loopback: z.boolean(),
  /** Its `scope`, as capabilities; scopes GitSpace does not know are left out. */
  requestedCapabilities: z.array(deviceCapabilitySchema),
  expiresAt: z.number().int(),
}).strict();
export type McpOAuthConsentView = z.infer<typeof mcpOAuthConsentViewSchema>;

export const mcpOAuthConsentViewRequestSchema = z.object({ userId: z.string().min(1), requestId: z.string().min(1).max(64) }).strict();
/** Allow carries the client invitation this browser signed: the permissions, scope and lifetime the person chose. */
export const mcpOAuthConsentDecisionSchema = z.discriminatedUnion('decision', [
  mcpOAuthConsentViewRequestSchema.extend({ decision: z.literal('allow'), invite: signedDeviceInviteSchema }).strict(),
  mcpOAuthConsentViewRequestSchema.extend({ decision: z.literal('deny') }).strict(),
]);
export type McpOAuthConsentDecision = z.infer<typeof mcpOAuthConsentDecisionSchema>;

const errorSchema = z.object({ status: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export const mcpOAuthConsentViewResultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), value: mcpOAuthConsentViewSchema }).strict(), errorSchema]);
/** Where the browser goes next: the client's redirect URI with the code (or the denial), `state` and `iss`. */
export const mcpOAuthConsentDecisionResultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), value: z.object({ redirectUrl: z.string().url() }).strict() }).strict(), errorSchema]);
export type McpOAuthConsentViewResult = z.infer<typeof mcpOAuthConsentViewResultSchema>;
export type McpOAuthConsentDecisionResult = z.infer<typeof mcpOAuthConsentDecisionResultSchema>;
