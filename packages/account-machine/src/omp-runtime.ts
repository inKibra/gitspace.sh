import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executableArtifactManifestSchema, executableManifestPath, validateExecutableArtifact } from '@gitspace/account-omp/manifest';
import type { SessionActivity, SkillView } from '@gitspace/protocol';
import { OMP_IPC_VERSION, OmpRpcPeer, type OmpChildApi, type OmpMachineApi, type OmpNotification, type OmpSessionInput, type OmpToolDescriptor, type OmpMcpCatalog, type SessionMethod } from '../../account-omp/src/ipc.js';
import type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpTranscriptEvent } from '../../account-omp/src/contracts.js';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { MachineMcpCoordinator, ProjectedMcpSession } from './local-mcp.js';
import { createSpaceEvalNamespace, type OmpEvalNamespace, type SpaceWorkspaceControls } from './space-eval-sdk.js';
import { z } from 'zod';

export type { OmpRuntime, OmpRuntimeEvent, OmpRuntimeSession, OmpSessionControlView, OmpTranscriptEvent } from '../../account-omp/src/contracts.js';
export const ompGenerationSelectionSchema = z.object({
  path: z.string().min(1),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sha: z.string().min(1).nullable(),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export type OmpGenerationSelection = z.infer<typeof ompGenerationSelectionSchema>;
export interface OmpGenerationStatus { sha: string | null; hash: string; draining: number; failure?: { sha: string; error: string } }
export interface ProcessOmpRuntimeOptions {
  environmentRoot: string;
  entrypoint: string;
  manifestHash: string;
  agentDir: string;
  sessionRoot: string;
  mcp?: MachineMcpCoordinator;
  skills?: readonly SkillView[];
  spaceAuthority?: CloudSpaceCheckpointAuthority;
  workspaceControls?: () => SpaceWorkspaceControls;
  onError?: (error: unknown) => void;
}
interface OmpChild {
  rpc: OmpRpcPeer<OmpChildApi, OmpMachineApi>;
  process: Pick<Bun.Subprocess, 'send' | 'kill' | 'exited' | 'pid' | 'disconnect'>;
  alive(): boolean;
  close(): Promise<void>;
}
interface HostedSession {
  generation: OmpGenerationSelection;
  child: OmpChild;
  migrate(): Promise<void>;
  reloadAuth(): Promise<void>;
  dispose(): Promise<void>;
}

function spawnChild(
  entrypoint: string,
  handlers: ConstructorParameters<typeof OmpRpcPeer<OmpChildApi, OmpMachineApi>>[1],
  notify: (notification: OmpNotification) => void = () => undefined,
): OmpChild {
  let child: OmpChild['process'];
  let disconnected = false;
  let closing = false;
  const rpc = new OmpRpcPeer<OmpChildApi, OmpMachineApi>((message) => child.send(message), handlers, notify);
  child = Bun.spawn([process.execPath, entrypoint], {
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    serialization: 'advanced',
    ipc: (message) => rpc.receive(message),
    onDisconnect: () => {
      disconnected = true;
      rpc.close();
      if (!closing) notify({ type: 'activity', activity: { active: false, reasons: [] }, errorMessage: 'OMP process disconnected; resume will reopen its persisted session' });
    },
  });
  void child.exited.then((code) => { disconnected = true; rpc.close(new Error(`OMP child ${child.pid} exited (${code})`)); });
  return {
    rpc, process: child,
    alive: () => !disconnected && !closing,
    async close() {
      closing = true;
      rpc.close();
      if (!disconnected) child.disconnect();
      const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try { await child.exited; } finally { clearTimeout(deadline); }
    },
  };
}

async function health(child: OmpChild): Promise<void> {
  const info = await child.rpc.call('health', [], AbortSignal.timeout(30_000));
  if (info.protocolVersion !== OMP_IPC_VERSION || info.platform !== process.platform || info.arch !== process.arch || info.bunVersion !== Bun.version) {
    throw new Error(`OMP child is incompatible: ${JSON.stringify(info)}`);
  }
}
const noCallbacks = {
  namespace: async () => { throw new Error('No session namespace in OMP health/transcript process'); },
  executeTool: async () => { throw new Error('No session tools in OMP health/transcript process'); },
  mcpResources: async () => { throw new Error('No session MCP in OMP health/transcript process'); },
  mcpReadResource: async () => { throw new Error('No session MCP in OMP health/transcript process'); },
  mcpPrompt: async () => { throw new Error('No session MCP in OMP health/transcript process'); },
};

async function projectTranscript(input: { sessionFile: string } | { bytes: Uint8Array }, entrypoint?: string): Promise<OmpTranscriptEvent[]> {
  const path = entrypoint ?? process.env.GITSPACE_OMP_RUNTIME_PATH;
  if (!path) throw new Error('GITSPACE_OMP_RUNTIME_PATH is required for OMP transcript projection');
  const child = spawnChild(path, noCallbacks);
  try { await health(child); return await child.rpc.call('transcript', [input], AbortSignal.timeout(30_000)); }
  finally { await child.close(); }
}
export async function projectOmpTranscript(sessionFile: string, entrypoint?: string): Promise<OmpTranscriptEvent[]> {
  return projectTranscript({ sessionFile }, entrypoint);
}
export async function projectOmpCheckpointTranscript(bytes: Uint8Array, entrypoint?: string): Promise<OmpTranscriptEvent[]> {
  return projectTranscript({ bytes }, entrypoint);
}

/** Machine orchestration owns no agent execution: each session pins an immutable OMP child. */
export class ProcessOmpRuntime implements OmpRuntime {
  private selected: OmpGenerationSelection | null = null;
  private channelSelection: OmpGenerationSelection | null = null;
  private previousSelection: OmpGenerationSelection | null = null;
  private failure: OmpGenerationStatus['failure'];
  private readonly sessions = new Set<HostedSession>();
  private readonly projections = new Map<string, { child: Promise<OmpChild>; readers: number }>();
  private activation: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ProcessOmpRuntimeOptions) {}

  async initialize(): Promise<void> {
    const path = dirname(this.options.entrypoint);
    const manifest = executableArtifactManifestSchema.parse(JSON.parse(await readFile(executableManifestPath(path), 'utf8')));
    this.channelSelection = { path, hash: manifest.treeHash, sha: null, manifestHash: this.options.manifestHash };
    let selection: OmpGenerationSelection;
    try {
      selection = ompGenerationSelectionSchema.parse(JSON.parse(await readFile(join(this.options.environmentRoot, 'omp-selection.json'), 'utf8')));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      selection = await this.stageChannel();
    }
    await this.verify(selection);
    await this.persistSelection(selection);
    this.selected = selection;
  }

  async activateChannel(): Promise<OmpGenerationStatus> {
    if (!this.channelSelection) throw new Error('OMP runtime has not initialized');
    return this.activate(await this.stageChannel());
  }

  /** Image/CLI boot paths may change on a machine-only upgrade; selected OMP bytes must not. */
  private async stageChannel(): Promise<OmpGenerationSelection> {
    const source = this.channelSelection;
    if (!source) throw new Error('OMP runtime has not initialized');
    const path = join(this.options.environmentRoot, 'omp-generations', source.manifestHash.slice(7));
    const expected = { target: 'omp' as const, hash: source.hash, manifestHash: source.manifestHash };
    try {
      await validateExecutableArtifact(path, expected);
      return { ...source, path };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await validateExecutableArtifact(source.path, expected);
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.stage-${crypto.randomUUID()}`;
    try {
      await cp(source.path, staged, { recursive: true, preserveTimestamps: true });
      const manifest = await readFile(executableManifestPath(source.path));
      try { await writeFile(executableManifestPath(path), manifest, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
      try { await rename(staged, path); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error; }
      await validateExecutableArtifact(path, expected);
      return { ...source, path };
    } finally { await rm(staged, { recursive: true, force: true }); }
  }

  private async verify(selection: OmpGenerationSelection): Promise<void> {
    await validateExecutableArtifact(selection.path, { target: 'omp', hash: selection.hash, manifestHash: selection.manifestHash });
    const child = spawnChild(join(selection.path, 'omp.js'), noCallbacks);
    try { await health(child); } finally { await child.close(); }
  }

  status(): OmpGenerationStatus {
    if (!this.selected) throw new Error('OMP runtime has not initialized');
    return { sha: this.selected.sha, hash: this.selected.hash, draining: [...this.sessions].filter((session) => session.generation.hash !== this.selected!.hash).length, ...(this.failure ? { failure: this.failure } : {}) };
  }

  activate(input: OmpGenerationSelection): Promise<OmpGenerationStatus> {
    const operation = this.activation.then(async () => {
      const previous = this.selected;
      if (!previous) throw new Error('OMP runtime has not initialized');
      input = ompGenerationSelectionSchema.parse(input);
      await this.verify(input);
      await this.persistSelection(input);
      this.selected = input;
      this.previousSelection = previous;
      this.failure = undefined;
      const moved = await Promise.allSettled([...this.sessions].map((session) => session.migrate()));
      const failures = moved.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) {
        await this.persistSelection(previous);
        this.selected = previous;
        if (input.sha) this.failure = { sha: input.sha, error: 'OMP session migration failed' };
        const restored = await Promise.allSettled([...this.sessions].map((session) => session.migrate()));
        throw new AggregateError([...failures, ...restored.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])], 'OMP generation activation failed; previous generation selected');
      }
      await this.retireProjections();
      return this.status();
    });
    this.activation = operation.catch(() => undefined);
    return operation;
  }

  private recoverGeneration(target: OmpGenerationSelection, error: unknown): void {
    this.options.onError?.(error);
    const previous = this.previousSelection;
    if (!previous) return;
    const recovery = this.activation.then(async () => {
      if (this.selected?.hash !== target.hash) return;
      if (target.sha) this.failure = { sha: target.sha, error: error instanceof Error ? error.message : String(error) };
      await this.verify(previous);
      await this.persistSelection(previous);
      this.selected = previous;
      this.previousSelection = null;
      const restored = await Promise.allSettled([...this.sessions].map((session) => session.migrate()));
      for (const result of restored) if (result.status === 'rejected') this.options.onError?.(result.reason);
    });
    this.activation = recovery.catch((cause) => this.options.onError?.(cause));
  }

  private async persistSelection(selection: OmpGenerationSelection): Promise<void> {
    await mkdir(this.options.environmentRoot, { recursive: true });
    const path = join(this.options.environmentRoot, 'omp-selection.json');
    const temporary = `${path}.${crypto.randomUUID()}`;
    await writeFile(temporary, JSON.stringify(selection), { mode: 0o600 });
    await rename(temporary, path);
  }

  transcript(sessionFile: string): Promise<OmpTranscriptEvent[]> {
    if (!this.selected) throw new Error('OMP runtime has not initialized');
    return this.project({ sessionFile }, this.selected);
  }

  checkpointTranscript(bytes: Uint8Array): Promise<OmpTranscriptEvent[]> {
    if (!this.selected) throw new Error('OMP runtime has not initialized');
    return this.project({ bytes }, this.selected);
  }

  private async project(input: { sessionFile: string } | { bytes: Uint8Array }, selection: OmpGenerationSelection): Promise<OmpTranscriptEvent[]> {
    let projection = this.projections.get(selection.hash);
    if (!projection) {
      const child = spawnChild(join(selection.path, 'omp.js'), noCallbacks);
      projection = {
        readers: 0,
        child: health(child).then(() => child).catch(async (error) => { await child.close(); throw error; }),
      };
      this.projections.set(selection.hash, projection);
    }
    projection.readers += 1;
    let child: OmpChild | undefined;
    try {
      child = await projection.child;
      return await child.rpc.call('transcript', [input], AbortSignal.timeout(30_000));
    } catch (error) {
      if (!child?.alive()) {
        if (this.projections.get(selection.hash) === projection) this.projections.delete(selection.hash);
        await child?.close();
      }
      throw error;
    } finally {
      projection.readers -= 1;
      await this.retireProjections();
    }
  }

  private async retireProjections(): Promise<void> {
    await Promise.all([...this.projections].flatMap(([hash, projection]) => {
      if (hash === this.selected?.hash || projection.readers > 0) return [];
      this.projections.delete(hash);
      return [projection.child.then((child) => child.close(), () => undefined)];
    }));
  }

  create(input: OmpSessionInput): Promise<OmpRuntimeSession> { return this.boot(input); }
  open(input: OmpSessionInput & { sessionFile: string }): Promise<OmpRuntimeSession> { return this.boot(input); }

  async dispose(): Promise<void> {
    try { await Promise.all([...this.sessions].map((session) => session.dispose())); }
    finally {
      this.selected = null;
      await Promise.all([...this.projections.values()].map((projection) => projection.child.then((child) => child.close(), () => undefined)));
      this.projections.clear();
    }
  }


  async reloadAuthStorage(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.reloadAuth()));
  }
  private async boot(input: OmpSessionInput): Promise<OmpRuntimeSession> {
    if (!this.selected) throw new Error('OMP runtime has not initialized');
    const events = new Set<(event: OmpRuntimeEvent) => void>();
    const activities = new Set<(activity: SessionActivity, errorMessage?: string) => void>();
    let activity: { activity: SessionActivity; errorMessage?: string } = { activity: { active: false, reasons: [] } };
    let projected: ProjectedMcpSession | null = null;
    let sessionId = '';
    let sessionFile = input.sessionFile;
    let operations = 0;
    let migration: Promise<void> | null = null;
    let disposed = false;
    let hosted: HostedSession;
    const namespaces: { space?: OmpEvalNamespace; mcp?: OmpEvalNamespace } = {};
    const localProtocolOptions = {
      getArtifactsDir: () => input.artifactsDir,
      getSessionId: () => sessionId,
      getLocalMounts: (): Record<string, 'read' | 'write'> => input.workspaceId === null ? { base: 'write' } : { base: 'read', workspace: 'write' },
    };
    if (this.options.spaceAuthority) namespaces.space = createSpaceEvalNamespace(this.options.spaceAuthority, input.projectId, input.workspaceId, this.options.workspaceControls?.());
    if (this.options.mcp) {
      projected = await this.options.mcp.createSession({ projectId: input.projectId, workspaceId: input.workspaceId, workspacePath: input.workingDirectory });
      namespaces.mcp = projected.evalNamespace(localProtocolOptions);
    }
    const catalog = (): OmpMcpCatalog => {
      const manager = projected?.manager;
      const servers = manager?.getConnectedServers() ?? [];
      return {
        servers,
        instructions: [...(manager?.getServerInstructions() ?? [])],
        prompts: Object.fromEntries(servers.map((name) => [name, manager!.getServerPrompts(name) ?? []])),
        resources: Object.fromEntries(servers.map((name) => [name, manager!.getServerResources(name) ?? { resources: [], templates: [] }])),
      };
    };
    const descriptors = (): OmpToolDescriptor[] => (projected?.tools() ?? []).map((tool) => ({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      ...(tool.hidden !== undefined ? { hidden: tool.hidden } : {}),
      ...(tool.loadMode !== undefined ? { loadMode: tool.loadMode } : {}),
      ...(tool.deferrable !== undefined ? { deferrable: tool.deferrable } : {}),
      ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
      ...(tool.mcpServerName ? { mcpServerName: tool.mcpServerName } : {}),
      ...(tool.mcpToolName ? { mcpToolName: tool.mcpToolName } : {}),
    }));
    const migrateWhenIdle = (): void => {
      const target = this.selected;
      if (!target || !hosted || operations > 0 || activity.activity.active) return;
      void hosted.migrate().catch((error) => this.recoverGeneration(target, error));
    };
    const notify = (notification: OmpNotification): void => {
      if (notification.type === 'event') {
        projected?.recordToolEvent(notification.event);
        for (const handler of events) handler(notification.event);
      } else if (notification.type === 'activity') {
        activity = { activity: notification.activity, ...(notification.errorMessage ? { errorMessage: notification.errorMessage } : {}) };
        for (const handler of activities) handler(activity.activity, activity.errorMessage);
        migrateWhenIdle();
      }
    };
    const start = async (generation: OmpGenerationSelection): Promise<OmpChild> => {
      const child = spawnChild(join(generation.path, 'omp.js'), {
        namespace: async ([request], signal) => {
          const namespace = namespaces[request.namespace];
          if (!namespace) throw new Error(`Namespace ${request.namespace} is unavailable`);
          return namespace.call(request.method, request.args, signal);
        },
        executeTool: async ([request], signal) => {
          const tool = projected?.tools().find((candidate) => candidate.name === request.name);
          if (!tool) throw new Error(`MCP tool ${request.name} is unavailable`);
          return tool.execute(request.callId, request.args as Record<string, unknown>, (update) => child.rpc.publish({ type: 'toolUpdate', callId: request.callId, update }), { localProtocolOptions } as never, signal);
        },
        mcpResources: async ([server]) => { await projected?.manager.ensureServerResources(server); return projected?.manager.getServerResources(server); },
        mcpReadResource: ([server, uri], signal) => projected?.manager.readServerResource(server, uri, { signal }),
        mcpPrompt: ([server, name, args], signal) => projected?.manager.executePrompt(server, name, args, { signal }),
      }, notify);
      try {
        await health(child);
        const opened = await child.rpc.call('initialize', [{
          agentDir: this.options.agentDir, sessionRoot: this.options.sessionRoot, skills: this.options.skills ?? [],
          input: { ...input, ...(sessionFile ? { sessionFile } : {}) }, tools: descriptors(), mcpCatalog: catalog(),
          namespaces: { ...(namespaces.space ? { space: namespaces.space.declaration } : {}), ...(namespaces.mcp ? { mcp: namespaces.mcp.declaration } : {}) },
        }], AbortSignal.timeout(120_000));
        sessionId = opened.id;
        sessionFile = opened.sessionFile;
        activity = { activity: opened.activity };
        return child;
      } catch (error) { await child.close(); throw error; }
    };
    const ensureChild = async (): Promise<void> => {
      if (migration) await migration;
      if (hosted.child.alive()) return;
      migration = start(hosted.generation).then((child) => { hosted.child = child; });
      try { await migration; } finally { migration = null; }
    };
    let initial: OmpChild;
    const initialGeneration = this.selected;
    try { initial = await start(initialGeneration); }
    catch (error) { await projected?.dispose(); throw error; }
    hosted = {
      generation: initialGeneration,
      child: initial,
      migrate: async () => {
        if (migration) return migration;
        if (disposed || operations > 0 || activity.activity.active || hosted.generation.hash === this.selected?.hash) return;
        const target = this.selected!;
        migration = (async () => {
          const old = hosted.generation;
          const controls = hosted.child.alive() ? await hosted.child.rpc.call('control', []) : null;
          if (hosted.child.alive()) {
            await hosted.child.rpc.call('persist', []);
            await hosted.child.rpc.call('dispose', []);
          }
          await hosted.child.close();
          const checkpoint = `${sessionFile!}.generation-${crypto.randomUUID()}`;
          await cp(sessionFile!, checkpoint);
          try {
            hosted.child = await start(target);
            if (controls) {
              await hosted.child.rpc.call('setThinking', [controls.thinking]);
              await hosted.child.rpc.call('setFast', [controls.fastMode]);
              await hosted.child.rpc.call('setApproval', [controls.approvalMode]);
            }
            hosted.generation = target;
          } catch (error) {
            await hosted.child.close();
            await rename(checkpoint, sessionFile!);
            hosted.child = await start(old);
            if (controls) {
              await hosted.child.rpc.call('setThinking', [controls.thinking]);
              await hosted.child.rpc.call('setFast', [controls.fastMode]);
              await hosted.child.rpc.call('setApproval', [controls.approvalMode]);
            }
            throw error;
          } finally { await rm(checkpoint, { force: true }); }
        })();
        try { await migration; }
        finally { migration = null; }
      },
      reloadAuth: async () => { await ensureChild(); await hosted.child.rpc.call('reloadAuth', []); },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        try {
          if (migration) await migration;
          if (hosted.child.alive()) await hosted.child.rpc.call('dispose', []);
        }
        finally {
          unsubscribeNotifications?.();
          unsubscribeCatalog?.();
          try { await hosted.child.close(); }
          finally {
            try { await projected?.dispose(); }
            finally { this.sessions.delete(hosted); }
          }
        }
      },
    };
    this.sessions.add(hosted);
    const refreshMcp = async (): Promise<void> => { await ensureChild(); await hosted.child.rpc.call('refreshMcp', [descriptors(), catalog()]); };
    const unsubscribeNotifications = projected?.manager.addNotificationListener((server, method, params) => hosted.child.rpc.publish({ type: 'mcpNotification', server, method, params }));
    const unsubscribeCatalog = projected?.manager.addCatalogChangeListener(() => { void refreshMcp().catch((error) => this.options.onError?.(error)); });
    projected?.attach({ refresh: refreshMcp });
    const invoke = async <K extends SessionMethod | 'reloadSettings' | 'instructionsChanged'>(method: K, args: Parameters<OmpChildApi[K]>): Promise<Awaited<ReturnType<OmpChildApi[K]>>> => {
      if (disposed) throw new Error('OMP session has been disposed');
      await hosted.migrate();
      await ensureChild();
      operations += 1;
      try { return await hosted.child.rpc.call(method, args); }
      finally {
        operations -= 1;
        migrateWhenIdle();
      }
    };
    return {
      id: sessionId, sessionFile: sessionFile!,
      prompt: (text, options) => invoke('prompt', [text, options]),
      subscribe: (handler) => { events.add(handler); return () => events.delete(handler); },
      subscribeActivity: (handler) => { activities.add(handler); handler(activity.activity, activity.errorMessage); return () => activities.delete(handler); },
      activity: () => activity,
      persist: () => invoke('persist', []), handoff: () => invoke('handoff', []), resume: () => invoke('resume', []),
      reloadSettings: () => invoke('reloadSettings', []), dispose: () => hosted.dispose(),
      instructionsChanged: () => invoke('instructionsChanged', []),
      control: () => invoke('control', []), cycleRole: (direction) => invoke('cycleRole', [direction]),
      setModel: (provider, model) => invoke('setModel', [provider, model]), setThinking: (thinking) => invoke('setThinking', [thinking]),
      setFast: (enabled) => invoke('setFast', [enabled]), setApproval: (approval) => invoke('setApproval', [approval]),
      setGoal: (goal) => invoke('setGoal', [goal]), compact: (instructions) => invoke('compact', [instructions]),
      clearQueue: () => invoke('clearQueue', []), removeQueuedMessage: (kind, index) => invoke('removeQueuedMessage', [kind, index]),
      promoteQueuedMessage: (index) => invoke('promoteQueuedMessage', [index]), answerAsk: (id, answers) => invoke('answerAsk', [id, answers]),
      stop: () => invoke('stop', []), navigateTree: (id) => invoke('navigateTree', [id]), messages: () => invoke('messages', []),
    };
  }
}
