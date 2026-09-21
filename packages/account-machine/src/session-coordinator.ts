import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseTitleSlotLine } from '@oh-my-pi/pi-coding-agent/session/session-title-slot';
import {
  LocalArtifactResolver,
  agentSessions,
  artifactScopes,
  factEvents,
  type AgentSession,
  type ArtifactCapability,
  type ArtifactScope,
  type GitSpaceDatabase,
  type ProjectEventWriter,
} from '@gitspace/core';
import type { AgentSetupView, CanonicalArtifactScope, CanonicalSession, SaveAgentDefinitionInput } from '@gitspace/protocol';
import { AgentDomainError, agentCheckpointFailure, agentFailure, agentIssueFailure, agentOperationIssue, agentPlacementFailure, beginAgentOperation, currentAgentFailure, deriveAgentReadiness, disconnectedAgentActivity, hasExecutingTurn, resumeAccepted, settleAgentOperation, SessionPossessionDenied, SessionWorkspaceUnavailable, type AgentFailure, type AgentIncidentChange, type AgentIssue, type AgentOperationToken, type MachineSessionError, type SessionActivity, type SessionHistoryPage, type SessionHistoryPageRequest } from '@gitspace/protocol-agent';
import { AGENT_ISSUE_FAILURE_CODES, SessionProjectUnavailable } from '@gitspace/protocol-agent';
import { WorkspaceDomainError, type WorkspaceFailure } from '@gitspace/protocol-workspace';
import { and, eq, inArray } from 'drizzle-orm';
import { Result, type Result as ResultType } from 'better-result';
import type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpSessionControlView, OmpTranscriptEvent } from './omp-runtime.js';
import type { PendingAskAnswer } from '../../account-omp/src/ask-bridge.js';
import { buildSessionUsageReport, type SessionUsageReport } from './session-usage-report.js';
import type { TranscriptPageRequest, TranscriptPage, TranscriptContentRequest, TranscriptContentPage } from '@gitspace/blocks';
import { TranscriptIndex } from './transcript-index.js';
import { withArtifactSyncDiagnostics } from './cloud-request-diagnostics.js';


interface SessionArtifacts {
  recordId: string;
  artifactsDir: string;
  capability: ArtifactCapability;
  artifactBaseline: Map<string, string>;
  artifactSync: Promise<number> | null;
  queuedArtifactSync: Promise<number> | null;
}

interface LiveSession extends SessionArtifacts {
  runtime: OmpRuntimeSession;
  generation: number;
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
  if (!(await lstat(current)).isDirectory()) throw new Error(`Artifact mount ${current} is not a directory`);
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Artifact ${path} is not a regular file; refusing an incomplete checkpoint`);
  }
  return files;
}

function runtimeError(operation: string, error: unknown, sessionId?: string): MachineSessionError {
  if (error instanceof SessionPossessionDenied || error instanceof SessionWorkspaceUnavailable || error instanceof AgentDomainError) return error;
  return new AgentDomainError(agentFailure(error, 'AGENT_RUNTIME_FAILED', { operation, ...(sessionId ? { sessionId } : {}) }));
}

async function retainedSessionBytes(session: AgentSession): Promise<Uint8Array> {
  if (!(await lstat(session.sessionFile)).isFile()) throw new Error('Retained session is not a regular file');
  const bytes = await readFile(session.sessionFile);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter((line) => line.trim());
  let headerSeen = false;
  let version = 1;
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (index === 0 && parseTitleSlotLine(line)) continue;
    const entry: unknown = JSON.parse(line);
    if (!entry || typeof entry !== 'object' || !('type' in entry) || typeof entry.type !== 'string' || !entry.type) {
      throw new Error(`Retained session has an invalid entry at line ${index + 1}`);
    }
    if (!headerSeen) {
      if (entry.type !== 'session' || !('id' in entry) || entry.id !== session.ompSessionId
        || ('version' in entry && (typeof entry.version !== 'number' || !Number.isInteger(entry.version) || entry.version < 1))) {
        throw new Error('Retained session header does not match the canonical OMP session');
      }
      version = 'version' in entry ? entry.version as number : 1;
      headerSeen = true;
      continue;
    }
    if (entry.type === 'session' || (entry.type === 'message'
      && (!('message' in entry) || !entry.message || typeof entry.message !== 'object'
        || !('role' in entry.message) || typeof entry.message.role !== 'string'))) {
      throw new Error(`Retained session has an invalid entry at line ${index + 1}`);
    }
    if (version >= 2) {
      if (!('id' in entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
        || !('parentId' in entry) || (entry.parentId !== null && typeof entry.parentId !== 'string')
        || !('timestamp' in entry) || typeof entry.timestamp !== 'string') {
        throw new Error(`Retained session has an invalid journal identity at line ${index + 1}`);
      }
      ids.add(entry.id);
    }
  }
  if (!headerSeen) throw new Error('Retained session header is missing');
  return bytes;
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
  get(projectId: string, sessionId: string): Promise<CanonicalSession | null>;
  put(projectId: string, machineId: string, session: AgentSession, checkpoint?: boolean): void;
  flush?(): Promise<void>;
}

export interface ArtifactManifestAuthority {
  synchronizeArtifactScope(projectId: string, scope: ArtifactScope): Promise<unknown>;
  listArtifactScopes?(projectId: string): Promise<CanonicalArtifactScope[]>;
}


export class MachineSessionCoordinator {
  private readonly liveTranscripts = new Map<string, TranscriptIndex>();
  private readonly transcriptIndexes = new Map<string, TranscriptIndex>();
  private readonly transcriptUpdateTimers = new Map<string, Timer>();
  private readonly live = new Map<string, LiveSession>();
  private readonly quiesced = new Set<string>();
  private readonly activePrompts = new Map<string, Set<Promise<void>>>();
  private readonly recoveringSessions = new Set<string>();
  private readonly artifactPublicationBases = new Map<string, ArtifactScope>();
  private readonly opening = new Map<string, Promise<ResultType<AgentSession, MachineSessionError>>>();
  private readonly retainedArtifacts = new Map<string, SessionArtifacts>();
  private readonly runtimeId = crypto.randomUUID();
  private readonly recoveryControllers = new Map<string, AbortController>();
  private readonly automaticAttempts = new Set<string>();
  private readonly disposalFences = new Map<string, OmpRuntimeSession>();

  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly artifacts: LocalArtifactResolver,
    private readonly omp: OmpRuntime,
    private readonly machineId: string,
    private readonly runtimeRoot: string,
    private readonly events?: ProjectEventWriter & { flush?(): Promise<void> },
    private readonly managedSpaceRoot: string = dirname(runtimeRoot),
    private readonly canonicalSessions?: CanonicalSessionWriter,
    private readonly artifactManifests?: ArtifactManifestAuthority,
    private readonly ompSessionRoot: string = join(dirname(runtimeRoot), 'omp-sessions'),
    private readonly recoveryTimeoutMs = 30_000,
  ) {}

  async create(workspaceId: string): Promise<ResultType<AgentSession, MachineSessionError>> {
    return this.openSpace(workspaceId);
  }

  async createProject(projectId: string): Promise<ResultType<AgentSession, MachineSessionError>> {
    if (!this.database.getProject(projectId)) return Result.err(new SessionProjectUnavailable({ projectId, message: `Project ${projectId} does not exist` }));
    return this.openSpace(projectId);
  }

  async openSpace(spaceId: string, allowOpening = false, expectedGeneration?: number, operation = 'open'): Promise<ResultType<AgentSession, MachineSessionError>> {
    const target = this.spaceTarget(spaceId, allowOpening);
    if (target.status === 'error') return target;
    if (this.database.listSpaceCleanupJobs().some((job) => job.spaceId === spaceId)) {
      return Result.err(runtimeError(operation, new Error('Space cleanup supersedes agent recovery')));
    }
    const placement = this.database.getSpacePlacement(spaceId)!;
    if (expectedGeneration !== undefined && placement.generation !== expectedGeneration) {
      return Result.err(new SessionPossessionDenied({ workspaceId: spaceId, message: 'Space placement changed before agent retry' }));
    }
    const pending = this.opening.get(spaceId);
    if (pending) return pending;
    // Reserve the slot before any operation can publish or yield.
    const opening = Promise.resolve().then(() => this.createTarget(target.value, placement.generation, allowOpening, operation))
      .catch((error) => Result.err(runtimeError(operation, error)));
    this.opening.set(spaceId, opening);
    try { return await opening; }
    finally { if (this.opening.get(spaceId) === opening) this.opening.delete(spaceId); }
  }

  private async createTarget(target: SessionTarget, generation: number, allowOpening: boolean, operation: string): Promise<ResultType<AgentSession, MachineSessionError>> {
    const spaceId = target.scope === 'workspace' ? target.workspaceId : target.projectId;
    const existing = this.list(spaceId)[0];
    if (existing && this.controlsAvailable(existing.id)) return Result.ok(existing);
    if (existing && this.quiesced.has(existing.id)) return Result.err(runtimeError(operation, new Error('Session is quiescing'), existing.id));
    this.assertSessionPlacement(spaceId, generation, allowOpening);
    const recordId = existing?.id ?? crypto.randomUUID();
    let recoveryToken = this.beginOperation(spaceId, 'recovery');
    let runtime: OmpRuntimeSession | undefined;
    let savedSession: Uint8Array | undefined;
    const controller = new AbortController();
    this.recoveryControllers.set(spaceId, controller);
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(new Error(`Agent ${operation} exceeded its recovery deadline`)), this.recoveryTimeoutMs);
    const check = () => {
      controller.signal.throwIfAborted();
      this.assertSessionPlacement(spaceId, generation, allowOpening);
      const current = this.get(recordId);
      if (current && current.health.issues.recovery?.operationId !== recoveryToken.operationId) throw new Error('Agent recovery was superseded');
    };
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      check();
      let aborted!: () => void;
      const timeout = new Promise<never>((_, reject) => {
        aborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', aborted, { once: true });
      });
      try { const value = await Promise.race([work, timeout]); check(); return value; }
      finally { controller.signal.removeEventListener('abort', aborted); }
    };
    const claim = (record: AgentSession) => {
      const issue = record.health.issues.recovery!;
      this.commitAgentState(record, { health: { ...record.health, issues: { ...record.health.issues, recovery: { ...issue, attempt: {
        runtimeId: this.runtimeId, machineId: this.machineId, generation,
        startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(startedAt + this.recoveryTimeoutMs).toISOString(),
        state: 'running', number: (existing?.health.issues.recovery?.attempt?.number ?? 0) + 1,
      } } } } });
    };
    if (existing) claim(this.get(recordId)!);
    try {
      if (existing) {
        await this.disposeUnusableSession(existing.id);
        check();
        savedSession = await bounded(retainedSessionBytes(existing));
      }
      const retainedFailure = existing?.health.issues.execution?.failure;
      const state = await bounded(this.prepareSessionArtifacts(recordId, target.capability, !!existing, check));
      const input = {
        projectId: target.projectId,
        workspaceId: target.scope === 'workspace' ? target.workspaceId : null,
        workingDirectory: target.workingDirectory,
        sessionKey: target.sessionKey,
        artifactsDir: state.artifactsDir,
        executionFailure: retainedFailure?.domain === 'agent' ? retainedFailure : null,
      };
      this.assertSessionPlacement(spaceId, generation, allowOpening);
      runtime = existing ? await this.omp.open({ ...input, sessionFile: existing.sessionFile }, controller.signal) : await this.omp.create(input, controller.signal);
      check();
      if (existing && runtime.id !== existing.ompSessionId) {
        throw new Error(`OMP session id changed from ${existing.ompSessionId} to ${runtime.id}`);
      }
      if (existing && resolve(runtime.sessionFile) !== resolve(existing.sessionFile)) {
        throw new Error('OMP opened a different session file instead of the retained canonical history');
      }
      const now = new Date().toISOString();
      const record = existing ?? this.database.orm.insert(agentSessions).values({
        id: recordId, spaceId, ompSessionId: runtime.id, sessionFile: runtime.sessionFile,
        state: 'opening', lastEventOffset: 0, createdAt: now, updatedAt: now,
      }).returning().get();
      if (!existing) {
        const begun = beginAgentOperation(record.health, 'recovery', recoveryToken.operationId);
        this.commitAgentState(record, { health: begun.state });
        recoveryToken = begun.token;
        claim(this.get(recordId)!);
      }
      this.assertSessionPlacement(spaceId, generation, allowOpening);
      await bounded(this.adopt(record, runtime, state.artifactsDir, target.capability, state.artifactBaseline, generation, check));
      this.assertSessionPlacement(spaceId, generation, allowOpening);
      if (!runtime.isAvailable()) throw new AgentDomainError(runtime.activity().failure ?? { domain: 'agent', code: 'AGENT_DISCONNECTED', message: 'OMP worker disconnected while opening the session', context: { sessionId: recordId } });
      if (this.quiesced.has(recordId)) throw new Error('Space began closing while the agent was opening');
      const current = this.get(recordId)!;
      this.commitAgentState(current, { state: 'active' });
      this.recoverIssue(spaceId, 'connection');
      await bounded(this.resumeIfPending(record, runtime, target.capability));
      this.settleOperation(spaceId, recoveryToken, null);
      this.publishCanonicalSession(target.projectId, record.id, true);
      return Result.ok(this.get(recordId)!);
    } catch (error) {
      let failure = error;
      if (runtime) {
        try { await this.disposeSessionRuntime(recordId, runtime); }
        catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'Agent opening and cleanup failed'); }
      }
      // A stale owner may not overwrite the newly claimed session projection.
      if (existing && savedSession) {
        try {
          const currentBytes = await readFile(existing.sessionFile).catch((readError: NodeJS.ErrnoException) =>
            readError.code === 'ENOENT' ? null : Promise.reject(readError));
          if (!currentBytes?.equals(savedSession)) {
            const current = this.database.getSpacePlacement(spaceId);
            const retainedPath = `${existing.sessionFile}.failed-open-${crypto.randomUUID()}`;
            if (!runtime?.isAvailable() && current?.holderId === this.machineId && current.generation === generation) {
              if (currentBytes) await rename(existing.sessionFile, retainedPath);
              await writeFile(existing.sessionFile, savedSession, { flag: 'wx' });
            } else {
              await writeFile(retainedPath, savedSession, { flag: 'wx' });
              failure = new AggregateError([failure, new Error(`Pre-retry history was retained at ${retainedPath}`)], 'Agent recovery did not complete');
            }
          }
        } catch (restoreError) {
          failure = new AggregateError([failure, restoreError], 'Agent opening and retained-history recovery failed');
        }
      }
      const current = this.database.getSpacePlacement(spaceId);
      if (current?.holderId === this.machineId && current.generation === generation) {
        this.recordFailure(spaceId, operation, failure, recoveryToken);
      }
      return Result.err(runtimeError(operation, failure, recordId));
    } finally {
      clearTimeout(timer);
      if (this.recoveryControllers.get(spaceId) === controller) this.recoveryControllers.delete(spaceId);
    }
  }

  private assertSessionPlacement(spaceId: string, generation: number, allowOpening: boolean): void {
    const current = this.database.getSpacePlacement(spaceId);
    const denied = agentPlacementFailure(spaceId, current, this.machineId, { generation, allowOpening });
    if (denied) throw denied;
    if (this.database.listSpaceCleanupJobs().some((job) => job.spaceId === spaceId)) throw new Error('Space cleanup supersedes agent recovery');
  }

  async recover(spaceId?: string): Promise<ResultType<AgentSession[], MachineSessionError>> {
    const recoverable = this.database.orm.select().from(agentSessions)
      .where(and(inArray(agentSessions.state, ['opening', 'active', 'draining', 'failed']), spaceId ? eq(agentSessions.spaceId, spaceId) : undefined))
      .orderBy(agentSessions.createdAt, agentSessions.id).all();
    const recovered: AgentSession[] = [];
    for (const record of recoverable) {
      if (record.state === 'failed' && !record.resumePending) continue;
      if (this.database.listSpaceCleanupJobs().some((job) => job.spaceId === record.spaceId)) continue;
      const placement = this.database.getSpacePlacement(record.spaceId);
      if (!placement || placement.holderId !== this.machineId || placement.state !== 'open' || placement.generation < 1) continue;
      const attemptKey = `${record.id}:${placement.generation}`;
      if (this.automaticAttempts.has(attemptKey)) continue;
      this.automaticAttempts.add(attemptKey);
      const result = await this.openSpace(record.spaceId, false, placement.generation, 'recover');
      if (result.status === 'error') {
        const current = this.database.getSpacePlacement(record.spaceId);
        if (current?.holderId !== this.machineId || current.generation !== placement.generation || current.state !== 'open') continue;
        return result;
      }
      recovered.push(result.value);
    }
    return Result.ok(recovered);
  }

  async prompt(sessionId: string, text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<ResultType<boolean, MachineSessionError>> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) return Result.err(runtimeError('prompt', new Error('Session is not live'), sessionId));
    if (this.quiesced.has(sessionId)) return Result.err(runtimeError('prompt', new Error('Session is quiescing'), sessionId));
    const spaceId = this.get(sessionId)!.spaceId;
    const promptToken = this.beginOperation(spaceId, 'execution');
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
      this.recordFailure(spaceId, 'prompt', error, promptToken);
      unsubscribeAcknowledgement();
      return Result.err(runtimeError('prompt', error, sessionId));
    }
    const pending = this.activePrompts.get(sessionId) ?? new Set<Promise<void>>();
    const finalization = execution.then(async (forwarded) => {
      this.settleOperation(spaceId, promptToken, null);
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
      this.recordFailure(spaceId, 'prompt', error, promptToken);
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
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('read session controls', new Error('Session is not active'), sessionId);
    return live.runtime.control();
  }

  async agentSetup(sessionId: string): Promise<AgentSetupView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('read agent setup', new Error('Session is not active'), sessionId);
    return { ...await live.runtime.agentSetup(), sessionId };
  }

  async saveAgentDefinition(sessionId: string, input: SaveAgentDefinitionInput): Promise<AgentSetupView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('save agent definition', new Error('Session is not active'), sessionId);
    return { ...await live.runtime.saveAgentDefinition(input), sessionId };
  }

  async cycleRole(sessionId: string, direction: 'forward' | 'backward'): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('cycle session role', new Error('Session is not active'), sessionId);
    return live.runtime.cycleRole(direction);
  }


  async setModel(sessionId: string, provider: string, model: string): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('set session model', new Error('Session is not active'), sessionId);
    return live.runtime.setModel(provider, model);
  }
  async setThinking(sessionId: string, thinking: string | null): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('set session thinking', new Error('Session is not active'), sessionId);
    return live.runtime.setThinking(thinking);
  }

  async setFast(sessionId: string, enabled: boolean): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('set session fast mode', new Error('Session is not active'), sessionId);
    return live.runtime.setFast(enabled);
  }

  async setApproval(sessionId: string, approvalMode: 'always-ask' | 'write' | 'yolo'): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('set session approval', new Error('Session is not active'), sessionId);
    return live.runtime.setApproval(approvalMode);
  }

  async setGoal(sessionId: string, input: { enabled: boolean; objective?: string }): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('set session goal', new Error('Session is not active'), sessionId);
    return live.runtime.setGoal(input);
  }

  async compact(sessionId: string, instructions?: string): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('compact session', new Error('Session is not active'), sessionId);
    return live.runtime.compact(instructions);
  }

  async clearQueue(sessionId: string): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('clear session queue', new Error('Session is not active'), sessionId);
    return live.runtime.clearQueue();
  }
  async removeQueuedMessage(sessionId: string, kind: 'steering' | 'followUp', index: number): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('remove queued message', new Error('Session is not active'), sessionId);
    return live.runtime.removeQueuedMessage(kind, index);
  }

  async promoteQueuedMessage(sessionId: string, index: number): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('steer queued message', new Error('Session is not active'), sessionId);
    return live.runtime.promoteQueuedMessage(index);
  }

  async answerAsk(sessionId: string, id: string, answers: readonly PendingAskAnswer[]): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('answer ask request', new Error('Session is not active'), sessionId);
    return live.runtime.answerAsk(id, answers);
  }

  async stop(sessionId: string): Promise<OmpSessionControlView> {
    const session = this.get(sessionId);
    if (session && this.opening.has(session.spaceId)) {
      this.quiesced.add(sessionId);
      this.recoveryControllers.get(session.spaceId)?.abort(new Error('Stop superseded agent recovery'));
      await this.opening.get(session.spaceId);
      this.quiesced.delete(sessionId);
      const current = this.get(sessionId);
      if (current) this.commitAgentState(current, { resumePending: false });
    }
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('stop session turn', new Error('Session is not active'), sessionId);
    return live.runtime.stop();
  }

  async navigateTree(sessionId: string, entryId: string): Promise<OmpSessionControlView> {
    const live = this.controlsAvailable(sessionId) ? this.live.get(sessionId) : undefined;
    if (!live) throw runtimeError('navigate session tree', new Error('Session is not active'), sessionId);
    const control = await live.runtime.navigateTree(entryId);
    await live.runtime.persist();
    const index = this.indexFor(sessionId, sessionId);
    await index.syncSourceFile(live.runtime.sessionFile);
    index.navigateBranch(control.historyAnchorId);
    const createdAt = new Date().toISOString();
    this.liveTranscripts.set(sessionId, index);
    this.database.orm.update(agentSessions).set({
      lastEventOffset: index.eventCount,
      updatedAt: createdAt,
    }).where(eq(agentSessions.id, sessionId)).run();
    return control;
  }

  get(sessionId: string): AgentSession | null {
    return this.database.orm.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get() ?? null;
  }

  controlsAvailable(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    const session = this.get(sessionId);
    if (!session || session.resumePending || session.health.issues.recovery?.attempt?.state === 'running') return false;
    return deriveAgentReadiness({ state: session.state, connected: live?.runtime.isAvailable() === true, quiesced: this.quiesced.has(sessionId), machineId: this.machineId, runtimeGeneration: live?.generation ?? 0, placement: this.database.getSpacePlacement(session.spaceId) }).controlsAvailable;
  }

  beginOperation(spaceId: string, issue: AgentIssue): AgentOperationToken {
    const session = this.list(spaceId)[0];
    const next = beginAgentOperation(session?.health ?? { revision: 0, issues: {} }, issue, crypto.randomUUID());
    if (session) this.commitAgentState(session, { health: next.state });
    return next.token;
  }

  settleOperation(spaceId: string, token: AgentOperationToken | null, failure: AgentFailure | WorkspaceFailure | null, patch: Partial<Pick<AgentSession, 'state' | 'resumePending'>> = {}): void {
    const session = this.list(spaceId)[0];
    if (!session || !token) return;
    const health = session.health.issues[token.issue] ? session.health : { ...session.health, issues: { ...session.health.issues, [token.issue]: { operationId: token.operationId, revision: token.revision, failure: null, incidentId: null } } };
    const next = settleAgentOperation(health, token, { sessionId: session.id, spaceId, now: new Date().toISOString(), failure });
    if (next.state === health) return;
    this.commitAgentState(session, { ...patch, health: next.state }, next.changes);
  }

  recordFailure(spaceId: string, operation: string, error: unknown, token: AgentOperationToken | null): void {
    const session = this.list(spaceId)[0];
    if (!session) {
      const space = this.database.getSpace(spaceId);
      if (space && token) {
        const now = new Date().toISOString();
        const change: AgentIncidentChange = { type: 'occurred', incident: { id: `${spaceId}:${token.operationId}`, sessionId: null, spaceId, issue: token.issue, operationId: token.operationId, revision: token.revision, occurredAt: now, failure: agentIssueFailure(error, 'AGENT_RUNTIME_FAILED', { operation, spaceId }) } };
        this.database.orm.insert(factEvents).values({ projectId: space.projectId, scope: 'session', entity: 'agent-incident', entityId: change.incident.id, revision: token.revision, operation: 'append', payload: { change }, createdAt: now }).run();
        this.events?.committed?.();
      }
      return;
    }
    const issue = token?.issue ?? agentOperationIssue(operation);
    const code = AGENT_ISSUE_FAILURE_CODES[issue];
    this.settleOperation(spaceId, token, agentIssueFailure(error, code, { operation, sessionId: session.id }), {
      state: session.state === 'closed' ? 'closed' : issue === 'recovery' ? 'failed' : this.live.get(session.id)?.runtime.isAvailable() ? 'active' : 'failed',
    });
  }

  private recoverIssue(spaceId: string, issue: AgentIssue): void {
    const session = this.list(spaceId)[0];
    if (!session?.health.issues[issue]?.failure) return;
    this.settleOperation(spaceId, this.beginOperation(spaceId, issue), null);
  }

  private commitAgentState(session: AgentSession, patch: Partial<Pick<AgentSession, 'state' | 'activity' | 'health' | 'resumePending' | 'lastEventOffset'>>, changes: AgentIncidentChange[] = []): void {
    const space = this.database.getSpace(session.spaceId);
    if (!space) return;
    const health = patch.health ?? { ...session.health, revision: session.health.revision + 1 };
    const updatedAt = new Date().toISOString();
    this.database.orm.transaction((tx) => {
      tx.update(agentSessions).set({ ...patch, health, updatedAt }).where(eq(agentSessions.id, session.id)).run();
      tx.insert(factEvents).values({ projectId: space.projectId, scope: 'session', entity: 'main-agent-activity', entityId: session.id, revision: health.revision, operation: 'updated', payload: { spaceId: session.spaceId, activity: patch.activity ?? session.activity, state: patch.state ?? session.state, resumePending: patch.resumePending ?? session.resumePending, health }, createdAt: updatedAt }).run();
      for (const change of changes) tx.insert(factEvents).values({ projectId: space.projectId, scope: 'session', entity: 'agent-incident', entityId: change.type === 'occurred' ? change.incident.id : change.incidentId, revision: change.type === 'occurred' ? change.incident.revision : change.revision, operation: 'append', payload: { change }, createdAt: updatedAt }).run();
    });
    this.events?.committed?.();
    this.publishCanonicalSession(space.projectId, session.id);
  }

  private async disposeSessionRuntime(sessionId: string, runtime: OmpRuntimeSession): Promise<void> {
    this.disposalFences.set(sessionId, runtime);
    const live = this.live.get(sessionId);
    if (live?.runtime === runtime) {
      live.unsubscribe();
      live.activityUnsubscribe();
      this.retainedArtifacts.set(sessionId, live);
    }
    try {
      await runtime.dispose();
      if (this.disposalFences.get(sessionId) === runtime) this.disposalFences.delete(sessionId);
    }
    finally {
      if (!runtime.isAvailable()) {
        if (this.live.get(sessionId)?.runtime === runtime) this.live.delete(sessionId);
        this.recoveringSessions.delete(sessionId);
      }
    }
  }

  private async disposeUnusableSession(sessionId: string): Promise<void> {
    const predecessor = this.disposalFences.get(sessionId);
    if (predecessor) await this.disposeSessionRuntime(sessionId, predecessor);
    const live = this.live.get(sessionId);
    if (!live) return;
    // Recovery cannot await turn completion or persistence on a broken worker.
    // dispose is the runtime's bounded child-exit fence.
    await this.disposeSessionRuntime(sessionId, live.runtime);
    this.quiesced.delete(sessionId);
  }

  getResourceContext(sessionId: string): { spaceId: string; sessionFile: string; localArtifactsDir: string } | null {
    const record = this.get(sessionId);
    return record ? {
      spaceId: record.spaceId,
      sessionFile: record.sessionFile,
      localArtifactsDir: join(this.runtimeRoot, 'sessions', record.id, 'artifacts'),
    } : null;
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
      health: session.health,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }).returning().get();
  }

  async transcript(sessionId: string): Promise<OmpTranscriptEvent[]> {
    const session = this.get(sessionId);
    if (!session) throw runtimeError('transcript', new Error('Session does not exist'), sessionId);
    const cached = this.liveTranscripts.get(sessionId);
    if (cached) return cached.snapshot();
    try {
      return await this.omp.transcript(session.sessionFile);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  private indexFor(key: string, sessionId: string): TranscriptIndex {
    let index = this.transcriptIndexes.get(key);
    if (!index) {
      const name = createHash('sha256').update(key).digest('hex');
      index = new TranscriptIndex(join(this.runtimeRoot, 'transcript-index', `${name}.sqlite`), sessionId);
      this.transcriptIndexes.set(key, index);
    }
    return index;
  }

  private async sessionTranscriptIndex(sessionId: string): Promise<TranscriptIndex> {
    const session = this.get(sessionId);
    if (!session) throw runtimeError('transcript', new Error('Session does not exist'), sessionId);
    const live = this.liveTranscripts.get(sessionId);
    if (live) return live;
    const index = this.indexFor(sessionId, sessionId);
    try {
      await index.syncFile(session.sessionFile);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      if (!index.initialized || index.eventCount > 0) index.seed([]);
    }
    return index;
  }

  private async seedRuntimeTranscript(sessionId: string, runtime: OmpRuntimeSession, check?: () => void): Promise<TranscriptIndex> {
    await runtime.persist();
    check?.();
    const index = this.indexFor(sessionId, sessionId);
    try {
      await index.syncFile(runtime.sessionFile, true);
      check?.();
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      index.seed([]);
    }
    // Model context can omit everything before compaction. It is a fallback only
    // for a newly created runtime whose first messages have not reached JSONL yet.
    if (index.eventCount === 0) {
      const messages = await runtime.messages();
      check?.();
      if (messages.length > 0) {
        const createdAt = new Date().toISOString();
        index.seed(messages.map((message, ordinal) => ({ ordinal: ordinal + 1, kind: 'message_end', payload: { message }, createdAt })));
      }
    }
    return index;
  }

  async historyPage(sessionId: string, request: SessionHistoryPageRequest): Promise<SessionHistoryPage> {
    const session = this.get(sessionId);
    if (!session) throw runtimeError('read session history', new Error('Session does not exist'), sessionId);
    const runtime = this.controlsAvailable(sessionId) ? this.live.get(sessionId)?.runtime : undefined;
    if (runtime) await runtime.persist();
    const index = this.indexFor(sessionId, sessionId);
    try {
      await index.syncSourceFile(runtime?.sessionFile ?? session.sessionFile);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      // An empty runtime may not have written JSONL yet. Its live pending rows
      // belong to the transcript and must not be reseeded by an explorer read.
    }
    const currentLeaf = runtime ? await runtime.historyAnchorId() : index.historyAnchorId;
    return index.historyPage(request, currentLeaf);
  }

  async transcriptPage(sessionId: string, request: TranscriptPageRequest): Promise<TranscriptPage> {
    return (await this.sessionTranscriptIndex(sessionId)).page(request);
  }

  async transcriptContent(sessionId: string, request: TranscriptContentRequest): Promise<TranscriptContentPage> {
    return (await this.sessionTranscriptIndex(sessionId)).content(request);
  }

  private async subagentTranscriptIndex(sessionId: string, subagentId: string): Promise<TranscriptIndex> {
    const session = this.get(sessionId);
    if (!session || !/^[A-Za-z0-9._-]{1,128}$/u.test(subagentId) || subagentId === '.' || subagentId === '..') {
      throw runtimeError('subagent transcript', new Error('Subagent session does not exist'), sessionId);
    }
    const root = session.sessionFile.replace(/\.jsonl$/u, '');
    const path = join(root, `${subagentId}.jsonl`);
    const actualRoot = await realpath(root);
    const actualPath = await realpath(path);
    if (dirname(actualPath) !== actualRoot) throw runtimeError('subagent transcript', new Error('Subagent session is outside its parent session'), sessionId);
    const index = this.indexFor(`${sessionId}:subagent:${subagentId}`, subagentId);
    await index.syncFile(actualPath);
    return index;
  }

  async subagentTranscriptPage(sessionId: string, subagentId: string, request: TranscriptPageRequest): Promise<TranscriptPage> {
    return (await this.subagentTranscriptIndex(sessionId, subagentId)).page(request);
  }

  async subagentTranscriptContent(sessionId: string, subagentId: string, request: TranscriptContentRequest): Promise<TranscriptContentPage> {
    return (await this.subagentTranscriptIndex(sessionId, subagentId)).content(request);
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
    const live = this.live.get(sessionId);
    if (live?.runtime.isAvailable()) await live.runtime.persist();
    let rootFile: string;
    try { rootFile = await realpath(session.sessionFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const artifactRoot = rootFile.replace(/\.jsonl$/u, '');
    const artifactPrefix = `${artifactRoot}${sep}`;
    return buildSessionUsageReport(sessionId, rootFile, async (path) => {
      try {
        const actual = await realpath(path);
        if (path !== rootFile && (!actual.startsWith(artifactPrefix) || actual !== resolve(path))) {
          throw new Error('Usage transcript is outside its session or traverses a symbolic link');
        }
        return await readFile(actual, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }, async (directory) => {
      try {
        const actual = await realpath(directory);
        if ((actual !== artifactRoot && !actual.startsWith(artifactPrefix)) || actual !== resolve(directory)) {
          throw new Error('Usage transcript directory is outside its session or traverses a symbolic link');
        }
        return (await readdir(actual, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => join(actual, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
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
    const session = this.get(sessionId);
    if (!session) throw runtimeError('subagent transcript', new Error('Session does not exist'), sessionId);
    let ordinal = Math.max(0, afterOrdinal);
    let generation: string | null = null;
    let version = 0;
    let wake: (() => void) | null = null;
    let watchFailure: Error | null = null;
    const changed = (): void => { version++; wake?.(); wake = null; };
    const watcher = watch(session.sessionFile.replace(/\.jsonl$/u, ''), { persistent: false }, (_event, file) => {
      if (file === null || file === `${subagentId}.jsonl`) changed();
    });
    watcher.on('error', (error) => { watchFailure = error; changed(); });
    signal.addEventListener('abort', changed, { once: true });
    try {
      while (!signal.aborted) {
        if (watchFailure) throw watchFailure;
        const observed = version;
        const index = await this.subagentTranscriptIndex(sessionId, subagentId);
        if (generation !== null && generation !== index.generation) ordinal = 0;
        generation = index.generation;
        for (const event of index.eventsAfter(ordinal)) {
          if (signal.aborted) return;
          ordinal = event.ordinal;
          yield event;
        }
        if (version === observed && !signal.aborted) await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      watcher.close();
      signal.removeEventListener('abort', changed);
    }
  }


  async quiesceSpace(spaceId: string, requirePortableControls = false): Promise<void> {
    const queued = this.list(spaceId)[0];
    if (queued) this.quiesced.add(queued.id);
    this.recoveryControllers.get(spaceId)?.abort(new Error('Space handoff superseded agent recovery'));
    // Close changes placement synchronously; an in-flight open must finish its
    // generation check and dispose before any retained bytes are captured.
    await this.opening.get(spaceId);
    const session = this.list(spaceId)[0];
    if (!session) throw runtimeError('quiesce', new Error('Space session does not exist'));
    const live = this.live.get(session.id);
    this.quiesced.add(session.id);
    if (!live?.runtime.isAvailable()) {
      const denied = agentCheckpointFailure({ sessionId: session.id, activity: session.activity, pendingAsk: false, steering: 0, followUp: 0 });
      if (denied) throw new AgentDomainError(denied);
      if (live) await this.disposeSessionRuntime(session.id, live.runtime);
      await Promise.all(this.activePrompts.get(session.id) ?? []);
      return;
    }
    if (requirePortableControls) {
      const control = await live.runtime.control();
      const denied = agentCheckpointFailure({ sessionId: session.id, activity: live.runtime.activity().activity, pendingAsk: !!control.pendingAsk, steering: control.queue.steering.length, followUp: control.queue.followUp.length });
      if (denied) throw new AgentDomainError(denied);
    }
    const interrupted = await live.runtime.handoff();
    if (interrupted) {
      this.commitAgentState(this.get(session.id)!, { resumePending: true });
    }
    await Promise.all(this.activePrompts.get(session.id) ?? []);
  }

  resumeSpace(spaceId: string): void {
    const session = this.list(spaceId)[0];
    if (session && this.quiesced.delete(session.id)) {
      const live = this.live.get(session.id);
      if (live?.runtime.isAvailable()) void this.resumeIfPending(session, live.runtime, live.capability).catch((error) => {
        if (this.live.get(session.id)?.runtime === live.runtime && !this.quiesced.has(session.id)) {
          this.recordFailure(spaceId, 'resume', error, this.beginOperation(spaceId, 'recovery'));
        }
      });
    }
  }

  async capturePortableSpace(spaceId: string): Promise<{
    agent: CoordinatorPortableAgentSnapshot;
    artifacts: CoordinatorPortableArtifactSnapshot;
  }> {
    const session = this.list(spaceId)[0];
    if (!session) throw runtimeError('checkpoint', new Error('Space session does not exist'));
    const live = this.live.get(session.id);
    if (!this.quiesced.has(session.id)) throw runtimeError('checkpoint', new Error('Space session is not quiesced'), session.id);
    const space = this.database.getSpace(spaceId)!;
    const capability: ArtifactCapability = space.kind === 'base'
      ? { kind: 'project', projectId: space.projectId }
      : { kind: 'workspace', projectId: space.projectId, workspaceId: spaceId };
    const existingScope = this.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, spaceId)).get();
    if (!existingScope || (existingScope.generation > 0 && !existingScope.manifestHash)) {
      throw runtimeError('checkpoint artifacts', new Error('Retained artifact scope is missing; local data has been kept'), session.id);
    }
    if (live) {
      if (!live.runtime.isAvailable()) throw runtimeError('checkpoint', new Error('Agent disconnected while quiescing; retry close to capture retained data'), session.id);
      await live.runtime.persist();
    }
    const ompSession = await retainedSessionBytes(session);
    const state = live ?? await this.prepareSessionArtifacts(session.id, capability, true);
    const generation = await this.syncSessionArtifacts(state);
    const scope = this.database.orm.select().from(artifactScopes).where(eq(artifactScopes.spaceId, spaceId)).get();
    if (!scope || scope.dirty || scope.generation !== generation || (generation > 0 && !scope.manifestHash)) throw runtimeError('checkpoint artifacts', new Error('Durable artifact scope is missing'), session.id);
    const verified = await this.artifacts.verifyScope(scope);
    await this.canonicalSessions?.flush?.();
    await this.events?.flush?.();
    if (verified.status === 'error') throw runtimeError('checkpoint artifacts', verified.error, session.id);
    return {
      agent: {
        sessionId: session.id,
        ompSessionId: session.ompSessionId,
        ompSession,
        resumePending: this.get(session.id)?.resumePending ?? false,
      },
      artifacts: { generation, manifest: new TextEncoder().encode(JSON.stringify({ version: 2, scope })) },
    };
  }

  recordPortableSpaceCheckpoint(spaceId: string, receipt: { revision: number; manifestKey: string; manifestHash: `sha256:${string}` }): void {
    this.database.recordSpaceCleanupCheckpoint(spaceId, receipt);
  }

  async preparePortableSpaceCleanup(spaceId: string): Promise<void> {
    const queued = this.list(spaceId)[0];
    if (queued) this.quiesced.add(queued.id);
    this.recoveryControllers.get(spaceId)?.abort(new Error('Space cleanup superseded agent recovery'));
    await this.opening.get(spaceId);
    await this.assertManagedSpaceRoot(spaceId);
    await this.detachDependentWorktrees(spaceId);
    const space = this.database.getSpace(spaceId)!;
    const sessions = this.list(spaceId);
    const paths = new Set<string>();
    for (const session of sessions) {
      await this.assertCleanupPath(session.sessionFile);
      paths.add(session.sessionFile);
      const children = session.sessionFile.replace(/\.jsonl$/u, '');
      if (children !== session.sessionFile) {
        await this.assertCleanupPath(children);
        paths.add(children);
      }
      paths.add(join(this.runtimeRoot, 'sessions', session.id));
      const keys = new Set([session.id, ...[...this.transcriptIndexes.keys()].filter((key) => key.startsWith(`${session.id}:subagent:`))]);
      if (children !== session.sessionFile) {
        for (const name of await readdir(children).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
          if (name.endsWith('.jsonl')) keys.add(`${session.id}:subagent:${name.slice(0, -6)}`);
        }
      }
      for (const key of keys) {
        const file = join(this.runtimeRoot, 'transcript-index', `${createHash('sha256').update(key).digest('hex')}.sqlite`);
        for (const suffix of ['', '-wal', '-shm']) paths.add(`${file}${suffix}`);
      }
    }
    paths.add(join(this.ompSessionRoot, `space:${spaceId}`));
    for (const path of paths) await this.assertCleanupPath(path);
    this.database.prepareSpaceCleanup({
      spaceId, projectId: space.projectId, generation: this.database.getSpacePlacement(spaceId)!.generation,
      rootPath: space.rootPath, sessionFiles: [...paths], sessionIds: sessions.map((session) => session.id),
    });
  }

  async deletePortableSpaceLocal(spaceId: string): Promise<void> {
    // This durable receipt must precede the first await: ownership has already moved.
    this.database.commitSpaceCleanup(spaceId);
    const job = this.database.listSpaceCleanupJobs().find((candidate) => candidate.spaceId === spaceId);
    if (!job || job.state !== 'committed') throw runtimeError('delete local space', new Error('Committed cleanup receipt is missing'));
    try {
      for (const sessionId of job.sessionIds) {
        const live = this.live.get(sessionId);
        if (live) {
          live.unsubscribe();
          live.activityUnsubscribe();
          await live.runtime.dispose();
          if (live.runtime.isAvailable()) throw new Error(`Session ${sessionId} did not stop`);
          this.live.delete(sessionId);
        }
        await Promise.all(this.activePrompts.get(sessionId) ?? []);
        clearTimeout(this.transcriptUpdateTimers.get(sessionId));
        this.transcriptUpdateTimers.delete(sessionId);
        this.liveTranscripts.delete(sessionId);
        for (const [key, index] of this.transcriptIndexes) {
          if (key === sessionId || key.startsWith(`${sessionId}:subagent:`)) {
            index.close();
            this.transcriptIndexes.delete(key);
          }
        }
        this.activePrompts.delete(sessionId);
        this.retainedArtifacts.delete(sessionId);
        this.quiesced.delete(sessionId);
        this.recoveringSessions.delete(sessionId);
      }
      this.opening.delete(spaceId);
      this.artifactPublicationBases.delete(spaceId);
      for (const path of job.sessionFiles) {
        await this.assertCleanupPath(path);
        await rm(path, { recursive: true, force: true });
      }
      await this.assertManagedCheckoutPath(job.rootPath);
      await rm(job.rootPath, { recursive: true, force: true });
      await this.artifacts.pruneUnreferencedCachedBytes();
      // The caller completes the receipt only after its own resource cleanup succeeds.
    } catch (error) {
      this.database.failSpaceCleanup(spaceId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async assertCleanupPath(path: string): Promise<void> {
    const allowed = [this.managedSpaceRoot, this.runtimeRoot, this.ompSessionRoot];
    const contains = (root: string, candidate: string): boolean => {
      const local = relative(resolve(root), resolve(candidate));
      return local !== '' && local !== '..' && !local.startsWith(`..${sep}`);
    };
    if (!allowed.some((root) => contains(root, path))) throw new Error(`Refusing unmanaged session cleanup path ${path}`);
    // Resolve the nearest existing ancestor, including when a previous retry removed the file.
    let ancestor = resolve(path);
    const suffix: string[] = [];
    while (!(await lstat(ancestor).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)))) {
      suffix.unshift(relative(dirname(ancestor), ancestor));
      ancestor = dirname(ancestor);
    }
    const actual = join(await realpath(ancestor), ...suffix);
    const roots = await Promise.all(allowed.map((root) => realpath(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? resolve(root) : Promise.reject(error))));
    if (!roots.some((root) => contains(root, actual))) throw new Error(`Session cleanup path escapes managed roots: ${path}`);
  }

  async preparePortableSpaceRepository(spaceId: string): Promise<void> {
    await this.assertManagedSpaceRoot(spaceId);
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('prepare space', new Error('Space does not exist'));
    await this.detachDependentWorktrees(spaceId);
    // Unproven leftovers may contain unique work. Refuse rather than retain or destroy them.
    const existing = await lstat(space.rootPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      throw runtimeError('prepare space', new Error('Checkout already exists; refusing to overwrite unproven local data'));
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
      const pointerBackup = `${gitFile}.swap-${crypto.randomUUID()}`;
      try {
        await cp(common, temporary, { recursive: true, filter: (source) => source !== join(common, 'worktrees') });
        await cp(gitDirectory, temporary, {
          recursive: true,
          filter: (source) => !['commondir', 'gitdir'].includes(relative(gitDirectory, source)),
        });
        await this.portableGit(checkout, ['config', '--file', join(temporary, 'config'), 'core.bare', 'false']);
        // Remove a shared core.worktree pointer, if present; an absent value is normal.
        const config = await readFile(join(temporary, 'config'), 'utf8');
        if (/^\s*worktree\s*=/mu.test(config)) await this.portableGit(checkout, ['config', '--file', join(temporary, 'config'), '--unset-all', 'core.worktree']);
        await rename(gitFile, pointerBackup);
        try { await rename(temporary, gitFile); }
        catch (error) { await rename(pointerBackup, gitFile); throw error; }
        await rm(pointerBackup);
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
    const canonical = await this.canonicalSessions?.get(space.projectId, input.agent.sessionId);
    if (canonical && (canonical.workspaceId !== input.spaceId || canonical.ompSessionId !== input.agent.ompSessionId)) {
      throw new AgentDomainError({ domain: 'agent', code: 'AGENT_HISTORY_INVALID', message: 'Portable agent identity does not match its canonical session', context: { spaceId: input.spaceId, sessionId: input.agent.sessionId } });
    }
    const health = session && (!canonical || session.health.revision >= canonical.health.revision)
      ? session.health
      : canonical?.health ?? { revision: 0, issues: {} };
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
        health,
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
    const transcript = await this.sessionTranscriptIndex(session.id);
    const artifactManifest = JSON.parse(new TextDecoder().decode(input.artifacts.manifest)) as { version: number; scope?: ArtifactScope };
    if (artifactManifest.version !== 2 || !artifactManifest.scope
      || artifactManifest.scope.spaceId !== input.spaceId
      || artifactManifest.scope.generation !== input.artifacts.generation) {
      throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_INVALID', message: 'Checkpoint artifact scope does not match the workspace and generation', context: { spaceId: input.spaceId, generation: input.artifacts.generation } });
    }
    const restored = await this.artifacts.restoreScope(artifactManifest.scope);
    if (restored.status === 'error') throw runtimeError('restore artifacts', restored.error, session.id);
    this.commitAgentState(session, { state: 'closed', lastEventOffset: transcript.eventCount, resumePending: input.agent.resumePending ?? false, activity: { active: false, reasons: [] }, health: { ...health, revision: health.revision + 1 } });
    this.quiesced.delete(session.id);
    this.retainedArtifacts.delete(session.id);
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

  /** Reconcile a committed phase without opening a closed or dormant session. */
  async workspacePhaseChanged(projectId: string, spaceId: string): Promise<void> {
    const workspace = this.database.getWorkspace(spaceId);
    if (!workspace || workspace.projectId !== projectId) throw runtimeError('update workspace phase', new Error('Workspace does not exist in this project'));
    const session = this.list(spaceId)[0];
    const live = session ? this.live.get(session.id) : undefined;
    if (!live?.runtime.isAvailable()) return;
    await live.runtime.setWorkspacePhase(workspace.phase);
  }

  async refreshArtifacts(projectId: string, spaceId: string): Promise<void> {
    const live = [...this.live.values()].find((candidate) => candidate.capability.projectId === projectId
      && (candidate.capability.kind === 'workspace' ? candidate.capability.workspaceId : candidate.capability.projectId) === spaceId);
    if (!live) return;
    // Explicit reconciliation separates the sync requests before and after it.
    live.queuedArtifactSync = null;
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
      live.queuedArtifactSync = null;
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
    const openingSession = this.get(sessionId);
    if (openingSession) {
      this.quiesced.add(sessionId);
      this.recoveryControllers.get(openingSession.spaceId)?.abort(new Error('Session close superseded agent recovery'));
      await this.opening.get(openingSession.spaceId);
      this.quiesced.delete(sessionId);
    }
    if (this.live.has(sessionId)) return this.stopLive(sessionId, true);
    const session = this.get(sessionId);
    if (!session) return Result.err(runtimeError('close', new Error('Session does not exist'), sessionId));
    if (session.state === 'closed') return Result.ok(undefined);
    this.commitAgentState(session, { state: 'closed', activity: { active: false, reasons: [] } });
    return Result.ok(undefined);
  }

  private spaceTarget(spaceId: string, allowOpening = false): ResultType<SessionTarget, SessionWorkspaceUnavailable | SessionPossessionDenied> {
    const space = this.database.getSpace(spaceId);
    if (!space) {
      return Result.err(new SessionWorkspaceUnavailable({ workspaceId: spaceId, message: `Space ${spaceId} does not exist` }));
    }
    const placement = this.database.getSpacePlacement(spaceId);
    const denied = agentPlacementFailure(spaceId, placement, this.machineId, { allowOpening });
    if (denied) return Result.err(denied);
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

  private async prepareSessionArtifacts(recordId: string, capability: ArtifactCapability, retained: boolean, check?: () => void): Promise<SessionArtifacts> {
    const remembered = this.retainedArtifacts.get(recordId);
    if (remembered) return remembered;
    const artifactsDir = join(this.runtimeRoot, 'sessions', recordId, 'artifacts');
    const baselinePath = join(dirname(artifactsDir), 'artifact-baseline.json');
    const artifactBaseline = new Map<string, string>();
    let savedBaseline = false;
    if (retained) {
      try {
        const entries: unknown = JSON.parse(await readFile(baselinePath, 'utf8'));
        check?.();
        if (!Array.isArray(entries)) throw new Error('Retained artifact baseline is invalid');
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
            || typeof entry[1] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry[1])
            || entry[0].split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')) {
            throw new Error('Retained artifact baseline is invalid');
          }
          artifactBaseline.set(entry[0], entry[1]);
        }
        savedBaseline = true;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    const writable = capability.kind === 'workspace' ? 'workspace' : 'base';
    for (const mount of capability.kind === 'workspace' ? ['base', 'workspace'] as const : ['base'] as const) {
      const root = join(artifactsDir, mount);
      const metadata = await lstat(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      check?.();
      if (metadata && !metadata.isDirectory()) throw new Error(`Retained artifact mount ${root} is not a directory`);
      if (!metadata && savedBaseline && mount === writable && artifactBaseline.size > 0) {
        throw new Error(`Retained artifact mount ${root} is missing; refusing to infer deletions`);
      }
      const listed = this.artifacts.list(capability, `local://${mount}/`);
      if (listed.status === 'error') throw listed.error;
      await mkdir(root, { recursive: true });
      check?.();
      await filesUnder(root);
      check?.();
      for (const entry of listed.value) {
        if (savedBaseline && mount === writable) continue;
        const bytes = await this.artifacts.read(capability, entry.url);
        check?.();
        if (bytes.status === 'error') throw bytes.error;
        const path = join(root, entry.path);
        // A workspace's base mount is a read-only cache, not an unsynced write.
        if (mount !== writable) {
          await mkdir(dirname(path), { recursive: true });
          check?.();
          await writeFile(path, bytes.value);
          check?.();
          continue;
        }
        const current = await readFile(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
        check?.();
        const hash = `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`;
        if (current && `sha256:${createHash('sha256').update(current).digest('hex')}` !== hash) {
          throw new Error(`Retained artifact ${entry.url} differs without a trustworthy baseline; local files have been kept for recovery`);
        }
        if (!current) {
          await mkdir(dirname(path), { recursive: true });
          check?.();
          await writeFile(path, bytes.value, { flag: 'wx' });
          check?.();
        }
        if (mount === writable) artifactBaseline.set(entry.path, hash);
      }
    }
    const state = { recordId, artifactsDir, capability, artifactBaseline, artifactSync: null, queuedArtifactSync: null };
    await this.persistArtifactBaseline(state, check);
    check?.();
    this.retainedArtifacts.set(recordId, state);
    return state;
  }

  private async persistArtifactBaseline(state: SessionArtifacts, check?: () => void): Promise<void> {
    const path = join(dirname(state.artifactsDir), 'artifact-baseline.json');
    const temporary = `${path}.${crypto.randomUUID()}`;
    await writeFile(temporary, JSON.stringify([...state.artifactBaseline]), { mode: 0o600 });
    check?.();
    await rename(temporary, path);
  }

  private async adopt(
    record: AgentSession,
    runtime: OmpRuntimeSession,
    artifactsDir: string,
    capability: ArtifactCapability,
    artifactBaseline: Map<string, string>,
    generation: number,
    check: () => void,
  ): Promise<void> {
    const retained = this.liveTranscripts.get(record.id);
    if (retained && !retained.hasUnpersistedBranch) {
      await runtime.persist();
      check();
      retained.renewGeneration();
    } else {
      const transcript = await this.seedRuntimeTranscript(record.id, runtime, check);
      check();
      this.liveTranscripts.set(record.id, transcript);
    }
    const unsubscribe = runtime.subscribe((event) => {
      this.appendEvent(record.id, event);
      if (event.type === 'tool_execution_end' || event.type === 'agent_end') {
        const live = this.live.get(record.id);
        if (live && live.runtime === runtime) void this.syncSessionArtifacts(live);
      }
    });
    let activityUnsubscribe: () => void;
    try {
      activityUnsubscribe = runtime.subscribeActivity((activity, failure) => {
        this.updateActivity(record.id, capability, runtime, generation, activity, failure);
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    this.live.set(record.id, { recordId: record.id, runtime, generation, artifactsDir, capability, artifactBaseline, artifactSync: null, queuedArtifactSync: null, unsubscribe, activityUnsubscribe });
    this.retainedArtifacts.delete(record.id);
    // Register before applying authority metadata so concurrent phase edits reach us.
    if (capability.kind === 'workspace') await this.workspacePhaseChanged(capability.projectId, capability.workspaceId);
    check();
  }

  private updateActivity(sessionId: string, capability: ArtifactCapability, runtime: OmpRuntimeSession, generation: number, activity: SessionActivity, failure: AgentFailure | null = null): void {
    let current = this.get(sessionId);
    const live = this.live.get(sessionId);
    if (!current || (live && live.runtime !== runtime)) return;
    const placement = this.database.getSpacePlacement(current.spaceId);
    if (agentPlacementFailure(current.spaceId, placement, this.machineId, { generation, allowOpening: true })) return;
    const disconnected = !runtime.isAvailable();
    // Public controls stay gated until recovery settles; acceptance checks the attached worker itself.
    const attached = deriveAgentReadiness({ state: current.state, connected: !disconnected, quiesced: this.quiesced.has(sessionId), machineId: this.machineId, runtimeGeneration: generation, placement }).controlsAvailable;
    if (resumeAccepted({ activity, recovering: this.recoveringSessions.has(sessionId), controlsAvailable: attached })) {
      this.recoveringSessions.delete(sessionId);
      this.completeResume(sessionId, capability);
      current = this.get(sessionId)!;
    }
    let health = current.health;
    const changes: AgentIncidentChange[] = [];
    const observe = (issue: AgentIssue, observed: AgentFailure | null): void => {
      if (JSON.stringify(currentAgentFailure(health, issue)) === JSON.stringify(observed)) return;
      const begun = beginAgentOperation(health, issue, crypto.randomUUID());
      const settled = settleAgentOperation(begun.state, begun.token, { sessionId, spaceId: current.spaceId, now: new Date().toISOString(), failure: observed });
      health = settled.state;
      changes.push(...settled.changes);
    };
    if (disconnected) observe('connection', failure ?? { domain: 'agent', code: 'AGENT_DISCONNECTED', message: 'Agent worker disconnected', context: { sessionId } });
    else {
      observe('connection', null);
      observe('execution', failure);
    }
    const nextActivity = disconnected ? disconnectedAgentActivity(current.activity) : activity;
    if (health === current.health && JSON.stringify(current.activity) === JSON.stringify(nextActivity) && (!disconnected || current.state === 'failed')) return;
    if (health.revision <= current.health.revision) health = { ...health, revision: current.health.revision + 1 };
    this.commitAgentState(current, { activity: nextActivity, health, ...(disconnected ? { state: 'failed', resumePending: current.resumePending || hasExecutingTurn(current.activity) } : {}) }, changes);
  }

  private appendEvent(sessionId: string, event: OmpRuntimeEvent): void {
    const liveUpdate = event.type === 'message_update' || event.type === 'tool_execution_update';
    if (!liveUpdate && !PERSISTED_TRANSCRIPT_EVENTS[event.type]) return;
    const index = this.liveTranscripts.get(sessionId) ?? this.indexFor(sessionId, sessionId);
    const serialized = serializableEvent(event);
    index.append(event.type, serialized);
    const ordinal = index.eventCount;
    this.liveTranscripts.set(sessionId, index);

    if (liveUpdate) {
      this.database.orm.update(agentSessions).set({ lastEventOffset: index.eventCount, updatedAt: new Date().toISOString() })
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
    this.database.orm.update(agentSessions).set({ lastEventOffset: index.eventCount, updatedAt: new Date().toISOString() })
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

  private syncSessionArtifacts(live: SessionArtifacts): Promise<number> {
    if (live.queuedArtifactSync) return live.queuedArtifactSync;
    const previous = live.artifactSync ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(async () => {
      if (live.queuedArtifactSync === next) live.queuedArtifactSync = null;
      const spaceId = live.capability.kind === 'workspace' ? live.capability.workspaceId : live.capability.projectId;
      const token = this.beginOperation(spaceId, 'artifact-sync');
      try {
        const generation = await withArtifactSyncDiagnostics(live.recordId, () => this.performArtifactSync(live));
        this.settleOperation(spaceId, token, null);
        return generation;
      } catch (error) {
        this.recordFailure(spaceId, 'artifact sync', error, token);
        throw error;
      }
    });
    live.queuedArtifactSync = next;
    live.artifactSync = next;
    // One rejection handler per sync, not per coalesced background trigger.
    // Foreground callers still await the original rejecting promise.
    void next.catch(() => { /* The sync operation already persisted its typed incident. */ });
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

  private async refreshCanonicalArtifacts(live: SessionArtifacts): Promise<void> {
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

  private async performArtifactSync(live: SessionArtifacts): Promise<number> {
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
    await this.persistArtifactBaseline(live);
    this.events?.append({
      projectId: live.capability.projectId, scope: 'artifact', entity: 'artifact', entityId: artifactUrl,
      revision: published.generation, operation: 'updated',
      payload: { spaceId: live.capability.kind === 'workspace' ? live.capability.workspaceId : live.capability.projectId },
    });
    return published.generation;
  }

  private async refreshArtifactMount(live: SessionArtifacts, mount: 'base' | 'workspace', writable: boolean): Promise<void> {
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
    const session = this.get(sessionId);
    const stopToken = session ? this.beginOperation(session.spaceId, close ? 'checkpoint' : 'recovery') : null;
    if (!live.runtime.isAvailable()) {
      try {
        await this.disposeSessionRuntime(sessionId, live.runtime);
        await Promise.all(this.activePrompts.get(sessionId) ?? []);
        return close ? this.close(sessionId) : Result.ok(undefined);
      } catch (error) {
        const session = this.get(sessionId);
        if (session) this.recordFailure(session.spaceId, close ? 'close' : 'restart', error, stopToken);
        return Result.err(runtimeError(close ? 'close' : 'restart', error, sessionId));
      }
    }
    try {
      this.quiesced.add(sessionId);
      const record = this.get(sessionId);
      const activity = record?.activity;
      const wasExecuting = record?.resumePending === true
        || this.activePrompts.has(sessionId)
        || hasExecutingTurn(activity)
        || hasExecutingTurn(live.runtime.activity().activity);
      // Record responsibility before handoff can interrupt or fail while flushing.
      if (!close) this.commitAgentState(this.get(sessionId)!, { state: 'draining', resumePending: wasExecuting });
      const runtimeInterrupted = close ? false : await live.runtime.handoff();
      await Promise.all(this.activePrompts.get(sessionId) ?? []);
      const resumePending = close ? record?.resumePending === true : wasExecuting || runtimeInterrupted;
      this.commitAgentState(this.get(sessionId)!, { state: 'draining', resumePending });
      await this.syncSessionArtifacts(live);
      await live.runtime.persist();
      await this.disposeSessionRuntime(sessionId, live.runtime);
      this.quiesced.delete(sessionId);
      this.commitAgentState(this.get(sessionId)!, { state: close ? 'closed' : 'active', resumePending, ...(close ? { activity: { active: false, reasons: [] } } : {}) });
      if (record) this.settleOperation(record.spaceId, stopToken, null);
      this.publishCanonicalSession(live.capability.projectId, sessionId, true);
      return Result.ok(undefined);
    } catch (error) {
      const record = this.get(sessionId);
      if (record) this.recordFailure(record.spaceId, close ? 'close' : 'restart', error, stopToken);
      this.quiesced.delete(sessionId);
      return Result.err(runtimeError(close ? 'close' : 'restart', error, sessionId));
    }
  }

  private completeResume(sessionId: string, capability: ArtifactCapability): void {
    const record = this.get(sessionId);
    if (!record?.resumePending || this.quiesced.has(sessionId)) return;
    this.commitAgentState(record, { resumePending: false });
    this.resumeAcceptedCallbacks.get(sessionId)?.();
  }

  private readonly resumeAcceptedCallbacks = new Map<string, () => void>();

  private async resumeIfPending(record: AgentSession, runtime: OmpRuntimeSession, capability: ArtifactCapability): Promise<void> {
    if (!record.resumePending) return;
    this.recoveringSessions.add(record.id);
    const accepted = Promise.withResolvers<void>();
    this.resumeAcceptedCallbacks.set(record.id, accepted.resolve);
    const pending = this.activePrompts.get(record.id) ?? new Set<Promise<void>>();
    const execution = runtime.resume().then(() => {
      if (this.live.get(record.id)?.runtime !== runtime || this.quiesced.has(record.id)) return;
      this.recoveringSessions.delete(record.id);
      this.completeResume(record.id, capability);
      accepted.resolve();
    }).catch((error) => {
      accepted.reject(error);
      if (this.live.get(record.id)?.runtime !== runtime || this.quiesced.has(record.id)) return;
      this.recoveringSessions.delete(record.id);
      // Once resume has been accepted, later turn errors belong to execution.
      if (!this.get(record.id)?.resumePending) this.recordFailure(record.spaceId, 'prompt', error, this.beginOperation(record.spaceId, 'execution'));
    }).finally(() => {
      pending.delete(execution);
      if (pending.size === 0 && this.activePrompts.get(record.id) === pending) this.activePrompts.delete(record.id);
    });
    pending.add(execution);
    this.activePrompts.set(record.id, pending);
    try { await accepted.promise; }
    finally { if (this.resumeAcceptedCallbacks.get(record.id) === accepted.resolve) this.resumeAcceptedCallbacks.delete(record.id); }
  }
  private async assertManagedSpaceRoot(spaceId: string): Promise<void> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('managed space', new Error('Space does not exist'));
    await this.assertManagedCheckoutPath(space.rootPath);
  }

  private async assertManagedCheckoutPath(rootPath: string): Promise<void> {
    const space = { rootPath };
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
