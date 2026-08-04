/**
 * Trigger record shape, split out from `core/triggers.ts`.
 *
 * This module MUST stay free of Node builtins. The Crons pane renders trigger
 * records in the browser and needs the schema to parse them, but `core/triggers.ts`
 * imports `child_process` and reaches `core/artifacts.ts`, whose module-scope
 * `promisify(exec)` throws under Vite's browser externalization and takes the
 * whole client down before React mounts. Keeping the shape here lets both sides
 * share one definition without dragging the daemon's filesystem code into the
 * bundle.
 */

import { z } from 'zod';

const triggerRunSchema = z.object({
  at: z.string(),
  status: z.enum(['ok', 'fail', 'pending']),
  note: z.string().optional(),
  sessionId: z.string().optional(),
  startCommit: z.string().nullable().optional(),
});

export const triggerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['cron', 'event', 'manual']),
  when: z.string(),
  status: z.enum(['ok', 'pending', 'failed', 'idle']),
  last: z.string(),
  next: z.string().optional(),
  cost: z.string().optional(),
  writes: z.array(z.string()),
  history: z.array(z.enum(['ok', 'fail', 'pending'])),
  note: z.string().optional(),
  scope: z.enum(['workspace', 'project']).optional(),
  does: z.string().optional(),
  runs: z.object({ type: z.enum(['command', 'skill', 'workflow']), ref: z.string().optional(), prompt: z.string().optional() }).optional(),
  reads: z.array(z.string()).optional(),
  feeds: z.array(z.string()).optional(),
  runLog: z.array(triggerRunSchema).optional(),
});

export type TriggerRecord = z.infer<typeof triggerSchema>;
