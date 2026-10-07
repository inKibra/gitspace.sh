import { z } from 'zod';
import { daemonClientForProject, type DaemonRequest } from '@gitspace/supervisor';
import { checkoutPath, mergeDelegateCommit, runSupervisorCommand, ExecutorEffectUncertain, type ExecutorJournal, type ExecutorOperationHandler } from '@gitspace/runtime-machine';
import type { WorkspaceEnvironmentManager } from './workspace-environment.js';
import type { WorkspaceServiceManager } from './workspace-services.js';
import { replicaServiceOperation } from './replica-services.js';
import { RuntimeServiceOperationSchema } from '@gitspace/protocol-runtime/services';
import { createHash } from 'node:crypto';
import { type SpaceWorkspaceControls } from './space-workspace-controls.js';
import { RuntimeWorkspaceMutationArgumentsSchema } from '@gitspace/protocol/inspector-contract';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { LocalArtifactResolver } from '@gitspace/core';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineMcpCoordinator } from './local-mcp.js';
import { RuntimeBashCommandArgumentsSchema, RuntimeSpacePhaseArgumentsSchema, RuntimeDelegateExportArgumentsSchema, RuntimeProcArgumentsSchema, RuntimeAgentLifecycleRunArgumentsSchema } from '@gitspace/protocol-runtime';
import { workspaceProcessVisible } from './workspace-process.js';


export function machineOperationalTools(options: { environments: WorkspaceEnvironmentManager; services: WorkspaceServiceManager; authority: CloudSpaceCheckpointAuthority; controls: SpaceWorkspaceControls; artifacts: LocalArtifactResolver; mcp: MachineMcpCoordinator; journal: () => ExecutorJournal }): Record<string, ExecutorOperationHandler> {
  return {
    mcp_discover: async (dispatch, local, signal) => {
      const workspace = (await options.authority.listProjectWorkspaces(dispatch.projectId)).find(workspace => workspace.id === dispatch.workspaceId);
      if (!workspace) throw new Error('MCP workspace is no longer registered');
      const result = await options.mcp.execute({ projectId: dispatch.projectId, workspaceId: workspace.kind === 'base' ? null : workspace.id, workspacePath: local.rootPath, operation: 'discover', args: dispatch.args, signal });
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    mcp_invoke: async (dispatch, local, signal) => {
      const workspace = (await options.authority.listProjectWorkspaces(dispatch.projectId)).find(workspace => workspace.id === dispatch.workspaceId);
      if (!workspace) throw new Error('MCP workspace is no longer registered');
      const result = await options.mcp.execute({ projectId: dispatch.projectId, workspaceId: workspace.kind === 'base' ? null : workspace.id, workspacePath: local.rootPath, operation: 'invoke', args: dispatch.args, signal });
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    create: async (dispatch, local) => {
      if (local.attachment.role !== 'cache') throw new Error('Workspace changes require a cache attachment');
      const request = RuntimeWorkspaceMutationArgumentsSchema.parse(dispatch.args);
      if (request.workspaceId !== undefined && request.workspaceId !== dispatch.workspaceId) throw new Error('Workspace target is outside this dispatch');
      let result: unknown;
      if (request.method === 'create') {
        const { method: _method, workspaceId: _workspaceId, on: _on, at: _at, goal, workflow, rubric, ...workspace } = request;
        const created = await options.controls.create({ ...workspace, projectId: dispatch.projectId });
        const identity = { projectId: dispatch.projectId, spaceId: created.workspace.id };
        const initialized: string[] = [];
        let initializing = 'goal';
        const publish = async (entity: string, value: { id: string; revision: number }) => {
          await options.authority.appendProjectEvent({ eventId: crypto.randomUUID(), projectId: dispatch.projectId,
            scope: 'workspace', entity, entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: identity.spaceId } });
          await options.controls.instructionsChanged(identity.projectId, identity.spaceId);
          initialized.push(entity);
        };
        try {
          if (goal) await publish('goal', await options.authority.putInspectorGoal({ ...identity, expectedRevision: 0, goal }));
          initializing = 'workflow';
          if (workflow) await publish('workflow', await options.authority.putInspectorWorkflow({ ...identity, expectedRevision: 0, workflow }));
          initializing = 'rubric';
          if (rubric) await publish('rubric', await options.authority.putInspectorRubric({ ...identity, expectedRevision: 0, rubric }));
          result = { ...created, identity, ready: true, initialized };
        } catch (error) {
          result = { ...created, identity, ready: false, initialized, error: { operation: `${initializing}.put`,
            message: error instanceof Error ? error.message : String(error),
            recovery: 'The workspace exists. Read its latest records and reconcile the incomplete instruction writes; do not recreate it.' } };
        }
      } else {
        const definition = (await options.authority.listProjectWorkspaces(dispatch.projectId)).find(workspace => workspace.id === dispatch.workspaceId && workspace.projectId === dispatch.projectId);
        if (!definition) throw new Error('Workspace does not exist in the current project');
        result = await options.controls.manage(request.method, definition, request);
      }
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    workspace_phase: async (dispatch, local) => {
      if (local.attachment.role !== 'cache') throw new Error('Phase changes require a canonical cache');
      const { phase } = RuntimeSpacePhaseArgumentsSchema.parse(dispatch.args);
      const definition = (await options.authority.listProjectWorkspaces(dispatch.projectId)).find(workspace => workspace.id === dispatch.workspaceId && workspace.projectId === dispatch.projectId);
      if (!definition || definition.kind === 'base') throw new Error('Phase changes require a workspace in the current project');
      await options.controls.manage('setPhase', definition, { expectedRevision: definition.revision, phase });
      return [{ type: 'text', text: `Workspace phase set to ${phase}` }];
    },
    lifecycle: async (dispatch, local) => {
      if (local.attachment.role !== 'cache') throw new Error('Lifecycle requires a canonical cache');
      const { on: _on, at: _at, ...args } = RuntimeAgentLifecycleRunArgumentsSchema.parse(dispatch.args);
      const accepted = await options.environments.acceptRun(dispatch.workspaceId, args, local);
      return [{ type: 'text', text: JSON.stringify(accepted) }];
    },
    service: async (dispatch, local) => {
      const args = RuntimeServiceOperationSchema.parse(dispatch.args);
      const result = await replicaServiceOperation(options.services, local, args);
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    bash: async (dispatch, local, signal) => {
      const args = z.union([
        RuntimeBashCommandArgumentsSchema,
        z.object({ op: z.enum(['logs', 'cancel']), attemptId: z.string().min(1), lines: z.number().int().positive().max(10_000).optional(), head: z.boolean().optional(), cursor: z.number().int().nonnegative().optional() }).strict(),
      ]).parse(dispatch.args);
      if ('command' in args) {
        const result = await runSupervisorCommand({ application: '/bin/bash', args: ['-c', args.command], cwd: args.cwd ? await checkoutPath(local.rootPath, args.cwd) : local.rootPath, attemptId: dispatch.attemptId, sequence: 0, deadlineAt: dispatch.deadlineAt, signal });
        return [{ type: 'text', text: JSON.stringify(result) }];
      }
      const control = options.journal().jobControl(dispatch);
      if (!control) throw new Error('Invalid admitted job control');
      const { job } = control;
      const cwd = job.cwd ? await checkoutPath(local.rootPath, job.cwd) : local.rootPath;
      const client = await daemonClientForProject(cwd);
      const name = `exec-${createHash('sha256').update(`${control.attemptId}:0`).digest('hex').slice(0, 40)}`;
      const described = await client.request({ op: 'describe', name }, signal);
      // Match the same immutable command evidence required by executor recovery.
      if (described.op !== 'describe' || described.daemon.owner !== control.attemptId || described.daemon.name !== name || described.daemon.restartCount !== 0
        || described.spec.application !== '/bin/bash' || JSON.stringify(described.spec.args) !== JSON.stringify(['-c', job.command]) || described.spec.cwd !== cwd
        || described.spec.restart !== 'no' || described.spec.pty || described.spec.inheritEnv !== false || !described.spec.persist || described.spec.detached) throw new Error('Supervisor evidence does not match immutable job admission');
      const result = args.op === 'cancel' ? await client.request({ op: 'stop', name, timeoutMs: 5000 }, signal)
        : await client.request({ op: 'logs', name, lines: args.lines, head: args.head, cursor: args.cursor }, signal);
      const confirmed = await client.request({ op: 'describe', name }, signal);
      if (confirmed.op !== 'describe' || confirmed.daemon.id !== described.daemon.id || confirmed.daemon.restartCount !== 0
        || (result.op !== 'logs' && result.op !== 'stop')
        || (result.op === 'stop' && result.daemon.id !== described.daemon.id)) throw new Error('Supervisor identity changed during job control');
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    proc: machineProcessOperation(options),
    delegate_export: async (dispatch, local, signal) => {
      if (local.attachment.role !== 'delegate' || local.attachment.checkout.kind !== 'branch') throw new Error('Only delegated branches may export integration commits');
      const args = RuntimeDelegateExportArgumentsSchema.parse(dispatch.args);
      const directory = await mkdtemp(join(tmpdir(), 'gitspace-delegate-'));
      let sequence = 0;
      const run = async (args: string[]) => {
        const result = await runSupervisorCommand({ application: 'git', args, cwd: local.rootPath, attemptId: dispatch.attemptId, sequence: sequence++, deadlineAt: dispatch.deadlineAt, signal });
        if (result.exitCode !== 0) throw new Error(result.output);
        return result.output.trim();
      };
      try {
        if (await run(['rev-parse', 'HEAD']) !== args.commit) throw new Error('Delegate HEAD changed before export');
        await run(['merge-base', '--is-ancestor', local.attachment.checkout.commit, args.commit]);
        const path = join(directory, 'branch.bundle');
        await run(['bundle', 'create', path, 'HEAD']);
        const uri = `local://workspace/delegates/${encodeURIComponent(dispatch.attachmentId)}/${args.commit}.bundle`;
        const result = await options.artifacts.write({ kind: 'workspace', projectId: dispatch.projectId, workspaceId: dispatch.workspaceId }, uri, await readFile(path));
        if (result.status === 'error') throw result.error;
        return [{ type: 'text', text: JSON.stringify({ bundleUri: uri, commit: args.commit, sourceCommit: local.attachment.checkout.commit }) }];
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    merge: async (dispatch, local, signal) => {
      const args = z.object({ delegateAttachmentId: z.string().optional(), bundleUri: z.string().optional(), expectedPrimaryCommit: z.string().regex(/^[a-f0-9]{40,64}$/u), commit: z.string().regex(/^[a-f0-9]{40,64}$/u) }).parse(dispatch.args);
      if (local.attachment.role !== 'cache') throw new Error('Only the primary may integrate commits');
      if (args.bundleUri !== undefined) {
        if (!args.bundleUri.startsWith('local://workspace/delegates/')) throw new Error('Merge bundle must belong to this workspace delegate artifact scope');
        const artifact = await options.artifacts.read({ kind: 'workspace', projectId: dispatch.projectId, workspaceId: dispatch.workspaceId }, args.bundleUri);
        if (artifact.status === 'error') throw artifact.error;
        const directory = await mkdtemp(join(tmpdir(), 'gitspace-merge-'));
        let sequence = 0;
        const run = async (args: string[]) => {
          const result = await runSupervisorCommand({ application: 'git', args, cwd: local.rootPath, attemptId: dispatch.attemptId, sequence: sequence++, deadlineAt: dispatch.deadlineAt, signal });
          if (result.exitCode !== 0) throw new Error(result.output);
          return result.output.trim();
        };
        try {
          const path = join(directory, 'branch.bundle');
          await writeFile(path, artifact.value, { mode: 0o600 });
          await run(['bundle', 'verify', path]);
          if (await run(['rev-parse', 'HEAD']) !== args.expectedPrimaryCommit || await run(['status', '--porcelain'])) throw new Error('Primary changed or contains uncommitted work');
          await run(['fetch', '--no-tags', '--', path, 'HEAD']);
          if (await run(['rev-parse', 'FETCH_HEAD']) !== args.commit) throw new Error('Bundle source commit does not match the authorized merge');
          await run(['merge', '--no-edit', '--no-ff', args.commit]);
          return [{ type: 'text', text: JSON.stringify({ commit: await run(['rev-parse', 'HEAD']), sourceCommit: args.commit }) }];
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      if (!args.delegateAttachmentId) throw new Error('Merge requires a delegate attachment or exported bundle');
      const delegate = options.journal().attachment(args.delegateAttachmentId);
      if (!delegate || delegate.attachment.state !== 'ready') throw new Error('Delegate attachment is not ready');
      const result = await mergeDelegateCommit({ primary: local, delegate, expectedPrimaryCommit: args.expectedPrimaryCommit, commit: args.commit, attemptId: dispatch.attemptId, deadlineAt: dispatch.deadlineAt, signal });
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
  };
}

export function machineProcessOperation(options: { services: WorkspaceServiceManager }): ExecutorOperationHandler {
  return async (dispatch, local, signal) => {
      const args = RuntimeProcArgumentsSchema.parse(dispatch.args);
      const client = await daemonClientForProject(local.rootPath);
      const owner = `workspace:${dispatch.projectId}:${dispatch.workspaceId}`;
      const mutate = async (request: DaemonRequest) => {
        try { return await client.request(request, signal); }
        catch (error) { throw new ExecutorEffectUncertain('Supervisor mutation outcome requires reconciliation', { cause: error }); }
      };
      if (args.op === 'start') {
        const processes = await client.request({ op: 'list' }, signal);
        if (processes.op !== 'list') throw new Error('Invalid supervisor list response');
        if (processes.daemons.some(process => process.name === args.spec.name)) {
          const existing = await client.request({ op: 'describe', name: args.spec.name }, signal);
          if (existing.op !== 'describe' || !await workspaceProcessVisible(local.rootPath, existing)) throw new Error('Process name belongs to a private or out-of-workspace process');
        }
        const spec = { ...args.spec, cwd: args.spec.cwd ? await checkoutPath(local.rootPath, args.spec.cwd) : local.rootPath };
        const result = await mutate({ op: 'start', spec, owner });
        if (result.op !== 'start') throw new Error('Invalid supervisor start response');
        if (spec.ready) {
          const readiness = await client.request({ op: 'wait', name: spec.name, for: 'ready', timeoutMs: spec.ready.timeoutMs ?? 30_000 }, signal);
          if (readiness.op !== 'wait' || readiness.daemon.id !== result.daemon.id || readiness.timedOut || readiness.daemon.readiness?.timedOut || readiness.daemon.state !== 'ready') throw new ExecutorEffectUncertain('Process did not become ready with the admitted identity');
          const url = spec.ready.port ? await options.services.registerProcessRoute({ projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, generation: dispatch.generation, name: spec.name, portName: 'http', port: spec.ready.port }) : null;
          return [{ type: 'text', text: JSON.stringify({ op: 'start', daemon: readiness.daemon, url }) }];
        }
        return [{ type: 'text', text: JSON.stringify(result) }];
      }
      if (args.op === 'list') {
        const result = await client.request(args, signal);
        if (result.op !== 'list') throw new Error('Invalid supervisor list response');
        const visible = [];
        for (const process of result.daemons) {
          const described = await client.request({ op: 'describe', name: process.name }, signal);
          if (described.op === 'describe' && await workspaceProcessVisible(local.rootPath, described)) visible.push(process);
        }
        return [{ type: 'text', text: JSON.stringify(visible) }];
      }
      const existing = await client.request({ op: 'describe', name: args.name, ...(args.op === 'status' || args.op === 'describe' || args.op === 'stop' ? { instanceId: args.instanceId, restartCount: args.restartCount } : {}) }, signal);
      if (existing.op !== 'describe' || !await workspaceProcessVisible(local.rootPath, existing)) throw new Error('Private or out-of-workspace processes are not accessible');
      const result = args.op === 'send' || args.op === 'stop' || args.op === 'restart' ? await mutate(args) : args.op === 'status' || args.op === 'describe' ? existing : await client.request(args, signal);
      if (args.op === 'stop') await options.services.releaseProcessRoutes(dispatch.workspaceId, args.name);
      if (args.op === 'restart' && result.op === 'restart' && existing.spec.ready) {
        const readiness = await client.request({ op: 'wait', name: args.name, for: 'ready', timeoutMs: existing.spec.ready.timeoutMs ?? 30_000 }, signal);
        if (readiness.op !== 'wait' || readiness.daemon.id !== result.daemon.id || readiness.timedOut || readiness.daemon.readiness?.timedOut || readiness.daemon.state !== 'ready') throw new ExecutorEffectUncertain('Process did not become ready with the admitted identity');
        const url = existing.spec.ready.port ? await options.services.registerProcessRoute({ projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, generation: dispatch.generation, name: args.name, portName: 'http', port: existing.spec.ready.port }) : null;
        return [{ type: 'text', text: JSON.stringify({ op: 'restart', daemon: readiness.daemon, url }) }];
      }
      return [{ type: 'text', text: JSON.stringify(result) }];
  };
}
