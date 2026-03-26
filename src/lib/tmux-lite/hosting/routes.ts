import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGitspaceDir } from '../../../core/config.js';
import { readHostConfig } from '../../../commands/host.js';
import { buildProcessHostname } from '../../../utils/hostnames.js';
import { readTmuxHostingState } from './state.js';
import { parseTmuxHostingBaseHost } from './base-host.js';

export interface HostedServiceRouteRecord {
  hostname: string;
  service: string;
}

function getHostedRoutesPath(): string {
  return join(getGitspaceDir(), '.tmux-hosting', 'hosted-routes.json');
}

export function readHostedServiceRoutes(): HostedServiceRouteRecord[] {
  const routesPath = getHostedRoutesPath();
  if (!existsSync(routesPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(routesPath, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is HostedServiceRouteRecord => Boolean(
      entry
      && typeof entry === 'object'
      && typeof (entry as { hostname?: unknown }).hostname === 'string'
      && typeof (entry as { service?: unknown }).service === 'string',
    ));
  } catch {
    return [];
  }
}

function getHostedWorkspaceIdCandidates(workspaceId: string): string[] {
  const candidates = new Set<string>();
  const trimmed = workspaceId.trim();
  if (!trimmed) {
    return [];
  }
  candidates.add(trimmed);
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex >= 0 && separatorIndex < trimmed.length - 1) {
    candidates.add(trimmed.slice(separatorIndex + 1));
  }
  return [...candidates];
}

export function resolveHostedServiceUrl(args: {
  baseHost?: string;
  machineName?: string;
  workspaceId: string;
  processName: string;
  instance: number;
  portLabel: string;
  protocol: 'http' | 'tcp';
}): string | undefined {
  if (args.protocol !== 'http' || !args.baseHost) {
    return undefined;
  }

  const parsedBaseHost = parseTmuxHostingBaseHost(args.baseHost);
  const serveDomain = readHostConfig()?.serveNamespaces?.[parsedBaseHost.rootSubdomain]?.domain;
  if (!serveDomain) {
    return undefined;
  }

  const machineName = args.machineName ?? readTmuxHostingState()?.machineName;
  const activeRoutes = readHostedServiceRoutes();
  for (const candidateWorkspaceId of getHostedWorkspaceIdCandidates(args.workspaceId)) {
    const hostname = buildProcessHostname(
      serveDomain,
      parsedBaseHost.rootSubdomain,
      candidateWorkspaceId,
      args.processName,
      args.instance,
      args.portLabel,
      machineName,
    );
    const activeRoute = activeRoutes.find((route) => route.hostname === hostname);
    if (activeRoute) {
      return `http://${activeRoute.hostname}`;
    }
  }
  return undefined;
}
