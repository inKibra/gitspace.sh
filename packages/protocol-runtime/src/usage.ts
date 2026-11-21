import { z } from 'zod';
export const UsageTotalsSchema = z.object({ requests: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(), reasoningTokens: z.number(), costUsd: z.number() });
export const SessionUsageReportSchema = z.object({
  sessionId: z.string(), totals: UsageTotalsSchema, totalsDeep: UsageTotalsSchema, childSessions: z.number(),
  byModel: z.array(z.object({ provider: z.string(), model: z.string(), totals: UsageTotalsSchema })),
  byRole: z.array(z.object({ role: z.string().nullable(), models: z.array(z.string()), totals: UsageTotalsSchema })),
  byAgent: z.array(z.object({ agentId: z.string(), agent: z.string(), selection: z.enum(['role', 'pinned', 'inherited', 'unknown']), role: z.string().nullable(), provider: z.string(), definitionSource: z.string().nullable(), definitionPath: z.string().nullable(), definitionRevision: z.string().nullable(), model: z.string(), spawns: z.number(), firstAt: z.string().nullable(), lastAt: z.string().nullable(), totals: UsageTotalsSchema })),
  byCompletion: z.array(z.object({ kind: z.string(), role: z.string().nullable(), provider: z.string(), model: z.string(), totals: UsageTotalsSchema })), warnings: z.array(z.string()),
});
export type SessionUsageReport = z.infer<typeof SessionUsageReportSchema>;
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;
const count = z.number().int().nonnegative();
/** What one use of a Service spent, for the account's usage (`service_usage`, by UTC day, profile, service, model and
 * workspace): `ghost` a ghost's answer, `decision` one answer of the Decisions service or its fast-model fallback.
 * `workspaceId` is the workspace whose agent spent it (an agent's ghost, `ghost_ask`); absent, the account's own (a
 * person's ghost). Token counts and cost only, never text. */
export const ServiceUsageSchema = z.strictObject({
  service: z.enum(['ghost', 'decision']), profileId: z.string().min(1), model: z.string().min(1), requests: count,
  input: count, output: count, costUsd: z.number().nonnegative(), workspaceId: z.string().min(1).optional(),
});
export type ServiceUsage = z.infer<typeof ServiceUsageSchema>;
