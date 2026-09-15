import { z } from 'zod';

export const EnvironmentFailureCodeSchema = z.enum([
  'InvalidBundle', 'InvalidConfiguration', 'NotFound', 'PermissionDenied', 'PreconditionFailed',
  'ApprovalRequired', 'RunConflict', 'RunFenced', 'RecoveryRequired', 'MissingValue', 'MissingSecret',
  'ContentChanged', 'RunnerUnavailable', 'ExecutionFailed', 'Cancelled', 'DeadlineExceeded', 'Interrupted',
]);
export const EnvironmentFailureSchema = z.object({
  code: EnvironmentFailureCodeSchema,
  message: z.string(),
  context: z.record(z.string(), z.string()),
}).strict();
export type EnvironmentFailure = z.infer<typeof EnvironmentFailureSchema>;
export type EnvironmentFailureCode = EnvironmentFailure['code'];

export class EnvironmentError extends Error {
  readonly name = 'EnvironmentError';
  constructor(readonly code: EnvironmentFailureCode, message: string, readonly context: Record<string, string> = {}) {
    super(message);
  }
  toJSON(): EnvironmentFailure { return { code: this.code, message: this.message, context: this.context }; }
}

/** Structural decoding preserves identity across Worker RPC and browser transports. */
export function environmentFailure(error: unknown): EnvironmentFailure | null {
  if (error instanceof EnvironmentError) return error.toJSON();
  const parsed = EnvironmentFailureSchema.safeParse(error);
  return parsed.success ? parsed.data : null;
}
