import { defineErrors, type InputOf, wire } from 'result-rpc';

export const PROJECT_CRON_ACTIVE_LOCK_MS = 60 * 60_000;
export const PROJECT_CRON_SCHEDULE_HELP = "Schedules are 'every N minutes/hours/days' — for example 'every 5m', 'every 6h', or 'every 1d'.";

export function parseProjectCronSchedule(schedule: string): number | null {
  const match = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/u.exec(schedule.trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2]![0];
  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const interval = amount * multiplier;
  return Number.isSafeInteger(interval) ? interval : null;
}

export function nextProjectCronRunAt(schedule: string, previousRunAt: number, now: number): number {
  const interval = parseProjectCronSchedule(schedule);
  if (interval === null) throw new Error(`Invalid cron schedule: ${schedule}`);
  if (!Number.isFinite(previousRunAt) || !Number.isFinite(now)) throw new Error('Cron timestamps must be finite');
  if (previousRunAt > now) return previousRunAt;
  const elapsedIntervals = Math.floor((now - previousRunAt) / interval) + 1;
  const next = previousRunAt + elapsedIntervals * interval;
  if (!Number.isSafeInteger(next)) throw new Error('Cron next-run timestamp is outside the supported range');
  return next;
}

export const ProjectCronTargetCodec = wire.union([
  wire.object({ scope: wire.literal('project'), projectId: wire.string }),
  wire.object({ scope: wire.literal('workspace'), projectId: wire.string, spaceId: wire.string }),
]);
export type ProjectCronTarget = InputOf<typeof ProjectCronTargetCodec>;

export const ProjectCronDraftCodec = wire.object({
  name: wire.string,
  schedule: wire.string,
  description: wire.string,
  prompt: wire.string,
  target: ProjectCronTargetCodec,
  readScopes: wire.array(wire.string),
  writeScopes: wire.array(wire.string),
  enabled: wire.boolean,
});
export type ProjectCronDraft = InputOf<typeof ProjectCronDraftCodec>;

export const ProjectCronRunStateCodec = wire.enum(['pending', 'running', 'succeeded', 'blocked', 'failed']);
export type ProjectCronRunState = InputOf<typeof ProjectCronRunStateCodec>;

export const ProjectCronTriggerCodec = wire.enum(['scheduled', 'manual']);
export type ProjectCronTrigger = InputOf<typeof ProjectCronTriggerCodec>;

export const ProjectCronRunViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  cronId: wire.string,
  cronRevision: wire.integer({ min: 1 }),
  cronName: wire.string,
  schedule: wire.string,
  description: wire.string,
  trigger: ProjectCronTriggerCodec,
  state: ProjectCronRunStateCodec,
  target: ProjectCronTargetCodec,
  prompt: wire.string,
  readScopes: wire.array(wire.string),
  writeScopes: wire.array(wire.string),
  resolvedSpaceId: wire.nullable(wire.string),
  resolvedGeneration: wire.nullable(wire.integer({ min: 1 })),
  scheduledFor: wire.date,
  claimedAt: wire.nullable(wire.date),
  startedAt: wire.nullable(wire.date),
  completedAt: wire.nullable(wire.date),
  message: wire.nullable(wire.string),
  createdAt: wire.date,
});
export type ProjectCronRunView = InputOf<typeof ProjectCronRunViewCodec>;

export const ProjectCronStateCodec = wire.enum(['armed', 'paused', 'running', 'blocked', 'failed']);
export type ProjectCronState = InputOf<typeof ProjectCronStateCodec>;

export const ProjectCronViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  revision: wire.integer({ min: 1 }),
  name: wire.string,
  schedule: wire.string,
  description: wire.string,
  prompt: wire.string,
  target: ProjectCronTargetCodec,
  readScopes: wire.array(wire.string),
  writeScopes: wire.array(wire.string),
  enabled: wire.boolean,
  state: ProjectCronStateCodec,
  nextRunAt: wire.nullable(wire.date),
  lastRunAt: wire.nullable(wire.date),
  lastRunState: wire.nullable(ProjectCronRunStateCodec),
  statusMessage: wire.nullable(wire.string),
  createdAt: wire.date,
  updatedAt: wire.date,
});
export type ProjectCronView = InputOf<typeof ProjectCronViewCodec>;

export const projectCronErrors = defineErrors('gitspace-project-crons', {
  cronNotFound: {
    data: wire.object({ projectId: wire.string, cronId: wire.string }),
    httpStatus: 404,
  },
  cronRevisionConflict: {
    data: wire.object({ cronId: wire.string, expected: wire.number, actual: wire.number }),
    httpStatus: 409,
  },
  cronAlreadyRunning: {
    data: wire.object({ cronId: wire.string, runId: wire.string, state: wire.enum(['pending', 'running']) }),
    httpStatus: 409,
  },
  cronInvalid: {
    data: wire.object({ field: wire.string, message: wire.string }),
    httpStatus: 400,
  },
});

