import {
  gitspaceContract, deploymentLaunchContract, createWorkspaceTerminalContract,
  listWorkspaceTerminalsContract, readWorkspaceTerminalContract, sendWorkspaceTerminalContract,
  stopWorkspaceTerminalContract, terminalEventsContract, terminalLiveContract,
  type GitSpaceRpcContext,
} from '@gitspace/protocol/rpc-contract';
import { contractDigest, err, ok, type AnyRouter } from 'result-rpc';
import { createFetchHandler, serverRpc } from 'result-rpc/server';
import { deviceCanAdminister } from '@gitspace/protocol/device-grant';
import { DeploymentLaunchError, type DeploymentLauncher } from './deployment-launcher.js';
import { callerFor } from './signed-rpc.js';
import { WorkspaceHubSpaceUnavailable, WorkspaceHubTerminalUnavailable, type WorkspaceHubTerminalCoordinator } from './workspace-hub.js';
import type { WorkspaceEnvironmentManager } from './workspace-environment.js';

/** Machines expose only explicitly addressed tools, never account authority. */
export type GitSpaceRpcRouterOptions = {
  terminals: WorkspaceHubTerminalCoordinator;
  environments?: WorkspaceEnvironmentManager;
  deployment?: Pick<DeploymentLauncher, 'launch'>;
  machineId: string;
  onInternalError?: (input: { incidentId: string; phase: string; cause: unknown; procedurePath?: string }) => void;
};

export function createGitSpaceRpcRouter(options: GitSpaceRpcRouterOptions) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const environment = (): WorkspaceEnvironmentManager => {
    if (!options.environments) throw new Error('Shared workspace lifecycle authority is unavailable');
    return options.environments;
  };
  const deploymentLaunch = server.implement(deploymentLaunchContract).handler(async ({ input, errors }) => {
    if (!options.deployment) return err(errors.OperationFailed({ operation: 'launch release', message: 'Deployment control is unavailable' }));
    // The account forwards a launch to the machine it names; no other machine builds it.
    if (input.machineId !== options.machineId) return err(errors.OperationFailed({ operation: 'launch release', message: `Launch for machine ${input.machineId} reached machine ${options.machineId}` }));
    try {
      return ok(options.deployment.launch({ workspaceId: input.workspaceId, targets: [...input.targets] }));
    } catch (error) {
      if (error instanceof DeploymentLaunchError && error.code === 'WORKSPACE_NOT_FOUND') return err(errors.WorkspaceNotFound({ workspaceId: input.workspaceId }));
      return err(errors.OperationFailed({ operation: 'launch release', message: error instanceof Error ? error.message : 'Unable to launch release' }));
    }
  });
  /** The account forwards a terminal call to the machine it names; no other machine answers for it. */
  const requireTerminalMachine = (machineId: string) => {
    if (machineId !== options.machineId) throw new Error(`Terminal request for machine ${machineId} reached machine ${options.machineId}`);
  };
  const terminalEvents = server.implement(terminalEventsContract).stream(async function* ({ input, errors, signal }) {
    try {
      requireTerminalMachine(input.machineId);
      for await (const event of options.terminals.events(input.spaceId, input.name, input.after, signal)) yield ok(event);
    } catch (error) {
      if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'follow workspace terminals', message: error instanceof Error ? error.message : 'Unable to follow workspace terminals' }));
    }
  });
  const terminalLive = server.implement(terminalLiveContract).stream(async function* ({ input, errors, signal, context }) {
    try {
      requireTerminalMachine(input.machineId);
      if (context.caller?.kind !== 'browser') throw new Error('Protected terminal output requires a browser session');
      for await (const output of options.terminals.live(input.spaceId, input.name, signal)) yield ok(output);
    } catch (error) {
      if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'follow protected workspace terminal', message: error instanceof Error ? error.message : 'Unable to follow protected workspace terminal' }));
    }
  });
  const listTerminals = server.implement(listWorkspaceTerminalsContract).handler(async ({ input, errors }) => {
    try {
      requireTerminalMachine(input.machineId);
      return ok(await options.terminals.list(input.spaceId));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      return err(errors.OperationFailed({ operation: 'list workspace terminals', message: error instanceof Error ? error.message : 'Unable to list terminals' }));
    }
  });
  const createTerminal = server.implement(createWorkspaceTerminalContract).handler(async ({ input, errors }) => {
    try {
      requireTerminalMachine(input.machineId);
      return ok(await options.terminals.createShell(input.spaceId));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      return err(errors.OperationFailed({ operation: 'create workspace terminal', message: error instanceof Error ? error.message : 'Unable to create terminal' }));
    }
  });
  const readTerminal = server.implement(readWorkspaceTerminalContract).handler(async ({ input, errors }) => {
    try {
      requireTerminalMachine(input.machineId);
      return ok(await options.terminals.read(input.spaceId, input.name, input.cursor));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      if (error instanceof WorkspaceHubTerminalUnavailable) return err(errors.TerminalNotFound({ spaceId: input.spaceId, name: input.name }));
      return err(errors.OperationFailed({ operation: 'read workspace terminal', message: error instanceof Error ? error.message : 'Unable to read terminal' }));
    }
  });
  const sendTerminal = server.implement(sendWorkspaceTerminalContract).handler(async ({ input, errors, context }) => {
    try {
      requireTerminalMachine(input.machineId);
      const terminal = (await options.terminals.list(input.spaceId)).find((entry) => entry.name === input.name);
      if (terminal?.protected && context.caller?.kind !== 'browser') throw new Error('Protected terminal input requires a browser session');
      return ok(await options.terminals.send(input.spaceId, input.name, input.data));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      if (error instanceof WorkspaceHubTerminalUnavailable) return err(errors.TerminalNotFound({ spaceId: input.spaceId, name: input.name }));
      return err(errors.OperationFailed({ operation: 'write workspace terminal', message: error instanceof Error ? error.message : 'Unable to write terminal' }));
    }
  });
  const stopTerminal = server.implement(stopWorkspaceTerminalContract).handler(async ({ input, errors, context }) => {
    try {
      requireTerminalMachine(input.machineId);
      const terminal = (await options.terminals.list(input.spaceId)).find((entry) => entry.name === input.name);
      if (terminal?.kind === 'lifecycle') {
        if (!deviceCanAdminister(context.caller, 'lifecycle.control')) throw new Error('Lifecycle terminal cancellation requires lifecycle-control authority');
        const view = await environment().view(input.spaceId);
        const run = view.runs.find((entry) => entry.terminalName === input.name);
        if (!run) throw new Error('Lifecycle terminal has no durable run identity');
        await environment().cancelRun(input.spaceId, run.id);
        return ok((await options.terminals.list(input.spaceId)).find((entry) => entry.name === input.name) ?? terminal);
      }
      return ok(await options.terminals.stop(input.spaceId, input.name));
    } catch (error) {
      if (error instanceof WorkspaceHubSpaceUnavailable) return err(errors.WorkspaceNotFound({ workspaceId: input.spaceId }));
      if (error instanceof WorkspaceHubTerminalUnavailable) return err(errors.TerminalNotFound({ spaceId: input.spaceId, name: input.name }));
      return err(errors.OperationFailed({ operation: 'stop workspace terminal', message: error instanceof Error ? error.message : 'Unable to stop terminal' }));
    }
  });
  return server.router({
    deployment: { launch: deploymentLaunch },
    terminals: { events: terminalEvents, live: terminalLive, list: listTerminals, create: createTerminal, read: readTerminal, send: sendTerminal, stop: stopTerminal },
  });
}

/** Procedure kind by dotted path, for the signed handler's capability derivation. */
export function procedureKinds(router: AnyRouter): (path: string) => 'query' | 'mutation' | 'subscription' | null {
  return path => router.procedures.get(path)?._def.kind ?? null;
}

const RPC_CONTRACT_VERSION = contractDigest(gitspaceContract);

export function createGitSpaceRpcHandler(options: GitSpaceRpcRouterOptions) {
  const router = createGitSpaceRpcRouter(options);
  const handler = createFetchHandler({
    router,
    // Cloud and machine routers implement different slices of the same public contract.
    contractVersion: RPC_CONTRACT_VERSION,
    endpoint: '/rpc',
    createContext: ({ request }) => {
      const caller = callerFor(request);
      return caller ? { caller } : {};
    },
    onInternalError: options.onInternalError,
  });
  return { handler, procedureKind: procedureKinds(router) };
}
