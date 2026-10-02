import { z } from 'zod';
import { deviceCapabilitySchema, deviceScopeSchema, signedDeviceInviteSchema } from './device-grant.js';

/** Browser-only credential setup, deliberately outside the MCP/RPC tool catalog. */
export const mcpAccessStatusRequestSchema = z.object({ userId: z.string().min(1) }).strict();
export const mcpAccessChangeRequestSchema = mcpAccessStatusRequestSchema.extend({ expectedRevision: z.number().int().nonnegative() }).strict();
export const mcpAccessEnableRequestSchema = mcpAccessChangeRequestSchema.extend({ invite: signedDeviceInviteSchema }).strict();
export const mcpAccessViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  active: z.boolean(),
  endpoint: z.string().url(),
  deviceId: z.string().nullable(),
  scope: deviceScopeSchema.nullable(),
  capabilities: z.array(deviceCapabilitySchema),
  expiresAt: z.number().nullable(),
  updatedAt: z.string().nullable(),
}).strict();
export const mcpAccessResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), value: mcpAccessViewSchema.extend({ token: z.string().optional() }).strict() }).strict(),
  z.object({ status: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
]);
export type McpAccessView = z.infer<typeof mcpAccessViewSchema>;
export type McpAccessResult = z.infer<typeof mcpAccessResultSchema>;
export type McpAccessOperation = 'status' | 'enable' | 'rotate' | 'disable';
