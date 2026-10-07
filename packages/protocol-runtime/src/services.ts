import { z } from 'zod';
import { DaemonStateSchema } from '@gitspace/supervisor/protocol';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema } from './base.js';

export const RuntimeServiceOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  z.object({ op: z.enum(['start', 'stop', 'restart', 'logs']), name: z.string().min(1), source: z.enum(['declared', 'process']).default('declared') }),
]);
export const RuntimeServiceSchema = z.object({ name: z.string(), source: z.enum(['declared', 'process']), terminalName: z.string(), state: z.union([DaemonStateSchema, z.literal('stopped')]), url: z.url().nullable() });
export const RuntimeServiceTargetSchema = z.object({ machineId: RuntimeMachineIdSchema, attachmentId: z.string().min(1), generation: z.number().int().nonnegative() });
export const RuntimeServiceCommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  RuntimeServiceTargetSchema.extend({ op: z.enum(['start', 'stop', 'restart', 'logs']), name: z.string().min(1), source: z.enum(['declared', 'process']) }),
]);
export const RuntimeServiceInputSchema = RuntimeIdentitySchema.extend({ command: RuntimeServiceCommandSchema });
export const RuntimeServiceLogSchema = z.object({ name: z.string(), text: z.string() });
export const RuntimeServiceMachineSchema = RuntimeServiceTargetSchema.extend({ available: z.boolean(), error: z.string().nullable(), services: z.array(RuntimeServiceSchema) });
export const RuntimeServiceResultSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), machines: z.array(RuntimeServiceMachineSchema) }),
  z.object({ op: z.literal('logs'), target: RuntimeServiceTargetSchema, log: RuntimeServiceLogSchema }),
  z.object({ op: z.enum(['start', 'stop', 'restart']), target: RuntimeServiceTargetSchema, service: RuntimeServiceSchema }),
]);
export type RuntimeService = z.infer<typeof RuntimeServiceSchema>;
export type RuntimeServiceOperation = z.infer<typeof RuntimeServiceOperationSchema>;
export type RuntimeServiceCommand = z.infer<typeof RuntimeServiceCommandSchema>;
export type RuntimeServiceInput = z.infer<typeof RuntimeServiceInputSchema>;
export type RuntimeServiceResult = z.infer<typeof RuntimeServiceResultSchema>;
