import { z } from 'zod';
import { daemonClientForProject, type DaemonRequest } from '@gitspace/supervisor';
import { checkoutPath, checkoutTerminalEnvironment, inheritedCommandEnvironment, runSupervisorCommand, type ExecutorOperationHandler } from '@gitspace/runtime-machine';
import type { WorkspaceEnvironmentManager } from './workspace-environment.js';
import type { WorkspaceServiceManager } from './workspace-services.js';
import { cacheServiceOperation } from './cache-services.js';
import { RuntimeServiceOperationSchema } from '@gitspace/protocol-runtime/services';
import { createHash } from 'node:crypto';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { MachineMcpCoordinator } from './local-mcp.js';
import { RuntimeBashCommandArgumentsSchema, RuntimeProcArgumentsSchema, RuntimeLifecycleDispatchArgumentsSchema, RuntimeImportRefArgumentsSchema } from '@gitspace/protocol-runtime';
import type { ArtifactsGitRemote } from './artifacts-git-remote.js';
import { workspaceProcessVisible } from './workspace-process.js';


async function runGit(cwd: string, args: string[], environment: Record<string, string>, signal: AbortSignal): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, env: { ...Bun.env, ...environment, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', signal });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exited with ${code}`}`);
  return stdout.trim();
}

export function machineOperationalTools(options: { environments: Pick<WorkspaceEnvironmentManager, 'acceptRun'>; services: WorkspaceServiceManager; authority: CloudSpaceCheckpointAuthority; mcp: MachineMcpCoordinator; projectRepository: Pick<ArtifactsGitRemote, 'publishRef'>; originEnvironment: (repositoryPath: string) => Promise<Record<string, string>> }): Record<string, ExecutorOperationHandler> {
  return {
    // Fetches into a private ref and publishes from there: the base checkout's HEAD, index and branches never change.
    import_ref: async (dispatch, local, signal) => {
      if (String(dispatch.workspaceId) !== String(dispatch.projectId)) throw new Error('Refs are imported through the project base checkout');
      const { ref } = RuntimeImportRefArgumentsSchema.parse(dispatch.args);
      const owned = `refs/gitspace/import/${createHash('sha256').update(dispatch.attemptId).digest('hex').slice(0, 32)}`;
      await runGit(local.rootPath, ['fetch', '--no-tags', '--refmap=', '--no-write-fetch-head', 'origin', `+${ref}:${owned}`], { ...await options.originEnvironment(local.rootPath), GIT_LFS_SKIP_SMUDGE: '1' }, signal);
      try {
        const commit = await runGit(local.rootPath, ['rev-parse', '--verify', `${owned}^{commit}`], {}, signal);
        await options.projectRepository.publishRef({ binding: { projectId: dispatch.projectId, repository: `project-${dispatch.projectId}` }, repositoryPath: local.rootPath, ref, commit });
        return [{ type: 'text', text: JSON.stringify({ ref, commit }) }];
      } finally {
        await runGit(local.rootPath, ['update-ref', '-d', owned], {}, AbortSignal.timeout(10_000)).catch(() => undefined);
      }
    },
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
    lifecycle: async (dispatch, local) => {
      const { on: _on, ...args } = RuntimeLifecycleDispatchArgumentsSchema.parse(dispatch.args);
      const accepted = await options.environments.acceptRun(dispatch.workspaceId, args, local);
      return [{ type: 'text', text: JSON.stringify(accepted) }];
    },
    service: async (dispatch, local) => {
      const args = RuntimeServiceOperationSchema.parse(dispatch.args);
      const result = await cacheServiceOperation(options.services, local, args);
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    bash: async (dispatch, local, signal) => {
      const args = z.union([
        RuntimeBashCommandArgumentsSchema,
        z.object({ op: z.enum(['logs', 'cancel']), attemptId: z.string().min(1), lines: z.number().int().positive().max(10_000).optional(), head: z.boolean().optional(), cursor: z.number().int().nonnegative().optional() }).strict(),
      ]).parse(dispatch.args);
      if ('command' in args) {
        const result = await runSupervisorCommand({ application: '/bin/bash', args: ['-c', args.command], cwd: args.cwd ? await checkoutPath(local.rootPath, args.cwd) : local.rootPath, env: await checkoutTerminalEnvironment(local.rootPath, inheritedCommandEnvironment()), attemptId: dispatch.attemptId, sequence: 0, deadlineAt: dispatch.deadlineAt, signal });
        return [{ type: 'text', text: JSON.stringify(result) }];
      }
      const client = await daemonClientForProject(local.rootPath);
      const name = `exec-${createHash('sha256').update(`${args.attemptId}:0`).digest('hex').slice(0, 40)}`;
      const described = await client.request({ op: 'describe', name }, signal);
      if (described.op !== 'describe' || described.daemon.owner !== args.attemptId) throw new Error('No background command with that id in this workspace');
      const result = args.op === 'cancel' ? await client.request({ op: 'stop', name, timeoutMs: 5000 }, signal)
        : await client.request({ op: 'logs', name, lines: args.lines, head: args.head, cursor: args.cursor }, signal);
      return [{ type: 'text', text: JSON.stringify(result) }];
    },
    proc: machineProcessOperation(options),
  };
}

export function machineProcessOperation(options: { services: WorkspaceServiceManager }): ExecutorOperationHandler {
  return async (dispatch, local, signal) => {
      const args = RuntimeProcArgumentsSchema.parse(dispatch.args);
      const client = await daemonClientForProject(local.rootPath);
      const owner = `workspace:${dispatch.projectId}:${dispatch.workspaceId}`;
      const mutate = async (request: DaemonRequest) => {
        try { return await client.request(request, signal); }
        catch (error) { throw new Error('Supervisor mutation outcome requires reconciliation', { cause: error }); }
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
          if (readiness.op !== 'wait' || readiness.daemon.id !== result.daemon.id || readiness.timedOut || readiness.daemon.readiness?.timedOut || readiness.daemon.state !== 'ready') throw new Error('Process did not become ready with the admitted identity');
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
        if (readiness.op !== 'wait' || readiness.daemon.id !== result.daemon.id || readiness.timedOut || readiness.daemon.readiness?.timedOut || readiness.daemon.state !== 'ready') throw new Error('Process did not become ready with the admitted identity');
        const url = existing.spec.ready.port ? await options.services.registerProcessRoute({ projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, generation: dispatch.generation, name: args.name, portName: 'http', port: existing.spec.ready.port }) : null;
        return [{ type: 'text', text: JSON.stringify({ op: 'restart', daemon: readiness.daemon, url }) }];
      }
      return [{ type: 'text', text: JSON.stringify(result) }];
  };
}
