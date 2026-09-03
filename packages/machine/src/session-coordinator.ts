import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  LocalArtifactResolver,
  agentSessions,
  type AgentSession,
  type ArtifactCapability,
  type ArtifactScope,
  type GitSpaceDatabase,
  type ProjectEventWriter,
} from '@gitspace/core';
import type { CanonicalSession, SessionActivity } from '@gitspace/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { projectOmpTranscript, type OmpRuntime, type OmpRuntimeEvent, type OmpRuntimeSession, type OmpSessionControlView, type OmpTranscriptEvent } from './omp-runtime.js';
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
}


export class MachineSessionCoordinator {
  private readonly liveTranscripts = new Map<string, OmpTranscriptEvent[]>();
  private readonly transcriptUpdateTimers = new Map<string, Timer>();
  private readonly live = new Map<string, LiveSession>();
  private readonly quiesced = new Set<string>();
  private readonly activePrompts = new Set<string>();

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
        this.adopt(record, runtime, artifactsDir, target.capability);
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
      this.adopt(record, runtime, artifactsDir, target.capability);
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

  async recover(): Promise<ResultType<AgentSession[], MachineSessionError>> {
    const recoverable = this.database.orm.select().from(agentSessions)
      .where(inArray(agentSessions.state, ['opening', 'active', 'draining']))
      .orderBy(agentSessions.createdAt, agentSessions.id).all();
    const recovered: AgentSession[] = [];
    for (const record of recoverable) {
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
        this.adopt(record, runtime, artifactsDir, target.value.capability);
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
    this.activePrompts.add(sessionId);
    try {
      const accepted = await live.runtime.prompt(text, options);
      if (!accepted) return Result.ok(false);
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
      return Result.ok(true);
    } catch (error) {
      return Result.err(runtimeError('prompt', error, sessionId));
    } finally {
      this.activePrompts.delete(sessionId);
    }
  }

  control(sessionId: string): OmpSessionControlView {
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
  setThinking(sessionId: string, thinking: string | null): OmpSessionControlView {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session thinking', new Error('Session is not active'), sessionId);
    return live.runtime.setThinking(thinking);
  }

  setFast(sessionId: string, enabled: boolean): OmpSessionControlView {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('set session fast mode', new Error('Session is not active'), sessionId);
    return live.runtime.setFast(enabled);
  }

  setApproval(sessionId: string, approvalMode: 'always-ask' | 'write' | 'yolo'): OmpSessionControlView {
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

  clearQueue(sessionId: string): OmpSessionControlView {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('clear session queue', new Error('Session is not active'), sessionId);
    return live.runtime.clearQueue();
  }

  async navigateTree(sessionId: string, entryId: string): Promise<OmpSessionControlView> {
    const live = this.live.get(sessionId);
    if (!live) throw runtimeError('navigate session tree', new Error('Session is not active'), sessionId);
    const control = await live.runtime.navigateTree(entryId);
    const messages = live.runtime.messages();
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
      return await projectOmpTranscript(session.sessionFile);
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
      return await projectOmpTranscript(path);
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


  async quiesceSpace(spaceId: string): Promise<void> {
    const session = this.list(spaceId)[0];
    if (!session || !this.live.has(session.id)) throw runtimeError('quiesce', new Error('Space session is not live'), session?.id);
    this.quiesced.add(session.id);
    while (this.activePrompts.has(session.id)) await Bun.sleep(25);
  }

  resumeSpace(spaceId: string): void {
    const session = this.list(spaceId)[0];
    if (session) this.quiesced.delete(session.id);
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
    const artifactUrl = live.capability.kind === 'workspace' ? 'local://workspace/' : 'local://base/';
    const listed = this.artifacts.list(live.capability, artifactUrl);
    if (listed.status === 'error') throw runtimeError('checkpoint artifacts', listed.error, session.id);
    const files: Array<{ path: string; mediaType: string | null; data: string }> = [];
    for (const entry of listed.value) {
      const read = await this.artifacts.read(live.capability, entry.url);
      if (read.status === 'error') throw runtimeError('checkpoint artifacts', read.error, session.id);
      files.push({ path: entry.path, mediaType: entry.mediaType, data: Buffer.from(read.value).toString('base64') });
    }
    return {
      agent: {
        sessionId: session.id,
        ompSessionId: session.ompSessionId,
        ompSession: new Uint8Array(await readFile(session.sessionFile)),
      },
      artifacts: { generation, manifest: new TextEncoder().encode(JSON.stringify({ version: 1, files })) },
    };
  }

  async deletePortableSpaceLocal(spaceId: string): Promise<void> {
    this.assertManagedSpaceRoot(spaceId);
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('delete local space', new Error('Space does not exist'));
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
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('prepare space', new Error('Space does not exist'));
    await mkdir(space.rootPath, { recursive: true });
    const initialized = Bun.spawn(['git', 'init', '-b', space.branch], { cwd: space.rootPath, stdout: 'ignore', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([initialized.exited, new Response(initialized.stderr).text()]);
    if (exitCode !== 0) throw runtimeError('prepare space', new Error(stderr.trim() || `git init exited with ${exitCode}`));
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
        resumePending: false,
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
    const transcript = await this.transcript(session.id);
    this.database.orm.update(agentSessions).set({
      state: 'closed',
      lastEventOffset: transcript.length,
      activity: { active: false, reasons: [] },
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(agentSessions.id, session.id)).run();
    const capability: ArtifactCapability = space.kind === 'base'
      ? { kind: 'project', projectId: space.projectId }
      : { kind: 'workspace', projectId: space.projectId, workspaceId: space.id };
    const artifactUrl = space.kind === 'base' ? 'local://base/' : 'local://workspace/';
    const current = this.artifacts.list(capability, artifactUrl);
    if (current.status === 'error') throw runtimeError('restore artifacts', current.error, session.id);
    for (const entry of current.value) {
      const removed = this.artifacts.remove(capability, entry.url);
      if (removed.status === 'error') throw runtimeError('restore artifacts', removed.error, session.id);
    }
    const artifactManifest = JSON.parse(new TextDecoder().decode(input.artifacts.manifest)) as {
      version: number;
      files: Array<{ path: string; mediaType: string | null; data: string }>;
    };
    if (artifactManifest.version !== 1 || !Array.isArray(artifactManifest.files)) throw runtimeError('restore artifacts', new Error('Artifact manifest is invalid'), session.id);
    for (const file of artifactManifest.files) {
      const written = await this.artifacts.write(capability, `${artifactUrl}${file.path}`, new Uint8Array(Buffer.from(file.data, 'base64')), file.mediaType ?? undefined);
      if (written.status === 'error') throw runtimeError('restore artifacts', written.error, session.id);
    }
    const committed = await this.artifacts.commit(capability, artifactUrl);
    if (committed.status === 'error') throw runtimeError('restore artifacts', committed.error, session.id);
    await this.artifactManifests?.synchronizeArtifactScope(space.projectId, committed.value);
    this.quiesced.delete(session.id);
    const opened = await this.openSpace(input.spaceId, true);
    if (opened.status === 'error') throw opened.error;
    return opened.value;
  }

  async reloadOmpSettings(): Promise<void> {
    await Promise.all([...this.live.values()].map((session) => session.runtime.reloadSettings?.() ?? Promise.resolve()));
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
  ): Promise<ResultType<void, SessionRuntimeError>> {
    const base = await this.artifacts.materialize(capability, 'local://base/', join(artifactsDir, 'base'));
    if (base.status === 'error') return Result.err(runtimeError('materialize', base.error));
    if (capability.kind === 'project') return Result.ok(undefined);
    const workspace = await this.artifacts.materialize(capability, 'local://workspace/', join(artifactsDir, 'workspace'));
    return workspace.status === 'error'
      ? Result.err(runtimeError('materialize', workspace.error))
      : Result.ok(undefined);
  }

  private adopt(
    record: AgentSession,
    runtime: OmpRuntimeSession,
    artifactsDir: string,
    capability: ArtifactCapability,
  ): void {
    const readMessages = (runtime as Partial<OmpRuntimeSession>).messages;
    const messages = readMessages ? readMessages.call(runtime) : [];
    if (messages.length > 0 || !this.liveTranscripts.has(record.id)) {
      const createdAt = new Date().toISOString();
      this.liveTranscripts.set(record.id, messages.map((message, index) => ({
        ordinal: index + 1,
        kind: 'message_end',
        payload: { message },
        createdAt,
      })));
    }
    const unsubscribe = runtime.subscribe((event) => this.appendEvent(record.id, event));
    const activityUnsubscribe = runtime.subscribeActivity((activity, errorMessage) => {
      this.updateActivity(record.id, capability, activity, errorMessage);
    });
    this.live.set(record.id, { recordId: record.id, runtime, artifactsDir, capability, unsubscribe, activityUnsubscribe });
  }

  private updateActivity(
    sessionId: string,
    capability: ArtifactCapability,
    activity: SessionActivity,
    errorMessage?: string,
  ): void {
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

  private async syncSessionArtifacts(live: LiveSession): Promise<number> {
    const artifactScope = live.capability.kind === 'workspace' ? 'workspace' : 'base';
    const artifactRoot = join(live.artifactsDir, artifactScope);
    const artifactUrl = `local://${artifactScope}/`;
    const materialized = await filesUnder(artifactRoot);
    const present = new Set(materialized.map((path) => relative(artifactRoot, path).split('\\').join('/')));
    const journal = this.artifacts.list(live.capability, artifactUrl);
    if (journal.status === 'error') throw journal.error;
    for (const entry of journal.value) {
      if (present.has(entry.path)) continue;
      const removed = this.artifacts.remove(live.capability, entry.url);
      if (removed.status === 'error') throw removed.error;
    }
    for (const path of materialized) {
      const artifactPath = relative(artifactRoot, path).split('\\').join('/');
      const written = await this.artifacts.write(
        live.capability,
        `${artifactUrl}${artifactPath}`,
        new Uint8Array(await readFile(path)),
      );
      if (written.status === 'error') throw written.error;
    }
    const committed = await this.artifacts.commit(live.capability, artifactUrl);
    if (committed.status === 'error') throw committed.error;
    await this.artifactManifests?.synchronizeArtifactScope(live.capability.projectId, committed.value);
    return committed.value.generation;
  }

  private async stopLive(sessionId: string, close: boolean): Promise<ResultType<void, MachineSessionError>> {
    const live = this.live.get(sessionId);
    if (!live) return close
      ? Result.err(runtimeError('close', new Error('Session is not live'), sessionId))
      : Result.ok(undefined);
    try {
      const activity = this.get(sessionId)?.activity;
      const transcript = await this.transcript(sessionId);
      const lastMessage = [...transcript].reverse().find((event) => event.kind === 'message_end')?.payload.message;
      const transcriptNeedsContinuation = !!lastMessage && typeof lastMessage === 'object' && (lastMessage as { role?: unknown }).role === 'user';
      const wasExecuting = this.activePrompts.has(sessionId)
        || transcriptNeedsContinuation
        || activity?.reasons.some((reason) => reason.kind === 'turn' || reason.kind === 'compacting') === true;
      const runtimeInterrupted = close ? false : await live.runtime.handoff();
      const resumePending = close ? false : wasExecuting || runtimeInterrupted;
      this.database.orm.update(agentSessions).set({ state: 'draining', resumePending, updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, sessionId)).run();
      await this.syncSessionArtifacts(live);
      await live.runtime.persist();
      live.unsubscribe();
      live.activityUnsubscribe();
      await live.runtime.dispose();
      this.live.delete(sessionId);
      this.database.orm.update(agentSessions).set({
        state: close ? 'closed' : 'active',
        resumePending: close ? false : resumePending,
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

  private resumeIfPending(record: AgentSession, runtime: OmpRuntimeSession, capability: ArtifactCapability): void {
    if (!record.resumePending) return;
    void runtime.resume().then(() => {
      this.database.orm.update(agentSessions).set({ resumePending: false, errorMessage: null, updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, record.id)).run();
      this.publishCanonicalSession(capability.projectId, record.id);
      this.events?.append({
        projectId: capability.projectId,
        scope: 'session',
        entity: 'main-agent',
        entityId: record.id,
        revision: Date.now(),
        operation: 'updated',
        payload: { spaceId: record.spaceId, resumed: true },
      });
    }).catch((error) => {
      this.database.orm.update(agentSessions).set({
        errorMessage: error instanceof Error ? error.message : String(error),

        updatedAt: new Date().toISOString(),
      }).where(eq(agentSessions.id, record.id)).run();
    });
  }
  private assertManagedSpaceRoot(spaceId: string): void {
    const space = this.database.getSpace(spaceId);
    if (!space) throw runtimeError('managed space', new Error('Space does not exist'));
    const root = resolve(this.managedSpaceRoot);
    const local = relative(root, resolve(space.rootPath));
    if (local === '' || local === '..' || local.startsWith(`..${sep}`)) {
      throw runtimeError('managed space', new Error(`Refusing to delete unmanaged space root ${space.rootPath}`));
    }
  }
  private publishCanonicalSession(projectId: string, sessionId: string, checkpoint = false): void {
    const session = this.get(sessionId);
    if (session) this.canonicalSessions?.put(projectId, this.machineId, session, checkpoint);
  }

}
