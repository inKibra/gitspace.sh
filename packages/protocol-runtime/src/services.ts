import { z } from 'zod';
import { DaemonStateSchema } from '@gitspace/supervisor/protocol';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema } from './base.js';

export const RuntimeServiceOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  z.object({ op: z.enum(['start', 'stop', 'restart', 'logs']), name: z.string().min(1), source: z.enum(['declared', 'process']).default('declared') }),
]);
/** One `http` port: `url` is the workspace URL pointing at this machine's port (null when it points elsewhere or nowhere); `servedBy` names the machine a declared service's own workspace URL points at instead. */
export const RuntimeServicePortSchema = z.object({ name: z.string(), url: z.url().nullable(), machineUrl: z.url().nullable(), servedBy: z.string().nullable() });
/** `url` and `machineUrl` are the first `http` port's. */
export const RuntimeServiceSchema = z.object({ name: z.string(), source: z.enum(['declared', 'process']), terminalName: z.string(), state: z.union([DaemonStateSchema, z.literal('stopped')]), url: z.url().nullable(), machineUrl: z.url().nullable(), ports: z.array(RuntimeServicePortSchema) });
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
