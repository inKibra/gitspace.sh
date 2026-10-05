import { z } from 'zod';

export const DAEMON_BROKER_WORKER_ARG = '--gitspace-supervisor';
export const TERMINAL_OUTPUT_WORKER_ARG = '--gitspace-terminal-output';
export const SupervisorErrorCodeSchema = z.enum(['DETACHED_REQUIRES_PERSISTENCE', 'SUPERVISOR_FAILURE']);
export class SupervisorRequestError extends Error {
  constructor(readonly code: z.infer<typeof SupervisorErrorCodeSchema>, message: string) {
    super(message);
    this.name = 'SupervisorRequestError';
  }
}
export const DaemonStateSchema = z.enum(['starting', 'running', 'ready', 'restarting', 'stopping', 'exited', 'failed']);
export type DaemonState = z.infer<typeof DaemonStateSchema>;
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/);
const timeout = z.number().int().positive().max(2_147_483_647);
export const DaemonSpecSchema = z.object({
  name, application: z.string().min(1), args: z.array(z.string()), envNames: z.array(z.string()), cwd: z.string().min(1),
  inheritEnv: z.boolean().optional(),
  pty: z.boolean(), restart: z.enum(['no', 'on-failure', 'always']), persist: z.boolean(), detached: z.boolean(),
  ready: z.object({ log: z.string().optional(), port: z.number().int().min(1).max(65535).optional(), host: z.string().optional(), timeoutMs: timeout.optional() }).optional(),
});
export type DaemonSpec = z.infer<typeof DaemonSpecSchema>;
/** Environment values exist only in a caller's transient start request. */
export const DaemonStartSpecSchema = DaemonSpecSchema.omit({ envNames: true }).extend({ env: z.record(z.string(), z.string()) });
export type DaemonStartSpec = z.infer<typeof DaemonStartSpecSchema>;
export const ProcessIdentitySchema = z.object({ pid: z.number().int().positive(), boot: z.string(), started: z.string() });
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;
export const DaemonSnapshotSchema = z.object({
  id: z.string(), name, state: DaemonStateSchema, owner: z.string().optional(), createdAt: z.string(),
  pid: z.number().int().positive().nullable(), exitCode: z.number().int().nullable(),
  failure: z.string().optional(), restartCount: z.number().int().nonnegative(),
});
export type DaemonSnapshot = z.infer<typeof DaemonSnapshotSchema>;
export const DaemonRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), spec: DaemonStartSpecSchema, owner: z.string().optional() }),
  z.object({ op: z.literal('list') }),
  z.object({ op: z.literal('describe'), name }),
  z.object({ op: z.literal('stop'), name, timeoutMs: timeout.optional() }),
  z.object({ op: z.literal('restart'), name, timeoutMs: timeout.optional() }),
  z.object({ op: z.literal('send'), name, data: z.string().optional(), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']).optional(), cols: z.number().int().positive().optional(), rows: z.number().int().positive().optional() }),
  z.object({ op: z.literal('wait'), name, for: z.enum(['ready', 'exit']).optional(), pattern: z.string().optional(), timeoutMs: timeout.optional() }),
  z.object({ op: z.literal('logs'), name, lines: z.number().int().positive().max(10000).optional(), head: z.boolean().optional(), follow: z.boolean().optional(), cursor: z.number().int().nonnegative().optional(), renderTerminalRows: z.boolean().optional(), timeoutMs: timeout.optional() }),
  z.object({ op: z.literal('shutdown') }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;
export const DaemonResponseSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), daemon: DaemonSnapshotSchema }),
  z.object({ op: z.literal('list'), daemons: z.array(DaemonSnapshotSchema) }),
  z.object({ op: z.literal('describe'), daemon: DaemonSnapshotSchema, spec: DaemonSpecSchema }),
  z.object({ op: z.literal('stop'), daemon: DaemonSnapshotSchema }),
  z.object({ op: z.literal('restart'), daemon: DaemonSnapshotSchema }),
  z.object({ op: z.literal('send'), daemon: DaemonSnapshotSchema }),
  z.object({ op: z.literal('wait'), daemon: DaemonSnapshotSchema, timedOut: z.boolean() }),
  z.object({ op: z.literal('logs'), state: DaemonStateSchema, text: z.string(), terminalText: z.string().optional(), cursor: z.number().int().nonnegative(), resync: z.enum(['cursor-expired', 'cursor-ahead']).optional() }),
  z.object({ op: z.literal('shutdown') }),
]);
export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;
export const BrokerReplySchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: DaemonResponseSchema }), z.object({ ok: z.literal(false), code: SupervisorErrorCodeSchema, error: z.string() })]);
export const StoredDaemonSchema = z.object({ daemon: DaemonSnapshotSchema, spec: DaemonSpecSchema, identity: ProcessIdentitySchema.nullable(), claimBoot: z.string().min(1).nullable().optional(), cursor: z.number().int().nonnegative(), base: z.number().int().nonnegative() });
