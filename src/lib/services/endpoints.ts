import type { WorkspaceProcessPort } from '../../components/SpacesBrowser.js';
import type { ProcessPortProtocol } from '../../types/processes.js';
import { readTmuxHostingState } from '../tmux-lite/hosting/state.js';
import { resolveHostedServiceUrl } from '../tmux-lite/hosting/routes.js';

export interface HostingRouteState {
  baseHost?: string;
  machineName?: string;
  enabled: boolean;
}

export interface ServiceEndpoint {
  protocol: ProcessPortProtocol;
  port: number;
  portLabel: string;
  localUrl: string;
  remoteUrl?: string;
  hostingEnabled: boolean;
}

export interface ServiceLauncherOption {
  label: string;
  description?: string;
  url: string;
  target: 'local' | 'remote';
}

export function getHostingRouteState(): HostingRouteState {
  const state = readTmuxHostingState();
  return {
    baseHost: state?.baseHost,
    machineName: state?.machineName,
    enabled: state?.enabled === true,
  };
}

export function normalizeServicePortProtocol(protocol?: ProcessPortProtocol): ProcessPortProtocol {
  return protocol === 'tcp' ? 'tcp' : 'http';
}

export function buildServiceEndpoints(args: {
  workspaceId: string;
  processName: string;
  instance: number;
  ports?: WorkspaceProcessPort[];
  hosting?: HostingRouteState;
}): ServiceEndpoint[] {
  const hosting = args.hosting ?? getHostingRouteState();
  return (args.ports ?? [])
    .filter((port) => Number.isInteger(port.port) && port.port > 0)
    .map((port) => {
      const protocol = normalizeServicePortProtocol(port.protocol);
      const portLabel = port.name?.trim() || String(port.port);
      const localUrl = `${protocol}://localhost:${port.port}`;
      const remoteUrl = resolveHostedServiceUrl({
        baseHost: hosting.baseHost,
        machineName: hosting.machineName,
        workspaceId: args.workspaceId,
        processName: args.processName,
        instance: args.instance,
        portLabel,
        protocol,
      });
      return {
        protocol,
        port: port.port,
        portLabel,
        localUrl,
        remoteUrl,
        hostingEnabled: hosting.enabled,
      };
    });
}

export function buildServiceLauncherOptions(args: {
  workspaceId: string;
  processName: string;
  instance: number;
  ports?: WorkspaceProcessPort[];
  hosting?: HostingRouteState;
}): ServiceLauncherOption[] {
  const endpoints = buildServiceEndpoints(args).filter((endpoint) => endpoint.protocol === 'http');
  const options: ServiceLauncherOption[] = [];

  for (const endpoint of endpoints) {
    if (endpoint.remoteUrl) {
      options.push({
        label: `Open remote ${endpoint.portLabel}`,
        description: endpoint.hostingEnabled ? endpoint.remoteUrl : `${endpoint.remoteUrl} (hosting disabled)`,
        url: endpoint.remoteUrl,
        target: 'remote',
      });
    }
    options.push({
      label: `Open local ${endpoint.portLabel}`,
      description: endpoint.localUrl,
      url: endpoint.localUrl,
      target: 'local',
    });
  }

  return options;
}
