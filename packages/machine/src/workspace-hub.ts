import { isAbsolute, relative, resolve } from 'node:path';
import type { GitSpaceDatabase } from '@gitspace/core';
import {
  daemonClientForProject,
  type DaemonBrokerClient,
} from '@oh-my-pi/pi-coding-agent/launch/client';
import type {
  DaemonSnapshot,
  DaemonSpec,
  DaemonState,
} from '@oh-my-pi/pi-coding-agent/launch/protocol';

export type WorkspaceTerminalKind = 'user' | 'agent' | 'lifecycle' | 'service';

export interface WorkspaceTerminalView {
  spaceId: string;
  name: string;
  id: string;
  kind: WorkspaceTerminalKind;
  state: DaemonState;
  machineId: string;
  owner: string | null;
  command: string;
  cwd: string;
  createdAt: Date;
  exitCode: number | null;
}

export interface WorkspaceTerminalOutput {
  spaceId: string;
  name: string;
  state: DaemonState;
  cursor: number;
  data: string;
}

export class WorkspaceHubSpaceUnavailable extends Error {
  constructor(readonly spaceId: string) {
    super(`Space ${spaceId} is unavailable on this machine`);
  }
}

export class WorkspaceHubTerminalUnavailable extends Error {
  constructor(readonly spaceId: string, readonly name: string) {
    super(`Terminal ${name} does not belong to space ${spaceId}`);
  }
}

type HubClientFactory = (projectDirectory: string) => Promise<DaemonBrokerClient>;

interface HubScope {
  space: NonNullable<ReturnType<GitSpaceDatabase['getSpace']>>;
  client: DaemonBrokerClient;
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function ownerFor(spaceId: string, kind: 'user' | 'lifecycle' | 'service'): string {
  return `gitspace:${spaceId}:${kind}`;
}

function terminalKind(spaceId: string, owner: string | undefined): WorkspaceTerminalKind {
  if (owner === ownerFor(spaceId, 'lifecycle')) return 'lifecycle';
  if (owner === ownerFor(spaceId, 'service') || owner?.startsWith(`${ownerFor(spaceId, 'service')}:`)) return 'service';
  if (owner === ownerFor(spaceId, 'user') || owner === undefined) return 'user';
  return 'agent';
}

function displayCommand(spec: DaemonSpec): string {
  return [spec.application, ...spec.args].join(' ');
}

export class WorkspaceHubTerminalCoordinator {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly machineId: string,
    private readonly clientForProject: HubClientFactory = daemonClientForProject,
  ) {}

  async list(spaceId: string): Promise<WorkspaceTerminalView[]> {
    const scope = await this.scope(spaceId);
    const listed = await scope.client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('OMP Hub returned an invalid list response');
    const activeDaemons = listed.daemons.filter((daemon) => daemon.state !== 'exited' && daemon.state !== 'failed');
    const terminals = await Promise.all(activeDaemons.map(async (daemon) => {
      const described = await scope.client.request({ op: 'describe', name: daemon.name });
      if (described.op !== 'describe') throw new Error(`OMP Hub returned an invalid describe response for ${daemon.name}`);
      return isInside(scope.space.rootPath, described.spec.cwd)
        ? this.view(spaceId, described.daemon, described.spec)
        : null;
    }));
    return terminals.filter((terminal): terminal is WorkspaceTerminalView => terminal !== null)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async createShell(spaceId: string): Promise<WorkspaceTerminalView> {
    const scope = await this.scope(spaceId);
    const shell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined) || '/bin/bash';
    const spec: DaemonSpec = {
      name: `gitspace-${spaceId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
      application: shell,
      args: [],
      env: {},
      cwd: scope.space.rootPath,
      pty: true,
      restart: 'no',
      persist: false,
      detached: false,
    };
    const started = await scope.client.request({ op: 'start', spec, owner: ownerFor(spaceId, 'user') });
    if (started.op !== 'start') throw new Error('OMP Hub returned an invalid start response');
    return this.view(spaceId, started.daemon, spec);
  }

  async startService(
    spaceId: string,
    serviceName: string,
    application: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<WorkspaceTerminalView> {
    const scope = await this.scope(spaceId);
    if (!isInside(scope.space.rootPath, cwd)) throw new WorkspaceHubSpaceUnavailable(spaceId);
    const name = `gitspace-svc-${spaceId.slice(0, 12)}-${serviceName}`;
    try {
      const described = await scope.client.request({ op: 'describe', name });
      if (described.op === 'describe' && described.daemon.state !== 'exited' && described.daemon.state !== 'failed') {
        return this.view(spaceId, described.daemon, described.spec);
      }
    } catch { /* Service is not running yet. */ }
    const spec: DaemonSpec = {
      name,
      application,
      args,
      env,
      cwd,
      pty: false,
      restart: 'no',
      persist: true,
      detached: false,
    };
    const started = await scope.client.request({ op: 'start', spec, owner: `${ownerFor(spaceId, 'service')}:${serviceName}` });
    if (started.op !== 'start') throw new Error(`OMP Hub returned an invalid start response for service ${serviceName}`);
    return this.view(spaceId, started.daemon, spec);
  }

  async read(spaceId: string, name: string, cursor: number | null): Promise<WorkspaceTerminalOutput> {
    const { client } = await this.terminal(spaceId, name);
    const result = await client.request({
      op: 'logs',
      name,
      lines: 1_000,
      head: false,
      follow: false,
      ...(cursor === null ? {} : { cursor }),
      renderTerminalRows: false,
      timeoutMs: 30_000,
    });
    if (result.op !== 'logs') throw new Error(`OMP Hub returned an invalid logs response for ${name}`);
    return {
      spaceId,
      name,
      state: result.state,
      cursor: result.cursor,
      data: result.terminalText ?? result.text,
    };
  }

  async send(spaceId: string, name: string, data: string): Promise<WorkspaceTerminalView> {
    const { client, spec } = await this.terminal(spaceId, name);
    const result = await client.request({ op: 'send', name, data });
    if (result.op !== 'send') throw new Error(`OMP Hub returned an invalid send response for ${name}`);
    return this.view(spaceId, result.daemon, spec);
  }


  async stop(spaceId: string, name: string): Promise<WorkspaceTerminalView> {
    const { client, spec } = await this.terminal(spaceId, name);
    const result = await client.request({ op: 'stop', name, timeoutMs: 5_000 });
    if (result.op !== 'stop') throw new Error(`OMP Hub returned an invalid stop response for ${name}`);
    return this.view(spaceId, result.daemon, spec);
  }

  private async terminal(spaceId: string, name: string): Promise<{ client: DaemonBrokerClient; spec: DaemonSpec }> {
    const scope = await this.scope(spaceId);
    try {
      const result = await scope.client.request({ op: 'describe', name });
      if (result.op !== 'describe' || !isInside(scope.space.rootPath, result.spec.cwd)) {
        throw new WorkspaceHubTerminalUnavailable(spaceId, name);
      }
      return { client: scope.client, spec: result.spec };
    } catch (error) {
      if (error instanceof WorkspaceHubTerminalUnavailable) throw error;
      throw new WorkspaceHubTerminalUnavailable(spaceId, name);
    }
  }

  private async scope(spaceId: string): Promise<HubScope> {
    const space = this.database.getSpace(spaceId);
    if (!space || space.placementState === 'closed' || space.holderId !== this.machineId) {
      throw new WorkspaceHubSpaceUnavailable(spaceId);
    }
    return { space, client: await this.clientForProject(space.rootPath) };
  }

  private view(spaceId: string, daemon: DaemonSnapshot, spec: DaemonSpec): WorkspaceTerminalView {
    return {
      spaceId,
      name: daemon.name,
      id: daemon.id,
      kind: terminalKind(spaceId, daemon.owner),
      state: daemon.state,
      machineId: this.machineId,
      owner: daemon.owner ?? null,
      command: displayCommand(spec),
      cwd: spec.cwd,
      createdAt: new Date(daemon.createdAt),
      exitCode: daemon.exitCode ?? null,
    };
  }
}
