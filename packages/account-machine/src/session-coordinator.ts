import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  LocalArtifactResolver,
  agentSessions,
  artifactScopes,
  type AgentSession,
  type ArtifactCapability,
  type ArtifactScope,
  type GitSpaceDatabase,
  type ProjectEventWriter,
} from '@gitspace/core';
import type { CanonicalArtifactScope, CanonicalSession, SessionActivity } from '@gitspace/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpSessionControlView, OmpTranscriptEvent } from './omp-runtime.js';
import type { PendingAskAnswer } from '../../account-omp/src/ask-bridge.js';
import { buildSessionUsageReport, type SessionUsageReport } from './session-usage-report.js';

export class SessionWorkspaceUnavailable extends TaggedError('SessionWorkspaceUnavailable')<{
  workspaceId: string;
  message: string;
}> {}
export class SessionProjectUnavailable extends TaggedError('SessionProjectUnavailable')<{
  projectId: string;
  message: string;
}> {}
export class SessionPossessionDenied extends TaggedError('SessionPossessionDenied')<{
  workspaceId: string;
  message: string;
}> {}
export class SessionRuntimeError extends TaggedError('SessionRuntimeError')<{
  sessionId?: string;
  operation: string;
  message: string;
}> {}
export type MachineSessionError = SessionWorkspaceUnavailable | SessionProjectUnavailable | SessionPossessionDenied | SessionRuntimeError;

interface LiveSession {
  recordId: string;
  runtime: OmpRuntimeSession;
  artifactsDir: string;
  capability: ArtifactCapability;
  artifactBaseline: Map<string, string>;
  artifactSync: Promise<number> | null;
  unsubscribe: () => void;
  activityUnsubscribe: () => void;
}

type SessionTarget =
  | {
      scope: 'project';
      projectId: string;
      workspaceId: null;
      workingDirectory: string;
      sessionKey: string;
      capability: Extract<ArtifactCapability, { kind: 'project' }>;
    }
  | {
      scope: 'workspace';
      projectId: string;
      workspaceId: string;
      workingDirectory: string;
      sessionKey: string;
      capability: Extract<ArtifactCapability, { kind: 'workspace' }>;
    };

async function filesUnder(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return files;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function runtimeError(operation: string, error: unknown, sessionId?: string): SessionRuntimeError {
  return new SessionRuntimeError({
    ...(sessionId ? { sessionId } : {}),
    operation,
    message: error instanceof Error ? error.message : String(error),
  });
}
function serializableEvent(event: OmpRuntimeEvent): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  } catch {
    return { type: event.type };
  }
}

const PERSISTED_TRANSCRIPT_EVENTS: Readonly<Record<string, true>> = {
  turn_start: true,
  turn_end: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_end: true,
  session_compact: true,
  compaction: true,
  error: true,
  notice: true,
};




export interface CoordinatorPortableAgentSnapshot {
  sessionId: string;
  ompSessionId: string;
  ompSession: Uint8Array;
  resumePending?: boolean;
}

export interface CoordinatorPortableArtifactSnapshot {
  generation: number;
  manifest: Uint8Array;
}
export interface CanonicalSessionWriter {
  put(projectId: string, machineId: string, session: AgentSession, checkpoint?: boolean): void;
}

export interface ArtifactManifestAuthority {
  synchronizeArtifactScope(projectId: string, scope: ArtifactScope): Promise<unknown>;
  listArtifactScopes?(projectId: string): Promise<CanonicalArtifactScope[]>;
}


export class MachineSessionCoordinator {
  private readonly liveTranscripts = new Map<string, OmpTranscriptEvent[]>();
  private readonly transcriptUpdateTimers = new Map<string, Timer>();
  private readonly live = new Map<string, LiveSession>();
  private readonly quiesced = new Set<string>();
  private readonly activePrompts = new Map<string, Set<Promise<void>>>();
  private readonly recoveringSessions = new Map<string, boolean>();
  private readonly artifactPublicationBases = new Map<string, ArtifactScope>();

  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly artifacts: LocalArtifactResolver,
    private readonly omp: OmpRuntime,
    private readonly machineId: string,
    private readonly runtimeRoot: string,
    private readonly events?: ProjectEventWriter,
    private readonly managedSpaceRoot: string = dirname(runtimeRoot),
    private readonly canonicalSessions?: CanonicalSessionWriter,
    private readonly artifactManifests?: ArtifactManifestAuthority,
  ) {}

  async create(workspaceId: string): Promise<ResultType<AgentSession, MachineSessionError>> {
    return this.openSpace(workspaceId);
  }

  async createProject(projectId: string): Promise<ResultType<AgentSession, MachineSessionError>> {
    return this.openSpace(projectId);
  }

  async openSpace(spaceId: string, allowOpening = false): Promise<ResultType<AgentSession, MachineSessionError>> {
    const target = this.spaceTarget(spaceId, allowOpening);
    return target.status === 'error' ? target : this.createTarget(target.value);
  }

  private async createTarget(target: SessionTarget): Promise<ResultType<AgentSession, MachineSessionError>> {
    const existing = this.database.orm.select().from(agentSessions).where(eq(agentSessions.spaceId, target.scope === 'workspace' ? target.workspaceId : target.projectId)).get();
    if (existing && this.live.has(existing.id)) return Result.ok(this.get(existing.id)!);
    const recordId = existing?.id ?? crypto.randomUUID();
    const artifactsDir = join(this.runtimeRoot, 'sessions', recordId, 'artifacts');
    const materialized = await this.materializeArtifacts(target.capability, artifactsDir);
    if (materialized.status === 'error') return materialized;
    try {
      if (existing) {
        const runtime = await this.omp.open({
          projectId: target.projectId,
          workspaceId: target.scope === 'workspace' ? target.workspaceId : null,
          workingDirectory: target.workingDirectory,
          sessionKey: target.sessionKey,
          artifactsDir,
          sessionFile: existing.sessionFile,
        });
        if (runtime.id !== existing.ompSessionId) {
          await runtime.dispose();
          return Result.err(runtimeError('open', new Error(`OMP session id changed from ${existing.ompSessionId} to ${runtime.id}`), existing.id));
        }
        const now = new Date().toISOString();
        this.database.orm.update(agentSessions).set({ state: 'active', updatedAt: now })
          .where(eq(agentSessions.id, existing.id)).run();
        const record = this.get(existing.id)!;
        await this.adopt(record, runtime, artifactsDir, target.capability, materialized.value);
        this.resumeIfPending(existing, runtime, target.capability);
        this.publishCanonicalSession(target.projectId, record.id, true);
        this.events?.append({
          projectId: target.projectId,
          scope: 'session',
          entity: 'main-agent',
          entityId: record.id,
          revision: record.lastEventOffset,
          operation: 'updated',
          payload: { spaceId: target.scope === 'workspace' ? target.workspaceId : target.projectId, sessionScope: target.scope, state: record.state },
        });
        return Result.ok(record);
      }
      const runtime = await this.omp.create({
        projectId: target.projectId,
        workspaceId: target.scope === 'workspace' ? target.workspaceId : null,
        workingDirectory: target.workingDirectory,
        sessionKey: target.sessionKey,
        artifactsDir,
      });
      const now = new Date().toISOString();
      const record = this.database.orm.insert(agentSessions).values({
        id: recordId,
        spaceId: target.scope === 'workspace' ? target.workspaceId : target.projectId,
        ompSessionId: runtime.id,
        sessionFile: runtime.sessionFile,
        state: 'active',
        lastEventOffset: 0,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
      await this.adopt(record, runtime, artifactsDir, target.capability, materialized.value);
      this.publishCanonicalSession(target.projectId, record.id, true);
      this.events?.append({
        projectId: target.projectId,
        scope: 'session',
        entity: 'main-agent',
        entityId: record.id,
        revision: 1,
        operation: 'created',
        payload: { spaceId: target.scope === 'workspace' ? target.workspaceId : target.projectId, sessionScope: target.scope, state: record.state },
      });
      return Result.ok(record);
    } catch (error) {
      return Result.err(runtimeError(existing ? 'open' : 'create', error, existing?.id));
    }
  }

  async recover(spaceId?: string): Promise<ResultType<AgentSession[], MachineSessionError>> {
    const recoverable = this.database.orm.select().from(agentSessions)
      .where(and(inArray(agentSessions.state, ['opening', 'active', 'draining']), spaceId ? eq(agentSessions.spaceId, spaceId) : undefined))
      .orderBy(agentSessions.createdAt, agentSessions.id).all();
    const recovered: AgentSession[] = [];
    for (const record of recoverable) {
      const placement = this.database.getSpacePlacement(record.spaceId);
      if (!placement || placement.holderId !== this.machineId || placement.state !== 'open' || placement.generation < 1) continue;
      if (this.live.has(record.id)) {
        recovered.push(record);
        continue;
      }
      const target = this.spaceTarget(record.spaceId);
      if (target.status === 'error') return target;
      const artifactsDir = join(this.runtimeRoot, 'sessions', record.id, 'artifacts');
      const materialized = await this.materializeArtifacts(target.value.capability, artifactsDir);
      if (materialized.status === 'error') return materialized;
      try {
        const runtime = await this.omp.open({
          projectId: target.value.projectId,
          workspaceId: target.value.scope === 'workspace' ? target.value.workspaceId : null,
          workingDirectory: target.value.workingDirectory,
          sessionKey: target.value.sessionKey,
          artifactsDir,
          sessionFile: record.sessionFile,
        });
        if (runtime.id !== record.ompSessionId) {
          await runtime.dispose();
          return Result.err(runtimeError('recover', new Error(`OMP session id changed from ${record.ompSessionId} to ${runtime.id}`), record.id));
        }
        const current = this.database.getSpacePlacement(record.spaceId);
        if (!current || current.holderId !== this.machineId || current.state !== 'open' || current.generation !== placement.generation) {
          await runtime.dispose();
          continue;
        }
        await this.adopt(record, runtime, artifactsDir, target.value.capability, materialized.value);
        this.resumeIfPending(record, runtime, target.value.capability);
        this.database.orm.update(agentSessions).set({ state: 'active', updatedAt: new Date().toISOString() })
          .where(eq(agentSessions.id, record.id)).run();
        recovered.push(this.get(record.id)!);
      } catch (error) {
        console.error('[gitspace-sessions] recover failed', record.id, error);
        this.database.orm.update(agentSessions).set({ state: 'failed', updatedAt: new Date().toISOString() })
          .where(eq(agentSessions.id, record.id)).run();
        return Result.err(runtimeError('recover', error, record.id));
      }
    }
    return Result.ok(recovered);
  }

  async prompt(sessionId: string, text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<ResultType<boolean, MachineSessionError>> {
    const live = this.live.get(sessionId);
    if (!live) return Result.err(runtimeError('prompt', new Error('Session is not live'), sessionId));
    if (this.quiesced.has(sessionId)) return Result.err(runtimeError('prompt', new Error('Session is quiescing'), sessionId));
    const acknowledgement = Promise.withResolvers<boolean>();
    let acknowledged = false;
    const accept = (forwarded: boolean): void => {
      if (acknowledged) return;
      acknowledged = true;
      acknowledgement.resolve(forwarded);
    };
    const reject = (error: unknown): void => {
      if (acknowledged) return;
      acknowledged = true;
      acknowledgement.reject(error);
    };
    const unsubscribeAcknowledgement = live.runtime.subscribe((event) => {
      if (event.type === 'message_start' || event.type === 'agent_start') accept(true);
    });
    let execution: Promise<boolean>;
    try {
      execution = live.runtime.prompt(text, options);
    } catch (error) {
      unsubscribeAcknowledgement();
      return Result.err(runtimeError('prompt', error, sessionId));
    }
    const pending = this.activePrompts.get(sessionId) ?? new Set<Promise<void>>();
    const finalization = execution.then(async (forwarded) => {
      if (!forwarded) {
        accept(false);
        return;
      }
      const generation = await this.syncSessionArtifacts(live);
      this.events?.append({
        projectId: live.capability.projectId,
        scope: 'artifact',
        entity: 'artifact-scope',
        entityId: live.capability.kind === 'workspace' ? `workspace:${live.capability.workspaceId}` : `base:${live.capability.projectId}`,
        revision: generation,
        operation: 'invalidate',
        payload: { generation },
      });
      accept(true);
    }).catch((error: unknown) => {
      const wasAcknowledged = acknowledged;
      reject(error);
      if (wasAcknowledged) console.error('[gitspace-sessions] accepted prompt failed', sessionId, error);
    }).finally(() => {
      unsubscribeAcknowledgement();
      pending.delete(finalization);
      if (pending.size === 0) this.activePrompts.delete(sessionId);
    });
    pending.add(finalization);
    this.activePrompts.set(sessionId, pending);
    try {
      return Result.ok(await acknowledgement.promise);
    } catch (error) {
      return Result.err(runtimeError('prompt', error, sessionId));
    }
  }

  async control(sessionId: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('read session controls', new Error('Session is not active'), sessionId);
    return live.runtime.control();
  }

  async cycleRole(sessionId: string, direction: 'forward' | 'backward'): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('cycle session role', new Error('Session is not active'), sessionId);
    return live.runtime.cycleRole(direction);
  }


  async setModel(sessionId: string, provider: string, model: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session model', new Error('Session is not active'), sessionId);
    return live.runtime.setModel(provider, model);
  }
  async setThinking(sessionId: string, thinking: string | null): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session thinking', new Error('Session is not active'), sessionId);
    return live.runtime.setThinking(thinking);
  }

  async setFast(sessionId: string, enabled: boolean): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session fast mode', new Error('Session is not active'), sessionId);
    return live.runtime.setFast(enabled);
  }

  async setApproval(sessionId: string, approvalMode: 'always-ask' | 'write' | 'yolo'): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session approval', new Error('Session is not active'), sessionId);
    return live.runtime.setApproval(approvalMode);
  }

  async setGoal(sessionId: string, input: { enabled: boolean; objective?: string }): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session goal', new Error('Session is not active'), sessionId);
    return live.runtime.setGoal(input);
  }

  async compact(sessionId: string, instructions?: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('compact session', new Error('Session is not active'), sessionId);
    return live.runtime.compact(instructions);
  }

  async clearQueue(sessionId: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('clear session queue', new Error('Session is not active'), sessionId);
    return live.runtime.clearQueue();
  }
  async removeQueuedMessage(sessionId: string, kind: 'steering' | 'followUp', index: number): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('remove queued message', new Error('Session is not active'), sessionId);
    return live.runtime.removeQueuedMessage(kind, index);
  }

  async promoteQueuedMessage(sessionId: string, index: number): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('steer queued message', new Error('Session is not active'), sessionId);
    return live.runtime.promoteQueuedMessage(index);
  }

  async answerAsk(sessionId: string, id: string, answers: readonly PendingAskAnswer[]): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('answer ask request', new Error('Session is not active'), sessionId);
    return live.runtime.answerAsk(id, answers);
  }

  async stop(sessionId: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('stop session turn', new Error('Session is not active'), sessionId);
    return live.runtime.stop();
  }

  async navigateTree(sessionId: string, entryId: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('navigate session tree', new Error('Session is not active'), sessionId);
    const control = await live.runtime.navigateTree(entryId);
    const messages = await live.runtime.messages();
    const createdAt = new Date().toISOString();
    this.liveTranscripts.set(sessionId, messages.map((message, index) => ({
      ordinal: index + 1,
      kind: 'message_end',
      payload: { message },
      createdAt,
    })));
    this.database.orm.update(agentSessions).set({
      lastEventOffset: messages.length,
      updatedAt: createdAt,
    }).where(eq(agentSessions.id, sessionId)).run();
    return control;
  }

  get(sessionId: string): AgentSession | null {
    return this.database.orm.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get() ?? null;
  }

  list(spaceId: string): AgentSession[] {
    return this.database.orm.select().from(agentSessions)
      .where(eq(agentSessions.spaceId, spaceId))
      .orderBy(agentSessions.createdAt, agentSessions.id).all();
  }

  async materializeCanonicalSession(session: CanonicalSession, bytes: Uint8Array): Promise<AgentSession> {
    const existing = this.get(session.id);
    if (existing) return existing;
    if (!this.database.getSpace(session.workspaceId)) {
      throw runtimeError('materialize canonical session', new Error(`Space ${session.workspaceId} is not projected`), session.id);
    }
    const sessionFile = join(this.runtimeRoot, 'canonical-sessions', `${session.id}.jsonl`);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, bytes);
    return this.database.orm.insert(agentSessions).values({
      id: session.id,
      spaceId: session.workspaceId,
      ompSessionId: session.ompSessionId,
      sessionFile,
      state: session.state,
      lastEventOffset: 0,
      resumePending: false,
      activity: session.activity,
      errorMessage: null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }).returning().get();
  }

  async transcript(sessionId: string): Promise<OmpTranscriptEvent[]> {
    const session = this.get(sessionId);
    if (!session) throw runtimeError('transcript', new Error('Session does not exist'), sessionId);
    const cached = this.liveTranscripts.get(sessionId);
    if (cached) return [...cached];
    try {
      return await this.omp.transcript(session.sessionFile);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }
  /**
   * Per-session usage attribution, reduced from the transcript on disk. Works
   * for dormant/closed sessions without waking a worker; a live session is
   * flushed first so buffered entries are counted. Null when the transcript
   * does not exist yet.
   */
  async sessionUsage(sessionId: string): Promise<SessionUsageReport | null> {
    const session = this.get(sessionId);
    if (!session) throw runtimeError('session usage', new Error('Session does not exist'), sessionId);
    await this.live.get(sessionId)?.runtime.persist();
    return buildSessionUsageReport(sessionId, session.sessionFile, async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    });
  }
  async subagentTranscript(sessionId: string, subagentId: string): Promise<OmpTranscriptEvent[]> {
    const session = this.get(sessionId);
    if (!session || !/^[A-Za-z0-9._-]{1,128}$/u.test(subagentId)) throw runtimeError('subagent transcript', new Error('Subagent session does not exist'), sessionId);
    const path = join(session.sessionFile.replace(/\.jsonl$/u, ''), `${subagentId}.jsonl`);
    try {
      return await this.omp.transcript(path);
    } catch (error) {
      throw runtimeError('subagent transcript', error, sessionId);
    }
  }
  async *streamSubagentTranscript(sessionId: string, subagentId: string, afterOrdinal: number, signal: AbortSignal): AsyncGenerator<{ ordinal: number; kind: string; payload: Record<string, unknown>; createdAt: string }> {
    let ordinal = Math.max(0, afterOrdinal);
    while (!signal.aborted) {
      const events = await this.subagentTranscript(sessionId, subagentId);
      for (const event of events) {
        if (event.ordinal <= ordinal) continue;
        ordinal = event.ordinal;
        yield event;
      }
      await Bun.sleep(200);
    }
  }


  async quiesceSpace(spaceId: string, requirePortableControls = false): Promise<void> {
    const session = this.list(spaceId)[0];
    const live = session ? this.live.get(session.id) : undefined;
    if (!session || !live) throw runtimeError('quiesce', new Error('Space session is not live'), session?.id);
    if (requirePortableControls) {
      const control = await live.runtime.control();
      if (control.pendingAsk || control.queue.steering.length > 0 || control.queue.followUp.length > 0) {
        throw runtimeError('quiesce', new Error('Pending asks and queued prompts must be resolved or cleared before provider replacement; cancel preparation to continue the session'), session.id);
      }
    }
    this.quiesced.add(session.id);
    const interrupted = await live.runtime.handoff();
    if (interrupted) {
      this.database.orm.update(agentSessions).set({ resumePending: true, updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, session.id)).run();
    }
    await Promise.all(this.activePrompts.get(session.id) ?? []);
  }

  resumeSpace(spaceId: string): void {
    const session = this.list(spaceId)[0];
    if (session && this.quiesced.delete(session.id)) {
      const live = this.live.get(session.id);
      if (live) this.resumeIfPending(session, live.runtime, live.capability);
    }
  }

  async capturePortableSpace(spaceId: string): Promise<{
    agent: CoordinatorPortableAgentSnapshot;
    artifacts: CoordinatorPortableArtifactSnapshot;
  }> {
    const session = this.list(spaceId)[0];
    if (!session) throw runtimeError('checkpoint', new Error('Space session does not exist'));
    const live = this.live.get(session.id);
    if (!live) throw runtimeError('checkpoint', new Error('Space session is not live'), session.id);
    if (!this.quiesced.has(session.id)) throw runtimeError('checkpoint', new Error('Space session is not quiesced'), session.id);
    const generation = await this.syncSessionArtifacts(live);
    await live.runtime.persist();
    const scope = this.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, spaceId)).get();
    if (!scope || scope.generation !== generation || (generation > 0 && !scope.manifestHash)) throw runtimeError('checkpoint artifacts', new Error('Durable artifact scope is missing'), session.id);
    const verified = await this.artifacts.verifyScope(scope);
    if (verified.status === 'error') throw runtimeError('checkpoint artifacts', verified.error, session.id);
    return {
      agent: {
        sessionId: session.id,
        ompSessionId: session.ompSessionId,
        ompSession: new Uint8Array(await readFile(session.sessionFile)),
        resumePending: this.get(session.id)?.resumePending ?? false,
      },
      artifacts: { generation, manifest: new TextEncoder().encode(JSON.stringify({ version: 2, scope })) },
    };
  }

  async deletePortableSpaceLocal(spaceId: string): Promise<void> {
    await this.assertManagedSpaceRoot(spaceId);
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('delete local space', new Error('Space does not exist'));
    await this.detachDependentWorktrees(spaceId);
    const session = this.list(spaceId)[0];
    if (session && session.state !== 'closed') {
      const closed = await this.close(session.id);
      if (closed.status === 'error') throw closed.error;
    }
    if (session) this.quiesced.delete(session.id);
    if (session) {
      await rm(session.sessionFile, { force: true });
      await rm(join(this.runtimeRoot, 'sessions', session.id), { recursive: true, force: true });
    }
    await rm(space.rootPath, { recursive: true, force: true });
  }

  async preparePortableSpaceRepository(spaceId: string): Promise<void> {
    await this.assertManagedSpaceRoot(spaceId);
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('prepare space', new Error('Space does not exist'));
    await this.detachDependentWorktrees(spaceId);
    // Never reset or reuse leftovers: failed saves and interrupted restores may contain unique work.
    // Keep them beside the fresh checkout so recovery is possible without exposing stale files to hooks.
    const existing = await lstat(space.rootPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (existing.isSymbolicLink()) throw runtimeError('prepare space', new Error('Refusing a symlink checkout'));
      await rename(space.rootPath, `${space.rootPath}.retained-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    }
    await mkdir(space.rootPath, { recursive: true });
    await this.portableGit(space.rootPath, ['init', '-b', space.branch]);
    const repositoryReference = this.database.getProject(space.projectId)?.repositoryReference;
    if (repositoryReference) await this.portableGit(space.rootPath, ['remote', 'add', 'origin', repositoryReference]);
  }

  private async portableGit(cwd: string, args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw runtimeError('portable repository', new Error(stderr.trim() || `git ${args[0]} exited with ${exitCode}`));
    return stdout.trim();
  }

  private async detachDependentWorktrees(spaceId: string): Promise<void> {
    const space = this.database.getSpace(spaceId)!;
    const metadata = await lstat(join(space.rootPath, '.git')).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!metadata?.isDirectory()) return;
    const common = await realpath(join(space.rootPath, '.git'));
    const basePath = await realpath(space.rootPath);
    const registered = await Promise.all(this.database.listSpaces(space.projectId).map(async (candidate) => ({
      space: candidate,
      path: await realpath(candidate.rootPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    })));
    const listing = await this.portableGit(space.rootPath, ['worktree', 'list', '--porcelain']);
    for (const entry of listing.split('\n').filter((line) => line.startsWith('worktree '))) {
      const checkout = entry.slice('worktree '.length);
      const checkoutPath = await realpath(checkout).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!checkoutPath || checkoutPath === basePath) continue;
      const child = registered.find((candidate) => candidate.path === checkoutPath)?.space;
      const insideBase = relative(basePath, checkoutPath);
      if (!child || (insideBase !== '..' && !insideBase.startsWith(`..${sep}`))) throw runtimeError('portable repository', new Error(`Dependent checkout ${checkout} must be moved outside the base into a managed space before removing the base`));
      await this.assertManagedSpaceRoot(child.id);
      const gitFile = join(checkout, '.git');
      const gitDirectory = await this.portableGit(checkout, ['rev-parse', '--absolute-git-dir']);
      const temporary = join(checkout, `.git-detach-${crypto.randomUUID()}`);
      const retained = `${gitFile}.retained-${crypto.randomUUID()}`;
      await cp(common, temporary, { recursive: true, filter: (source) => source !== join(common, 'worktrees') });
      try {
        await cp(gitDirectory, temporary, {
          recursive: true,
          filter: (source) => !['commondir', 'gitdir'].includes(relative(gitDirectory, source)),
        });
        await this.portableGit(checkout, ['config', '--file', join(temporary, 'config'), 'core.bare', 'false']);
        // Remove a shared core.worktree pointer, if present; an absent value is normal.
        const config = await readFile(join(temporary, 'config'), 'utf8');
        if (/^\s*worktree\s*=/mu.test(config)) await this.portableGit(checkout, ['config', '--file', join(temporary, 'config'), '--unset-all', 'core.worktree']);
        await rename(gitFile, retained);
        try { await rename(temporary, gitFile); }
        catch (error) { await rename(retained, gitFile); throw error; }
        await rm(retained);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }
  }

  async restorePortableSpace(input: {
    spaceId: string;
    agent: CoordinatorPortableAgentSnapshot;
    artifacts: CoordinatorPortableArtifactSnapshot;
  }): Promise<AgentSession> {
    const space = this.database.getSpace(input.spaceId);
    if (!space) throw runtimeError('restore space', new Error('Space metadata does not exist'));
    let session: AgentSession | null | undefined = this.list(input.spaceId)[0];
    if (!session) {
      const now = new Date().toISOString();
      this.database.orm.insert(agentSessions).values({
        id: input.agent.sessionId,
        spaceId: input.spaceId,
        ompSessionId: input.agent.ompSessionId,
        sessionFile: join(this.runtimeRoot, 'portable-sessions', `${input.agent.sessionId}.jsonl`),
        state: 'closed',
        lastEventOffset: 0,
        resumePending: input.agent.resumePending ?? false,
        activity: { active: false, reasons: [] },
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }).run();
      session = this.get(input.agent.sessionId);
    }
    if (!session) throw runtimeError('restore space', new Error('Agent projection could not be created'), input.agent.sessionId);
    if (session.id !== input.agent.sessionId || session.ompSessionId !== input.agent.ompSessionId) {
      throw runtimeError('restore space', new Error('Portable agent identity does not match canonical session'), session.id);
    }
    await mkdir(dirname(session.sessionFile), { recursive: true });
    await writeFile(session.sessionFile, input.agent.ompSession);
    this.liveTranscripts.delete(session.id);
    const transcript = await this.transcript(session.id);
    this.database.orm.update(agentSessions).set({
      state: 'closed',
      lastEventOffset: transcript.length,
      resumePending: input.agent.resumePending ?? false,
      activity: { active: false, reasons: [] },
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(agentSessions.id, session.id)).run();
    const artifactManifest = JSON.parse(new TextDecoder().decode(input.artifacts.manifest)) as { version: number; scope?: ArtifactScope };
    if (artifactManifest.version !== 2 || !artifactManifest.scope
      || artifactManifest.scope.spaceId !== input.spaceId
      || artifactManifest.scope.generation !== input.artifacts.generation) {
      throw runtimeError('restore artifacts', new Error('Legacy checkpoint has no durable artifact scope; recovery requires an explicit legacy reset or a new checkpoint from the intact machine'), session.id);
    }
    const restored = await this.artifacts.restoreScope(artifactManifest.scope);
    if (restored.status === 'error') throw runtimeError('restore artifacts', restored.error, session.id);
    this.quiesced.delete(session.id);
    // The controller starts the agent only after both cloud and local ownership commit.
    return this.get(session.id)!;
  }

  async reloadOmpSettings(): Promise<void> {
    await Promise.all([...this.live.values()].map((session) => session.runtime.reloadSettings?.() ?? Promise.resolve()));
  }

  async instructionsChanged(projectId: string, spaceId: string): Promise<void> {
    await Promise.all([...this.live.values()].filter((live) =>
      live.capability.projectId === projectId
      && (live.capability.kind === 'workspace' ? live.capability.workspaceId : live.capability.projectId) === spaceId,
    ).map((live) => live.runtime.instructionsChanged?.() ?? Promise.resolve()));
  }

  async refreshArtifacts(projectId: string, spaceId: string): Promise<void> {
    const live = [...this.live.values()].find((candidate) => candidate.capability.projectId === projectId
      && (candidate.capability.kind === 'workspace' ? candidate.capability.workspaceId : candidate.capability.projectId) === spaceId);
    if (!live) return;
    const next = (live.artifactSync ?? Promise.resolve(0)).catch(() => 0).then(async () => {
      await this.refreshCanonicalArtifacts(live);
      await this.refreshArtifactMount(live, live.capability.kind === 'workspace' ? 'workspace' : 'base', true);
      if (live.capability.kind === 'workspace') await this.refreshArtifactMount(live, 'base', false);
      return 0;
    });
    live.artifactSync = next;
    await next;
  }

  async publishArtifacts(spaceId: string): Promise<void> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Artifact space ${spaceId} does not exist`);
    const capability: ArtifactCapability = space.kind === 'base'
      ? { kind: 'project', projectId: space.projectId }
      : { kind: 'workspace', projectId: space.projectId, workspaceId: space.id };
    const url = space.kind === 'base' ? 'local://base/' : 'local://workspace/';
    const publish = async (): Promise<number> => {
      this.rememberArtifactPublicationBase(spaceId);
      const committed = await this.artifacts.commit(capability, url);
      if (committed.status === 'error') throw committed.error;
      const published = await this.publishArtifactScope(space.projectId, committed.value);
      this.events?.append({ projectId: space.projectId, scope: 'artifact', entity: 'artifact', entityId: url,
        revision: published.generation, operation: 'updated', payload: { spaceId } });
      return published.generation;
    };
    const live = [...this.live.values()].find((candidate) =>
      (candidate.capability.kind === 'workspace' ? candidate.capability.workspaceId : candidate.capability.projectId) === spaceId);
    if (live) {
      const next = (live.artifactSync ?? Promise.resolve(0)).catch(() => 0).then(publish);
      live.artifactSync = next;
      await next;
    } else await publish();
  }

  async stopForRestart(): Promise<ResultType<void, MachineSessionError>> {
    for (const sessionId of [...this.live.keys()]) {
      const stopped = await this.stopLive(sessionId, false);
      if (stopped.status === 'error') return stopped;
    }
    this.database.checkpoint();
    return Result.ok(undefined);
  }

  async close(sessionId: string): Promise<ResultType<void, MachineSessionError>> {
    if (this.live.has(sessionId)) return this.stopLive(sessionId, true);
    const session = this.get(sessionId);
    if (!session) return Result.err(runtimeError('close', new Error('Session does not exist'), sessionId));
    if (session.state === 'closed') return Result.ok(undefined);
    this.database.orm.update(agentSessions).set({
      state: 'closed',
      activity: { active: false, reasons: [] },
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(agentSessions.id, sessionId)).run();
    return Result.ok(undefined);
  }

  private spaceTarget(spaceId: string, allowOpening = false): ResultType<SessionTarget, SessionWorkspaceUnavailable | SessionProjectUnavailable | SessionPossessionDenied> {
    const space = this.database.getSpace(spaceId);
    if (!space) {
      return Result.err(new SessionWorkspaceUnavailable({ workspaceId: spaceId, message: `Space ${spaceId} does not exist` }));
    }
    const placement = this.database.getSpacePlacement(spaceId);
    const available = placement && placement.holderId === this.machineId && (placement.state === 'open' || (allowOpening && placement.state === 'opening'));
    if (!available) {
      return Result.err(new SessionPossessionDenied({
        workspaceId: spaceId,
        message: placement && placement.state === 'open'
          ? `Space ${spaceId} is possessed by ${placement.holderId}`
          : `Space ${spaceId} is not open`,
      }));
    }
    return space.kind === 'base'
      ? Result.ok({
          scope: 'project',
          projectId: space.projectId,
          workspaceId: null,
          workingDirectory: space.rootPath,
          sessionKey: `space:${space.id}`,
          capability: { kind: 'project', projectId: space.projectId },
        })
      : Result.ok({
          scope: 'workspace',
          projectId: space.projectId,
          workspaceId: space.id,
          workingDirectory: space.rootPath,
          sessionKey: `space:${space.id}`,
          capability: { kind: 'workspace', projectId: space.projectId, workspaceId: space.id },
        });
  }

  private async materializeArtifacts(
    capability: ArtifactCapability,
    artifactsDir: string,
  ): Promise<ResultType<Map<string, string>, SessionRuntimeError>> {
    const baseline = new Map<string, string>();
    const base = await this.artifacts.materialize(capability, 'local://base/', join(artifactsDir, 'base'), capability.kind === 'project' ? baseline : undefined);
    if (base.status === 'error') return Result.err(runtimeError('materialize', base.error));
    if (capability.kind === 'project') return Result.ok(baseline);
    const workspace = await this.artifacts.materialize(capability, 'local://workspace/', join(artifactsDir, 'workspace'), baseline);
    return workspace.status === 'error'
      ? Result.err(runtimeError('materialize', workspace.error))
      : Result.ok(baseline);
  }

  private async adopt(
    record: AgentSession,
    runtime: OmpRuntimeSession,
    artifactsDir: string,
    capability: ArtifactCapability,
    artifactBaseline: Map<string, string>,
  ): Promise<void> {
    let messages: unknown[];
    try {
      messages = await runtime.messages();
    } catch (error) {
      let failure = error;
      try {
        await runtime.dispose();
      } catch (disposeError) {
        failure = new AggregateError([error, disposeError], 'OMP session adoption and disposal failed');
      }
      this.database.orm.update(agentSessions).set({
        state: 'failed',
        activity: { active: false, reasons: [] },
        errorMessage: failure instanceof Error ? failure.message : String(failure),
        updatedAt: new Date().toISOString(),
      }).where(eq(agentSessions.id, record.id)).run();
      throw failure;
    }
    if (messages.length > 0 || !this.liveTranscripts.has(record.id)) {
      const createdAt = new Date().toISOString();
      this.liveTranscripts.set(record.id, messages.map((message, index) => ({
        ordinal: index + 1,
        kind: 'message_end',
        payload: { message },
        createdAt,
      })));
    }
    const unsubscribe = runtime.subscribe((event) => {
      this.appendEvent(record.id, event);
      if (event.type === 'tool_execution_end' || event.type === 'agent_end') {
        const live = this.live.get(record.id);
        if (live) void this.syncSessionArtifacts(live).catch((error) => {
          this.updateActivity(record.id, capability, runtime.activity().activity, `Artifact sync failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    const activityUnsubscribe = runtime.subscribeActivity((activity, errorMessage) => {
      this.updateActivity(record.id, capability, activity, errorMessage);
    });
    this.live.set(record.id, { recordId: record.id, runtime, artifactsDir, capability, artifactBaseline, artifactSync: null, unsubscribe, activityUnsubscribe });
  }

  private updateActivity(
    sessionId: string,
    capability: ArtifactCapability,
    activity: SessionActivity,
    errorMessage?: string,
  ): void {
    const recoverySawActivity = this.recoveringSessions.get(sessionId);
    if (recoverySawActivity !== undefined) {
      if (activity.active) this.recoveringSessions.set(sessionId, true);
      else if (recoverySawActivity) {
        this.recoveringSessions.delete(sessionId);
        this.completeResume(sessionId, capability);
      }
    }
    const now = new Date().toISOString();
    const current = this.database.orm.select({
      activity: agentSessions.activity,
      errorMessage: agentSessions.errorMessage,
    }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (current && JSON.stringify(current.activity) === JSON.stringify(activity) && (current.errorMessage ?? undefined) === errorMessage) return;
    this.database.orm.update(agentSessions).set({ activity, errorMessage: errorMessage ?? null, updatedAt: now })
      .where(eq(agentSessions.id, sessionId)).run();
    this.publishCanonicalSession(capability.projectId, sessionId);
    this.events?.append({
      projectId: capability.projectId,
      scope: 'session',
      entity: 'main-agent-activity',
      entityId: sessionId,
      revision: Date.now(),
      operation: 'updated',
      payload: {
        projectId: capability.projectId,
        workspaceId: capability.kind === 'workspace' ? capability.workspaceId : null,
        sessionScope: capability.kind,
        activity,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
  }

  private appendEvent(sessionId: string, event: OmpRuntimeEvent): void {
    const liveUpdate = event.type === 'message_update' || event.type === 'tool_execution_update';
    if (!liveUpdate && !PERSISTED_TRANSCRIPT_EVENTS[event.type]) return;
    let events = this.liveTranscripts.get(sessionId) ?? [];
    const serialized = serializableEvent(event);
    const toolCallId = typeof serialized.toolCallId === 'string' ? serialized.toolCallId : null;

    if (event.type === 'message_end') {
      events = events.filter((candidate) => candidate.kind !== 'message_update');
    } else if (event.type === 'tool_execution_end' && toolCallId) {
      events = events.filter((candidate) => candidate.kind !== 'tool_execution_update' || candidate.payload.toolCallId !== toolCallId);
    }
    if (!liveUpdate) events = events.map((candidate, index) => ({ ...candidate, ordinal: index + 1 }));

    if (liveUpdate) {
      const existingIndex = events.findIndex((candidate) => candidate.kind === event.type && (event.type !== 'tool_execution_update' || candidate.payload.toolCallId === toolCallId));
      const next = {
        ordinal: existingIndex >= 0 ? events[existingIndex]!.ordinal : events.length + 1,
        kind: event.type,
        payload: serialized,
        createdAt: new Date().toISOString(),
      };
      if (existingIndex >= 0) events[existingIndex] = next;
      else events.push(next);
      this.liveTranscripts.set(sessionId, events);
      this.database.orm.update(agentSessions).set({ lastEventOffset: events.length, updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, sessionId)).run();
      if (!this.transcriptUpdateTimers.has(sessionId)) {
        this.transcriptUpdateTimers.set(sessionId, setTimeout(() => {
          this.transcriptUpdateTimers.delete(sessionId);
          const capability = this.live.get(sessionId)?.capability;
          if (!capability) return;
          this.events?.append({
            projectId: capability.projectId,
            scope: 'session',
            entity: 'transcript',
            entityId: sessionId,
            revision: Date.now(),
            operation: 'updated',
            payload: { kind: event.type },
          });
        }, 50));
      }
      return;
    }

    const pendingTimer = this.transcriptUpdateTimers.get(sessionId);
    clearTimeout(pendingTimer);
    this.transcriptUpdateTimers.delete(sessionId);
    const ordinal = events.length + 1;
    events.push({ ordinal, kind: event.type, payload: serialized, createdAt: new Date().toISOString() });
    this.liveTranscripts.set(sessionId, events);
    this.database.orm.update(agentSessions).set({ lastEventOffset: ordinal, updatedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, sessionId)).run();
    const capability = this.live.get(sessionId)?.capability;
    if (capability) {
      this.events?.append({
        projectId: capability.projectId,
        scope: 'session',
        entity: 'transcript',
        entityId: sessionId,
        revision: ordinal,
        operation: 'append',
        payload: { fromOffset: ordinal, toOffset: ordinal, kind: event.type },
      });
    }
  }

  private syncSessionArtifacts(live: LiveSession): Promise<number> {
    const previous = live.artifactSync ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(() => this.performArtifactSync(live));
    live.artifactSync = next;
    return next;
  }

  private rememberArtifactPublicationBase(spaceId: string): void {
    if (this.artifactPublicationBases.has(spaceId)) return;
    const scope = this.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, spaceId)).get();
    if (scope) this.artifactPublicationBases.set(spaceId, { ...scope, dirty: false });
  }

  private async publishArtifactScope(projectId: string, local: ArtifactScope): Promise<ArtifactScope> {
    try {
      await this.artifactManifests?.synchronizeArtifactScope(projectId, local);
      this.artifactPublicationBases.delete(local.spaceId);
      return local;
    } catch (error) {
      const base = this.artifactPublicationBases.get(local.spaceId);
      const current = (await this.artifactManifests?.listArtifactScopes?.(projectId))?.find((scope) => scope.workspaceId === local.spaceId);
      if (!base || !current) throw error;
      if (current.generation === local.generation && current.manifestHash === local.manifestHash) {
        this.artifactPublicationBases.delete(local.spaceId);
        return local; // The failed response may still have committed.
      }
      if (current.generation < local.generation) throw error;
      const canonical: ArtifactScope = { id: current.id, spaceId: current.workspaceId, generation: current.generation,
        manifestHash: current.manifestHash, dirty: false, createdAt: current.updatedAt, updatedAt: current.updatedAt };
      const reconciled = await this.artifacts.reconcileScope({ base, local, canonical });
      if (reconciled.status === 'error') throw reconciled.error;
      this.artifactPublicationBases.set(local.spaceId, canonical);
      await this.artifactManifests!.synchronizeArtifactScope(projectId, reconciled.value);
      this.artifactPublicationBases.delete(local.spaceId);
      return reconciled.value;
    }
  }

  private async refreshCanonicalArtifacts(live: LiveSession): Promise<void> {
    const scopes = await this.artifactManifests?.listArtifactScopes?.(live.capability.projectId);
    if (!scopes) return;
    const writableSpace = live.capability.kind === 'workspace' ? live.capability.workspaceId : live.capability.projectId;
    for (const scope of scopes) {
      if (scope.workspaceId !== writableSpace && scope.workspaceId !== live.capability.projectId) continue;
      const local = this.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, scope.workspaceId)).get();
      if (local && this.artifactPublicationBases.has(local.spaceId) && !local.dirty
        && local.manifestHash !== scope.manifestHash && scope.generation >= local.generation) {
        await this.publishArtifactScope(live.capability.projectId, local);
        continue;
      }
      if (local && local.generation >= scope.generation) {
        if (local.generation === scope.generation && local.manifestHash !== scope.manifestHash) throw new Error('Canonical artifact scope diverged from the local manifest');
        continue;
      }
      if (local?.dirty) throw new Error('Canonical artifact scope changed while local artifacts were dirty');
      const restored = await this.artifacts.restoreScope({ id: scope.id, spaceId: scope.workspaceId, generation: scope.generation,
        manifestHash: scope.manifestHash, dirty: false, createdAt: scope.updatedAt, updatedAt: scope.updatedAt });
      if (restored.status === 'error') throw restored.error;
    }
  }

  private async performArtifactSync(live: LiveSession): Promise<number> {
    await this.refreshCanonicalArtifacts(live);
    const artifactScope = live.capability.kind === 'workspace' ? 'workspace' : 'base';
    const artifactRoot = join(live.artifactsDir, artifactScope);
    const artifactUrl = `local://${artifactScope}/`;
    this.rememberArtifactPublicationBase(live.capability.kind === 'workspace' ? live.capability.workspaceId : live.capability.projectId);
    const materialized = await filesUnder(artifactRoot);
    const present = new Set(materialized.map((path) => relative(artifactRoot, path).split('\\').join('/')));
    const journal = this.artifacts.list(live.capability, artifactUrl);
    if (journal.status === 'error') throw journal.error;
    const canonical = new Map(journal.value.map((entry) => [entry.path, entry]));
    // A session mount is a snapshot, not authority over later Inspector or session writes.
    for (const [path, hash] of live.artifactBaseline) {
      if (present.has(path)) continue;
      const entry = canonical.get(path);
      if (entry) {
        const current = await this.artifacts.read(live.capability, entry.url);
        if (current.status === 'error') throw current.error;
        if (`sha256:${createHash('sha256').update(current.value).digest('hex')}` !== hash) {
          throw new Error(`Artifact ${entry.url} changed outside this session; refusing a stale deletion`);
        }
        const removed = this.artifacts.remove(live.capability, entry.url);
        if (removed.status === 'error') throw removed.error;
      }
      live.artifactBaseline.delete(path);
    }
    for (const path of materialized) {
      const artifactPath = relative(artifactRoot, path).split('\\').join('/');
      const bytes = await readFile(path);
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (live.artifactBaseline.get(artifactPath) === hash) continue;
      const canonicalEntry = canonical.get(artifactPath);
      const baseline = live.artifactBaseline.get(artifactPath);
      if (canonicalEntry) {
        const current = await this.artifacts.read(live.capability, canonicalEntry.url);
        if (current.status === 'error') throw current.error;
        const currentHash = `sha256:${createHash('sha256').update(current.value).digest('hex')}`;
        if (currentHash !== baseline && currentHash !== hash) throw new Error(`Artifact ${canonicalEntry.url} changed outside this session; refusing a stale write`);
      } else if (baseline !== undefined) {
        throw new Error(`Artifact ${artifactUrl}${artifactPath} was removed outside this session; refusing a stale write`);
      }
      const written = await this.artifacts.write(live.capability, `${artifactUrl}${artifactPath}`, bytes);
      if (written.status === 'error') throw written.error;
      live.artifactBaseline.set(artifactPath, hash);
    }
    const committed = await this.artifacts.commit(live.capability, artifactUrl);
    if (committed.status === 'error') throw committed.error;
    const published = await this.publishArtifactScope(live.capability.projectId, committed.value);
    await this.refreshArtifactMount(live, artifactScope, true);
    if (live.capability.kind === 'workspace') await this.refreshArtifactMount(live, 'base', false);
    this.events?.append({
      projectId: live.capability.projectId, scope: 'artifact', entity: 'artifact', entityId: artifactUrl,
      revision: published.generation, operation: 'updated',
      payload: { spaceId: live.capability.kind === 'workspace' ? live.capability.workspaceId : live.capability.projectId },
    });
    return published.generation;
  }

  private async refreshArtifactMount(live: LiveSession, mount: 'base' | 'workspace', writable: boolean): Promise<void> {
    const listed = this.artifacts.list(live.capability, `local://${mount}/`);
    if (listed.status === 'error') throw listed.error;
    const paths = new Set(listed.value.map((entry) => entry.path));
    for (const entry of listed.value) {
      const path = join(live.artifactsDir, mount, entry.path);
      const bytes = await this.artifacts.read(live.capability, entry.url);
      if (bytes.status === 'error') throw bytes.error;
      const canonicalHash = `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`;
      if (writable) {
        let current: Buffer | null = null;
        try { current = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const currentHash = current ? `sha256:${createHash('sha256').update(current).digest('hex')}` : undefined;
        const baseline = live.artifactBaseline.get(entry.path);
        // A tool may have written again while its preceding sync uploaded. Never overwrite that work.
        if (currentHash !== baseline && currentHash !== canonicalHash) continue;
        if (currentHash === canonicalHash) { live.artifactBaseline.set(entry.path, canonicalHash); continue; }
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes.value);
      if (writable) live.artifactBaseline.set(entry.path, canonicalHash);
    }
    if (writable) {
      for (const [path, baseline] of live.artifactBaseline) {
        if (paths.has(path)) continue;
        const mounted = join(live.artifactsDir, mount, path);
        try {
          const bytes = await readFile(mounted);
          if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== baseline) continue;
          await rm(mounted);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        live.artifactBaseline.delete(path);
      }
    }
  }

  private async stopLive(sessionId: string, close: boolean): Promise<ResultType<void, MachineSessionError>> {
    const live = this.live.get(sessionId);
    if (!live) return close
      ? Result.err(runtimeError('close', new Error('Session is not live'), sessionId))
      : Result.ok(undefined);
    try {
      this.quiesced.add(sessionId);
      const record = this.get(sessionId);
      const activity = record?.activity;
      const transcript = await this.transcript(sessionId);
      const lastMessage = [...transcript].reverse().find((event) => event.kind === 'message_end')?.payload.message;
      const transcriptNeedsContinuation = !!lastMessage && typeof lastMessage === 'object' && 'role' in lastMessage && lastMessage.role === 'user';
      const wasExecuting = this.activePrompts.has(sessionId)
        || transcriptNeedsContinuation
        || activity?.reasons.some((reason) => reason.kind === 'turn' || reason.kind === 'compacting') === true;
      const runtimeInterrupted = close ? false : await live.runtime.handoff();
      await Promise.all(this.activePrompts.get(sessionId) ?? []);
      const resumePending = close ? record?.resumePending === true : wasExecuting || runtimeInterrupted;
      this.database.orm.update(agentSessions).set({ state: 'draining', resumePending, updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, sessionId)).run();
      await this.syncSessionArtifacts(live);
      await live.runtime.persist();
      live.unsubscribe();
      live.activityUnsubscribe();
      await live.runtime.dispose();
      this.live.delete(sessionId);
      this.quiesced.delete(sessionId);
      this.database.orm.update(agentSessions).set({
        state: close ? 'closed' : 'active',
        resumePending,
        ...(close ? { activity: { active: false, reasons: [] }, errorMessage: null } : {}),
        updatedAt: new Date().toISOString(),
      }).where(eq(agentSessions.id, sessionId)).run();
      this.publishCanonicalSession(live.capability.projectId, sessionId, true);
      return Result.ok(undefined);
    } catch (error) {
      this.database.orm.update(agentSessions).set({ state: 'failed', updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, sessionId)).run();
      return Result.err(runtimeError(close ? 'close' : 'restart', error, sessionId));
    }
  }

  private completeResume(sessionId: string, capability: ArtifactCapability): void {
    const record = this.get(sessionId);
    if (!record?.resumePending) return;
    this.database.orm.update(agentSessions).set({ resumePending: false, errorMessage: null, updatedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, sessionId)).run();
    this.publishCanonicalSession(capability.projectId, sessionId);
    this.events?.append({
      projectId: capability.projectId,
      scope: 'session',
      entity: 'main-agent',
      entityId: sessionId,
      revision: Date.now(),
      operation: 'updated',
      payload: { spaceId: record.spaceId, resumed: true },
    });
  }

  private resumeIfPending(record: AgentSession, runtime: OmpRuntimeSession, capability: ArtifactCapability): void {
    if (!record.resumePending) return;
    this.recoveringSessions.set(record.id, false);
    void runtime.resume().then(() => {
      this.recoveringSessions.delete(record.id);
      this.completeResume(record.id, capability);
    }).catch((error) => {
      this.recoveringSessions.delete(record.id);
      this.database.orm.update(agentSessions).set({
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }).where(eq(agentSessions.id, record.id)).run();
    });
  }
  private async assertManagedSpaceRoot(spaceId: string): Promise<void> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('managed space', new Error('Space does not exist'));
    const root = resolve(this.managedSpaceRoot);
    const local = relative(root, resolve(space.rootPath));
    if (local === '' || local === '..' || local.startsWith(`..${sep}`)) {
      throw runtimeError('managed space', new Error(`Refusing to delete unmanaged space root ${space.rootPath}`));
    }
    const metadata = await lstat(space.rootPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (metadata?.isSymbolicLink()) throw runtimeError('managed space', new Error('Refusing a symlink checkout'));
    const actualRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? root : Promise.reject(error));
    const actualCheckout = await realpath(space.rootPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      const parent = await realpath(dirname(space.rootPath)).catch((parentError: NodeJS.ErrnoException) => parentError.code === 'ENOENT' ? dirname(space.rootPath) : Promise.reject(parentError));
      return join(parent, relative(dirname(space.rootPath), space.rootPath));
    });
    const actual = relative(actualRoot, actualCheckout);
    if (actual === '' || actual === '..' || actual.startsWith(`..${sep}`)) throw runtimeError('managed space', new Error('Checkout resolves outside the managed root'));
  }
  private publishCanonicalSession(projectId: string, sessionId: string, checkpoint = false): void {
    const session = this.get(sessionId);
    if (session) this.canonicalSessions?.put(projectId, this.machineId, session, checkpoint);
  }

}
