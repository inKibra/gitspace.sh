import { z } from 'zod';
import { deviceCapabilitySchema, deviceScopeSchema, signedDeviceInviteSchema } from './device-grant.js';

/** Browser-only credential setup, deliberately outside the MCP/RPC tool catalog. An account has any number of MCP
 * connections, each its own client device with its own bearer token, scope and capabilities. */
export const mcpAccessStatusRequestSchema = z.object({ userId: z.string().min(1) }).strict();
const mcpAccessChangeSchema = mcpAccessStatusRequestSchema.extend({ expectedRevision: z.number().int().nonnegative() }).strict();
export const mcpAccessCreateRequestSchema = mcpAccessChangeSchema.extend({ label: z.string().trim().min(1).max(80), invite: signedDeviceInviteSchema }).strict();
/** Rotate or disable one connection. */
export const mcpAccessConnectionRequestSchema = mcpAccessChangeSchema.extend({ connectionId: z.string().min(1) }).strict();
export const mcpConnectionViewSchema = z.object({
  connectionId: z.string(),
  label: z.string(),
  /** Its client grant is current: not revoked, expired, or orphaned by a revoked issuer. */
  active: z.boolean(),
  deviceId: z.string(),
  scope: deviceScopeSchema.nullable(),
  capabilities: z.array(deviceCapabilitySchema),
  expiresAt: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export const mcpAccessViewSchema = z.object({
  /** Advances with every change to any connection. */
  revision: z.number().int().nonnegative(),
  endpoint: z.string().url(),
  connections: z.array(mcpConnectionViewSchema),
}).strict();
export const mcpAccessResultSchema = z.discriminatedUnion('status', [
  /** `token` and its `connectionId` only right after a create or rotate: the bearer is shown once. */
  z.object({ status: z.literal('ok'), value: mcpAccessViewSchema.extend({ token: z.string().optional(), connectionId: z.string().optional() }).strict() }).strict(),
  z.object({ status: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
]);
export type McpConnectionView = z.infer<typeof mcpConnectionViewSchema>;
export type McpAccessView = z.infer<typeof mcpAccessViewSchema>;
export type McpAccessResult = z.infer<typeof mcpAccessResultSchema>;
export type McpAccessOperation = 'status' | 'create' | 'rotate' | 'disable';
