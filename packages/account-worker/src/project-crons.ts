import { DurableObject } from 'cloudflare:workers';
import {
  PROJECT_CRON_ACTIVE_LOCK_MS,
  nextProjectCronRunAt,
  parseProjectCronSchedule,
  type ProjectCronDraft,
  type ProjectCronRunState,
  type ProjectCronRunView,
  type ProjectCronTarget,
  type ProjectCronView,
} from '@gitspace/protocol/cron-contract';

interface CronRow extends Record<string, SqlStorageValue> {
  id: string;
  project_id: string;
  revision: number;
  name: string;
  schedule: string;
  description: string;
  prompt: string;
  target_json: string;
  read_scopes_json: string;
  write_scopes_json: string;
  enabled: number;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow extends Record<string, SqlStorageValue> {
  id: string;
  project_id: string;
  cron_id: string;
  cron_revision: number;
  cron_name: string;
  schedule: string;
  description: string;
  trigger: 'scheduled' | 'manual';
  state: ProjectCronRunState;
  target_json: string;
  prompt: string;
  read_scopes_json: string;
  write_scopes_json: string;
  resolved_space_id: string | null;
  resolved_generation: number | null;
  scheduled_for: number;
  claimed_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  claim_token: string | null;
  claimed_by: string | null;
  message: string | null;
  created_at: number;
}

interface NormalizedCronDraft {
  name: string;
  schedule: string;
  description: string;
  prompt: string;
  target: ProjectCronTarget;
  readScopes: string[];
  writeScopes: string[];
  enabled: boolean;
}

export interface ProjectCronClaim {
  run: ProjectCronRunView;
  claimToken: string;
  leaseExpiresAt: Date;
}

export class ProjectCronValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProjectCronValidationError';
    this.field = field;
  }
}

export class ProjectCronNotFoundError extends Error {
  readonly projectId: string;
  readonly cronId: string;

  constructor(projectId: string, cronId: string) {
    super(`Project cron ${cronId} does not exist in project ${projectId}`);
    this.name = 'ProjectCronNotFoundError';
    this.projectId = projectId;
    this.cronId = cronId;
  }
}

export class ProjectCronRevisionConflictError extends Error {
  readonly cronId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(cronId: string, expected: number, actual: number) {
    super(`Project cron ${cronId} revision changed from ${expected} to ${actual}`);
    this.name = 'ProjectCronRevisionConflictError';
    this.cronId = cronId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class ProjectCronAlreadyRunningError extends Error {
  readonly cronId: string;
  readonly runId: string;
  readonly state: 'pending' | 'running';

  constructor(cronId: string, runId: string, state: 'pending' | 'running') {
    super(`Project cron ${cronId} already has a ${state} run`);
    this.name = 'ProjectCronAlreadyRunningError';
    this.cronId = cronId;
    this.runId = runId;
    this.state = state;
  }
}

export class ProjectCronRunNotCompletableError extends Error {
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);
    this.name = 'ProjectCronRunNotCompletableError';
    this.runId = runId;
  }
}

function identifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new ProjectCronValidationError(field, `${field} is invalid`);
  return value;
}

function boundedText(value: string, field: string, maximum: number, required: boolean): string {
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > maximum) {
    throw new ProjectCronValidationError(field, `${field} must be ${required ? 'between 1 and' : 'at most'} ${maximum} characters`);
  }
  return normalized;
}

function scopes(values: readonly string[], field: string): string[] {
  if (values.length > 64) throw new ProjectCronValidationError(field, `${field} cannot contain more than 64 entries`);
  const normalized = values.map((value) => {
    const scope = value.trim();
    if (scope.length === 0 || scope.length > 512 || scope.includes('\0')) {
      throw new ProjectCronValidationError(field, `${field} contains an invalid scope`);
    }
    return scope;
  });
  return [...new Set(normalized)];
}

function normalizeDraft(projectId: string, draft: ProjectCronDraft): NormalizedCronDraft {
  const schedule = boundedText(draft.schedule, 'schedule', 100, true).toLowerCase();
  if (parseProjectCronSchedule(schedule) === null) throw new ProjectCronValidationError('schedule', `'${schedule}' will never fire`);
  if (draft.target.projectId !== projectId) throw new ProjectCronValidationError('target', 'Cron target must belong to the same project');
  const target: ProjectCronTarget = draft.target.scope === 'project'
    ? { scope: 'project', projectId }
    : { scope: 'workspace', projectId, spaceId: identifier(draft.target.spaceId, 'spaceId') };
  return {
    name: boundedText(draft.name, 'name', 120, true),
    schedule,
    description: boundedText(draft.description, 'description', 2_000, false),
    prompt: boundedText(draft.prompt, 'prompt', 16_000, true),
    target,
    readScopes: scopes(draft.readScopes, 'readScopes'),
    writeScopes: scopes(draft.writeScopes, 'writeScopes'),
    enabled: draft.enabled,
  };
}

function timestamp(value: number | undefined): number {
  const resolved = value ?? Date.now();
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new ProjectCronValidationError('now', 'Cron timestamp is invalid');
  return resolved;
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new Error('Stored cron scope is malformed');
  return parsed;
}

function parseTarget(value: string): ProjectCronTarget {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Stored cron target is malformed');
  const target = parsed as Record<string, unknown>;
  if (target.scope === 'project' && typeof target.projectId === 'string') return { scope: 'project', projectId: target.projectId };
  if (target.scope === 'workspace' && typeof target.projectId === 'string' && typeof target.spaceId === 'string') {
    return { scope: 'workspace', projectId: target.projectId, spaceId: target.spaceId };
  }
  throw new Error('Stored cron target is malformed');
}

function runView(row: RunRow): ProjectCronRunView {
  return {
    id: row.id,
    projectId: row.project_id,
    cronId: row.cron_id,
    cronRevision: row.cron_revision,
    cronName: row.cron_name,
    schedule: row.schedule,
    description: row.description,
    trigger: row.trigger,
    state: row.state,
    target: parseTarget(row.target_json),
    prompt: row.prompt,
    readScopes: parseStringArray(row.read_scopes_json),
    writeScopes: parseStringArray(row.write_scopes_json),
    resolvedSpaceId: row.resolved_space_id,
    resolvedGeneration: row.resolved_generation,
    scheduledFor: new Date(row.scheduled_for),
    claimedAt: row.claimed_at === null ? null : new Date(row.claimed_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
    message: row.message,
    createdAt: new Date(row.created_at),
  };
}

export class ProjectCronsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS project_cron_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          project_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_crons (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          schedule TEXT NOT NULL,
          description TEXT NOT NULL,
          prompt TEXT NOT NULL,
          target_json TEXT NOT NULL,
          read_scopes_json TEXT NOT NULL,
          write_scopes_json TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          next_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS project_crons_name ON project_crons(project_id, name);
        CREATE INDEX IF NOT EXISTS project_crons_due ON project_crons(enabled, next_run_at);
        CREATE TABLE IF NOT EXISTS project_cron_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          cron_id TEXT NOT NULL,
          cron_revision INTEGER NOT NULL,
          cron_name TEXT NOT NULL,
          schedule TEXT NOT NULL,
          description TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
          state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'blocked', 'failed')),
          target_json TEXT NOT NULL,
          prompt TEXT NOT NULL,
          read_scopes_json TEXT NOT NULL,
          write_scopes_json TEXT NOT NULL,
          resolved_space_id TEXT,
          resolved_generation INTEGER,
          scheduled_for INTEGER NOT NULL,
          claimed_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          claim_token TEXT,
          claimed_by TEXT,
          message TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_cron_runs_history ON project_cron_runs(cron_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS project_cron_one_active_run
          ON project_cron_runs(cron_id) WHERE state IN ('pending', 'running');
      `);
    });
  }

  list(projectIdInput: string): ProjectCronView[] {
    const projectId = this.ensureProject(projectIdInput);
    return this.ctx.storage.sql.exec<CronRow>(`
      SELECT id, project_id, revision, name, schedule, description, prompt, target_json,
        read_scopes_json, write_scopes_json, enabled, next_run_at, created_at, updated_at
      FROM project_crons WHERE project_id = ? ORDER BY name, id
    `, projectId).toArray().map((row) => this.cronView(row));
  }

  async create(input: { projectId: string; draft: ProjectCronDraft; now?: number }): Promise<ProjectCronView> {
    const projectId = this.ensureProject(input.projectId);
    const draft = normalizeDraft(projectId, input.draft);
    const now = timestamp(input.now);
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      if (this.rowByName(projectId, draft.name)) throw new ProjectCronValidationError('name', `A cron named '${draft.name}' already exists`);
      this.ctx.storage.sql.exec(`
        INSERT INTO project_crons(
          id, project_id, revision, name, schedule, description, prompt, target_json,
          read_scopes_json, write_scopes_json, enabled, next_run_at, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, projectId, draft.name, draft.schedule, draft.description, draft.prompt, JSON.stringify(draft.target),
      JSON.stringify(draft.readScopes), JSON.stringify(draft.writeScopes), draft.enabled ? 1 : 0,
      draft.enabled ? nextProjectCronRunAt(draft.schedule, now, now) : null, now, now);
    });
    await this.refreshAlarm(now);
    return this.cronView(this.requiredRow(projectId, id));
  }

  async update(input: { projectId: string; cronId: string; expectedRevision: number; draft: ProjectCronDraft; now?: number }): Promise<ProjectCronView> {
    const projectId = this.ensureProject(input.projectId);
    const cronId = identifier(input.cronId, 'cronId');
    const draft = normalizeDraft(projectId, input.draft);
    const now = timestamp(input.now);
    this.ctx.storage.transactionSync(() => {
      const current = this.requiredRow(projectId, cronId);
      if (current.revision !== input.expectedRevision) throw new ProjectCronRevisionConflictError(cronId, input.expectedRevision, current.revision);
      const duplicate = this.rowByName(projectId, draft.name);
      if (duplicate && duplicate.id !== cronId) throw new ProjectCronValidationError('name', `A cron named '${draft.name}' already exists`);
      const scheduleChanged = current.schedule !== draft.schedule;
      const enabledChanged = current.enabled !== (draft.enabled ? 1 : 0);
      const nextRunAt = !draft.enabled ? null
        : scheduleChanged || enabledChanged || current.next_run_at === null ? nextProjectCronRunAt(draft.schedule, now, now) : current.next_run_at;
      const changed = this.ctx.storage.sql.exec<{ revision: number }>(`
        UPDATE project_crons SET revision = revision + 1, name = ?, schedule = ?, description = ?, prompt = ?,
          target_json = ?, read_scopes_json = ?, write_scopes_json = ?, enabled = ?, next_run_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND revision = ?
        RETURNING revision
      `, draft.name, draft.schedule, draft.description, draft.prompt, JSON.stringify(draft.target), JSON.stringify(draft.readScopes),
      JSON.stringify(draft.writeScopes), draft.enabled ? 1 : 0, nextRunAt, now, projectId, cronId, input.expectedRevision).toArray();
      if (changed.length !== 1) {
        const actual = this.requiredRow(projectId, cronId).revision;
        throw new ProjectCronRevisionConflictError(cronId, input.expectedRevision, actual);
      }
    });
    await this.refreshAlarm(now);
    return this.cronView(this.requiredRow(projectId, cronId));
  }

  async delete(input: { projectId: string; cronId: string; expectedRevision: number; now?: number }): Promise<{ projectId: string; cronId: string; deleted: true }> {
    const projectId = this.ensureProject(input.projectId);
    const cronId = identifier(input.cronId, 'cronId');
    const now = timestamp(input.now);
    this.ctx.storage.transactionSync(() => {
      const current = this.requiredRow(projectId, cronId);
      if (current.revision !== input.expectedRevision) throw new ProjectCronRevisionConflictError(cronId, input.expectedRevision, current.revision);
      const active = this.activeRun(cronId);
      if (active) throw new ProjectCronAlreadyRunningError(cronId, active.id, active.state as 'pending' | 'running');
      const changed = this.ctx.storage.sql.exec<{ id: string }>(
        'DELETE FROM project_crons WHERE project_id = ? AND id = ? AND revision = ? RETURNING id',
        projectId,
        cronId,
        input.expectedRevision,
      ).toArray();
      if (changed.length !== 1) throw new ProjectCronRevisionConflictError(cronId, input.expectedRevision, this.requiredRow(projectId, cronId).revision);
    });
    await this.refreshAlarm(now);
    return { projectId, cronId, deleted: true };
  }

  async runNow(input: { projectId: string; cronId: string; now?: number }): Promise<ProjectCronRunView> {
    const projectId = this.ensureProject(input.projectId);
    const cronId = identifier(input.cronId, 'cronId');
    const now = timestamp(input.now);
    let runId = '';
    this.ctx.storage.transactionSync(() => {
      this.expireStaleRuns(now);
      const cron = this.requiredRow(projectId, cronId);
      const active = this.activeRun(cronId);
      if (active) throw new ProjectCronAlreadyRunningError(cronId, active.id, active.state as 'pending' | 'running');
      runId = this.insertRun(cron, 'manual', now, now);
    });
    await this.refreshAlarm(now);
    return runView(this.requiredRun(projectId, runId));
  }

  history(input: { projectId: string; cronId: string; limit?: number }): ProjectCronRunView[] {
    const projectId = this.ensureProject(input.projectId);
    const cronId = identifier(input.cronId, 'cronId');
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ProjectCronValidationError('limit', 'Run history limit must be between 1 and 200');
    const definition = this.row(projectId, cronId);
    const rows = this.ctx.storage.sql.exec<RunRow>(`
      SELECT * FROM project_cron_runs WHERE project_id = ? AND cron_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `, projectId, cronId, limit).toArray();
    if (!definition && rows.length === 0) throw new ProjectCronNotFoundError(projectId, cronId);
    return rows.map(runView);
  }

  async processDue(input: { projectId: string; now?: number }): Promise<ProjectCronRunView[]> {
    const projectId = this.ensureProject(input.projectId);
    const now = timestamp(input.now);
    const created: string[] = [];
    this.ctx.storage.transactionSync(() => {
      this.expireStaleRuns(now);
      const due = this.ctx.storage.sql.exec<CronRow>(`
        SELECT id, project_id, revision, name, schedule, description, prompt, target_json,
          read_scopes_json, write_scopes_json, enabled, next_run_at, created_at, updated_at
        FROM project_crons WHERE project_id = ? AND enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id
      `, projectId, now).toArray();
      for (const cron of due) {
        if (!this.activeRun(cron.id)) created.push(this.insertRun(cron, 'scheduled', cron.next_run_at ?? now, now));
        const nextRunAt = nextProjectCronRunAt(cron.schedule, cron.next_run_at ?? now, now);
        this.ctx.storage.sql.exec('UPDATE project_crons SET next_run_at = ? WHERE id = ? AND revision = ?', nextRunAt, cron.id, cron.revision);
      }
    });
    await this.refreshAlarm(now);
    return created.map((runId) => runView(this.requiredRun(projectId, runId)));
  }

  /**
   * Claim the next due run whose target this machine holds. `heldSpaceIds`
   * names the spaces (base space id = project id) the claimant can prompt;
   * runs for spaces held elsewhere stay pending for their holder.
   */
  async claimNext(input: { projectId: string; claimedBy: string; heldSpaceIds?: readonly string[]; now?: number }): Promise<ProjectCronClaim | null> {
    const projectId = this.ensureProject(input.projectId);
    const claimedBy = identifier(input.claimedBy, 'claimedBy');
    const now = timestamp(input.now);
    const claimToken = crypto.randomUUID();
    const held = JSON.stringify(input.heldSpaceIds ?? []);
    const placementAware = input.heldSpaceIds !== undefined;
    let runId: string | null = null;
    this.ctx.storage.transactionSync(() => {
      this.expireStaleRuns(now);
      const candidate = placementAware
        ? this.ctx.storage.sql.exec<{ id: string }>(`
          SELECT id FROM project_cron_runs
          WHERE project_id = ? AND state = 'pending'
            AND COALESCE(json_extract(target_json, '$.spaceId'), json_extract(target_json, '$.projectId')) IN (SELECT value FROM json_each(?))
          ORDER BY scheduled_for, created_at, rowid LIMIT 1
        `, projectId, held).toArray()[0]
        : this.ctx.storage.sql.exec<{ id: string }>(`
          SELECT id FROM project_cron_runs WHERE project_id = ? AND state = 'pending' ORDER BY scheduled_for, created_at, rowid LIMIT 1
        `, projectId).toArray()[0];
      if (!candidate) return;
      const changed = this.ctx.storage.sql.exec<{ id: string }>(`
        UPDATE project_cron_runs SET state = 'running', claimed_at = ?, started_at = ?, claim_token = ?, claimed_by = ?
        WHERE id = ? AND project_id = ? AND state = 'pending'
        RETURNING id
      `, now, now, claimToken, claimedBy, candidate.id, projectId).toArray();
      if (changed.length === 1) runId = candidate.id;
    });
    await this.refreshAlarm(now);
    if (runId === null) return null;
    return { run: runView(this.requiredRun(projectId, runId)), claimToken, leaseExpiresAt: new Date(now + PROJECT_CRON_ACTIVE_LOCK_MS) };
  }

  async completeRun(input: {
    projectId: string;
    runId: string;
    claimToken: string;
    state: 'succeeded' | 'blocked' | 'failed';
    message?: string | null;
    resolvedSpaceId?: string | null;
    resolvedGeneration?: number | null;
    now?: number;
  }): Promise<ProjectCronRunView> {
    const projectId = this.ensureProject(input.projectId);
    const runId = identifier(input.runId, 'runId');
    const claimToken = identifier(input.claimToken, 'claimToken');
    const now = timestamp(input.now);
    const message = input.message === null || input.message === undefined ? null : boundedText(input.message, 'message', 4_000, false);
    const resolvedSpaceId = input.resolvedSpaceId === null || input.resolvedSpaceId === undefined
      ? null
      : identifier(input.resolvedSpaceId, 'resolvedSpaceId');
    const resolvedGeneration = input.resolvedGeneration === null || input.resolvedGeneration === undefined
      ? null
      : input.resolvedGeneration;
    if (resolvedGeneration !== null && (!Number.isSafeInteger(resolvedGeneration) || resolvedGeneration < 1)) {
      throw new ProjectCronValidationError('resolvedGeneration', 'Resolved space generation is invalid');
    }
    if ((resolvedSpaceId === null) !== (resolvedGeneration === null)) {
      throw new ProjectCronValidationError('resolvedSpaceId', 'Resolved space id and generation must be recorded together');
    }
    const changed = this.ctx.storage.sql.exec<{ id: string }>(`
      UPDATE project_cron_runs SET state = ?, completed_at = ?, message = ?, resolved_space_id = ?,
        resolved_generation = ?, claim_token = NULL
      WHERE id = ? AND project_id = ? AND state = 'running' AND claim_token = ?
      RETURNING id
    `, input.state, now, message, resolvedSpaceId, resolvedGeneration, runId, projectId, claimToken).toArray();
    if (changed.length !== 1) {
      const existing = this.run(projectId, runId);
      throw new ProjectCronRunNotCompletableError(runId, existing
        ? `Project cron run ${runId} is ${existing.state} or its claim has expired`
        : `Project cron run ${runId} does not exist`);
    }
    await this.refreshAlarm(now);
    return runView(this.requiredRun(projectId, runId));
  }

  async alarm(): Promise<void> {
    const identity = this.ctx.storage.sql.exec<{ project_id: string }>('SELECT project_id FROM project_cron_identity WHERE id = 1').toArray()[0];
    if (!identity) return;
    await this.processDue({ projectId: identity.project_id });
  }

  private ensureProject(projectIdInput: string): string {
    const projectId = identifier(projectIdInput, 'projectId');
    this.ctx.storage.transactionSync(() => {
      const identity = this.ctx.storage.sql.exec<{ project_id: string }>('SELECT project_id FROM project_cron_identity WHERE id = 1').toArray()[0];
      if (!identity) {
        this.ctx.storage.sql.exec('INSERT INTO project_cron_identity(id, project_id, created_at) VALUES (1, ?, ?)', projectId, Date.now());
      } else if (identity.project_id !== projectId) {
        throw new Error(`Project cron authority belongs to ${identity.project_id}, not ${projectId}`);
      }
    });
    return projectId;
  }

  private cronView(row: CronRow): ProjectCronView {
    const latest = this.ctx.storage.sql.exec<RunRow>('SELECT * FROM project_cron_runs WHERE cron_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', row.id).toArray()[0];
    const active = this.activeRun(row.id);
    const state = active ? 'running'
      : row.enabled === 0 ? 'paused'
      : latest?.state === 'blocked' ? 'blocked'
      : latest?.state === 'failed' ? 'failed'
      : 'armed';
    const lastRunTimestamp = latest ? latest.completed_at ?? latest.started_at ?? latest.scheduled_for : null;
    return {
      id: row.id,
      projectId: row.project_id,
      revision: row.revision,
      name: row.name,
      schedule: row.schedule,
      description: row.description,
      prompt: row.prompt,
      target: parseTarget(row.target_json),
      readScopes: parseStringArray(row.read_scopes_json),
      writeScopes: parseStringArray(row.write_scopes_json),
      enabled: row.enabled === 1,
      state,
      nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at),
      lastRunAt: lastRunTimestamp === null ? null : new Date(lastRunTimestamp),
      lastRunState: latest?.state ?? null,
      statusMessage: latest?.message ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private insertRun(cron: CronRow, trigger: 'scheduled' | 'manual', scheduledFor: number, now: number): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(`
      INSERT INTO project_cron_runs(
        id, project_id, cron_id, cron_revision, cron_name, schedule, description, trigger, state,
        target_json, prompt, read_scopes_json, write_scopes_json, scheduled_for, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `, id, cron.project_id, cron.id, cron.revision, cron.name, cron.schedule, cron.description, trigger,
    cron.target_json, cron.prompt, cron.read_scopes_json, cron.write_scopes_json, scheduledFor, now);
    return id;
  }

  private expireStaleRuns(now: number): void {
    const cutoff = now - PROJECT_CRON_ACTIVE_LOCK_MS;
    this.ctx.storage.sql.exec(`
      UPDATE project_cron_runs SET state = 'failed', completed_at = ?, claim_token = NULL,
        message = CASE WHEN state = 'pending' THEN 'Run was not claimed within one hour' ELSE 'Run did not complete before its one-hour claim expired' END
      WHERE (state = 'pending' AND created_at <= ?) OR (state = 'running' AND claimed_at <= ?)
    `, now, cutoff, cutoff);
  }

  private async refreshAlarm(now: number): Promise<void> {
    const due = this.ctx.storage.sql.exec<{ due_at: number | null }>(`
      SELECT MIN(due_at) AS due_at FROM (
        SELECT MIN(next_run_at) AS due_at FROM project_crons WHERE enabled = 1 AND next_run_at IS NOT NULL
        UNION ALL
        SELECT MIN(CASE WHEN state = 'pending' THEN created_at ELSE claimed_at END + ?) AS due_at
          FROM project_cron_runs WHERE state IN ('pending', 'running')
      )
    `, PROJECT_CRON_ACTIVE_LOCK_MS).toArray()[0]?.due_at ?? null;
    if (due === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1, due));
  }

  private row(projectId: string, cronId: string): CronRow | undefined {
    return this.ctx.storage.sql.exec<CronRow>(`
      SELECT id, project_id, revision, name, schedule, description, prompt, target_json,
        read_scopes_json, write_scopes_json, enabled, next_run_at, created_at, updated_at
      FROM project_crons WHERE project_id = ? AND id = ?
    `, projectId, cronId).toArray()[0];
  }

  private requiredRow(projectId: string, cronId: string): CronRow {
    const row = this.row(projectId, cronId);
    if (!row) throw new ProjectCronNotFoundError(projectId, cronId);
    return row;
  }

  private rowByName(projectId: string, name: string): CronRow | undefined {
    return this.ctx.storage.sql.exec<CronRow>(`
      SELECT id, project_id, revision, name, schedule, description, prompt, target_json,
        read_scopes_json, write_scopes_json, enabled, next_run_at, created_at, updated_at
      FROM project_crons WHERE project_id = ? AND name = ? COLLATE NOCASE
    `, projectId, name).toArray()[0];
  }

  private activeRun(cronId: string): RunRow | undefined {
    return this.ctx.storage.sql.exec<RunRow>(`
      SELECT * FROM project_cron_runs WHERE cron_id = ? AND state IN ('pending', 'running') ORDER BY created_at, rowid LIMIT 1
    `, cronId).toArray()[0];
  }

  private run(projectId: string, runId: string): RunRow | undefined {
    return this.ctx.storage.sql.exec<RunRow>('SELECT * FROM project_cron_runs WHERE project_id = ? AND id = ?', projectId, runId).toArray()[0];
  }

  private requiredRun(projectId: string, runId: string): RunRow {
    const row = this.run(projectId, runId);
    if (!row) throw new ProjectCronRunNotCompletableError(runId, `Project cron run ${runId} does not exist`);
    return row;
  }
}
