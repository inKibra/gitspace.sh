import type { WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import { buildServiceLauncherOptions } from '../../../lib/services/endpoints.js';
import { readTmuxHostingState } from '../../../lib/tmux-lite/hosting/state.js';

interface ServiceLauncherSelectConfig {
  workspace: WorkspaceInfo;
  processName: string;
  instance: number;
  showSelect: (config: {
    title: string;
    options: Array<{ label: string; description?: string; value: string }>;
    onSelect: (value: string) => void | Promise<void>;
  }) => void;
  onSelectUrl: (url: string) => void | Promise<void>;
}

export function showServiceLauncherSelect(args: ServiceLauncherSelectConfig): boolean {
  const process = (args.workspace.processes ?? []).find((candidate) => candidate.name === args.processName);
  const hostingState = readTmuxHostingState();
  const options = buildServiceLauncherOptions({
    workspaceId: args.workspace.id,
    processName: args.processName,
    instance: args.instance,
    ports: process?.ports,
    hosting: {
      baseHost: args.workspace.serveDomain ?? hostingState?.baseHost,
      machineName: hostingState?.machineName,
      enabled: hostingState?.enabled === true,
    },
  });

  if (options.length === 0) {
    return false;
  }

  args.showSelect({
    title: `${args.workspace.name} ${args.processName}#${args.instance}`,
    options: options.map((option) => ({
      label: option.label,
      description: option.description,
      value: option.url,
    })),
    onSelect: args.onSelectUrl,
  });
  return true;
}
