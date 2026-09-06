import { declareWorkerHostEntry } from '@oh-my-pi/pi-utils/worker-host';
import { postmortem } from '@oh-my-pi/pi-utils';
import { MCPManager, type MCPRequestOptions } from '@oh-my-pi/pi-coding-agent/mcp';
import { discoverAuthStorage, type AuthStorage, type CustomTool } from '@oh-my-pi/pi-coding-agent';
import { EmbeddedOmpRuntime, projectOmpCheckpointTranscript, projectOmpTranscript, type SessionMcpBridge } from './session.js';
import type { OmpRuntimeSession } from './contracts.js';
import { OMP_IPC_VERSION, OmpRpcPeer, type OmpChildApi, type OmpMachineApi, type OmpToolDescriptor, type OmpMcpCatalog } from './ipc.js';

async function startSessionHost(): Promise<void> {
  if (!process.send) throw new Error('OMP runtime requires a private machine IPC channel');
  let live: OmpRuntimeSession | null = null;
  let authStorage: AuthStorage | null = null;
  let refresh: ((tools: CustomTool[]) => Promise<void>) | null = null;
  let tools: CustomTool[] = [];
  let catalog: OmpMcpCatalog = { servers: [], instructions: [], prompts: {}, resources: {} };
  const notifications = new Set<(server: string, method: string, params: unknown) => void>();
  const toolUpdates = new Map<string, (update: unknown) => void>();
  const session = (): OmpRuntimeSession => {
    if (!live) throw new Error('OMP session has not initialized');
    return live;
  };
  const rpc = new OmpRpcPeer<OmpMachineApi, OmpChildApi>(
    (message) => {
      // Queue/control mutations may not emit an upstream event. Publish their
      // actual activity before acknowledging the operation across the boundary.
      if (message.kind === 'response' && live) rpc.publish({ type: 'activity', ...live.activity() });
      process.send!(message);
    },
    {
      health: async () => ({ protocolVersion: OMP_IPC_VERSION, platform: process.platform, arch: process.arch, bunVersion: Bun.version, pid: process.pid }),
      initialize: async ([input]) => {
        if (live) throw new Error('OMP child already owns a session');
        authStorage = await discoverAuthStorage(input.agentDir);
        tools = input.tools.map(remoteTool);
        catalog = input.mcpCatalog;
        // Connections, secret material and audits stay machine-owned. The child's
        // real manager exposes only the explicitly projected tools to subagents.
        class ProjectedManager extends MCPManager {
          override getTools(): CustomTool[] { return tools; }
          override getConnectedServers() { return catalog.servers; }
          override getServerInstructions() { return new Map(catalog.instructions); }
          override getServerPrompts(name: string) { return catalog.prompts[name]; }
          override getServerResources(name: string) { return catalog.resources[name]; }
          override async ensureServerResources(name: string): Promise<void> {
            const resources = await rpc.call('mcpResources', [name]);
            if (resources) catalog.resources[name] = resources;
          }
          override async readServerResource(name: string, uri: string, options?: MCPRequestOptions) {
            return rpc.call('mcpReadResource', [name, uri], options?.signal);
          }
          override async executePrompt(name: string, promptName: string, args?: Record<string, string>, options?: MCPRequestOptions) {
            return rpc.call('mcpPrompt', [name, promptName, args], options?.signal);
          }
          override addNotificationListener(handler: (server: string, method: string, params: unknown) => void): () => void {
            notifications.add(handler);
            return () => notifications.delete(handler);
          }
        }
        const manager = new ProjectedManager(input.input.workingDirectory);
        const bridge: SessionMcpBridge = {
          manager,
          tools: () => tools,
          attach: (target) => { refresh = (next) => target.refresh(next); },
          evalNamespace: () => ({
            declaration: input.namespaces.mcp ?? '{}',
            call: (method, args, signal) => rpc.call('namespace', [{ namespace: 'mcp', method, args }], signal),
          }),
          dispose: async () => { refresh = null; await manager.disconnectAll(); },
        };
        const runtime = new EmbeddedOmpRuntime({
          agentDir: input.agentDir,
          sessionRoot: input.sessionRoot,
          skills: input.skills,
          authStorage: async () => authStorage!,
          mcp: { createSession: async () => bridge },
          ...(input.namespaces.space ? { spaceNamespace: {
            declaration: input.namespaces.space,
            call: (method: string, args: unknown, signal?: AbortSignal) => rpc.call('namespace', [{ namespace: 'space', method, args }], signal),
          } } : {}),
        });
        live = input.input.sessionFile
          ? await runtime.open({ ...input.input, sessionFile: input.input.sessionFile })
          : await runtime.create(input.input);
        live.subscribe((event) => rpc.publish({ type: 'event', event }));
        live.subscribeActivity((activity, errorMessage) => rpc.publish({ type: 'activity', activity, ...(errorMessage ? { errorMessage } : {}) }));
        return { id: live.id, sessionFile: live.sessionFile, activity: live.activity().activity };
      },
      refreshMcp: async ([descriptors, nextCatalog]) => { catalog = nextCatalog; tools = descriptors.map(remoteTool); await refresh?.(tools); },
      transcript: async ([input]) => 'bytes' in input ? projectOmpCheckpointTranscript(input.bytes) : projectOmpTranscript(input.sessionFile),
      prompt: ([text, options]) => session().prompt(text, options),
      persist: () => session().persist(),
      handoff: () => session().handoff(),
      reloadSettings: () => session().reloadSettings?.(),
      instructionsChanged: () => session().instructionsChanged?.(),
      resume: () => session().resume(),
      dispose: async () => { if (live) await live.dispose(); live = null; },
      reloadAuth: async () => { await authStorage?.revalidateCredentials(); },
      control: () => session().control(),
      cycleRole: ([direction]) => session().cycleRole(direction),
      setModel: ([provider, model]) => session().setModel(provider, model),
      setThinking: ([thinking]) => session().setThinking(thinking),
      setFast: ([enabled]) => session().setFast(enabled),
      setApproval: ([approval]) => session().setApproval(approval),
      setGoal: ([input]) => session().setGoal(input),
      compact: ([instructions]) => session().compact(instructions),
      clearQueue: () => session().clearQueue(),
      removeQueuedMessage: ([kind, index]) => session().removeQueuedMessage(kind, index),
      promoteQueuedMessage: ([index]) => session().promoteQueuedMessage(index),
      answerAsk: ([id, answers]) => session().answerAsk(id, answers),
      stop: () => session().stop(),
      navigateTree: ([entryId]) => session().navigateTree(entryId),
      messages: () => session().messages(),
    },
    (notification) => {
      if (notification.type === 'toolUpdate') toolUpdates.get(notification.callId)?.(notification.update);
      if (notification.type === 'mcpNotification') {
        for (const handler of notifications) handler(notification.server, notification.method, notification.params);
      }
    },
  );
  function remoteTool(descriptor: OmpToolDescriptor): CustomTool {
    return {
      ...descriptor,
      execute: async (callId, args, onUpdate, _context, signal) => {
        if (onUpdate) toolUpdates.set(callId, (update) => onUpdate(update as Parameters<NonNullable<typeof onUpdate>>[0]));
        try { return await rpc.call('executeTool', [{ name: descriptor.name, callId, args }], signal) as Awaited<ReturnType<CustomTool['execute']>>; }
        finally { toolUpdates.delete(callId); }
      },
    };
  }
  process.on('message', (message) => rpc.receive(message));
  process.once('disconnect', () => {
    rpc.close();
    void (async () => {
      try { await live?.dispose(); }
      finally {
        try { await postmortem.cleanup(); }
        finally { authStorage?.close(); }
      }
    })().then(() => process.exit(0), (error) => { console.error('[gitspace-omp] shutdown failed', error); process.exit(1); });
  });
}

declareWorkerHostEntry();
await startSessionHost();
