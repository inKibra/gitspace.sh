import { normalizeProcessInstanceCount } from '../../../lib/processes/instances.js';
import { getProcessPortsForInstance } from '../../../lib/processes/runtime-ports.js';
import type { WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import { showServiceLauncherSelect } from '../workspace-detail/showServiceLauncherSelect.js';

interface ShowWorkspaceServiceSelectConfig {
  workspace: WorkspaceInfo;
  showSelect: (config: {
    title: string;
    searchable?: boolean;
    options: Array<{ label: string; description?: string; value: string }>;
    onSelect: (value: string) => void | Promise<void>;
  }) => void;
  showMessage: (config: { title: string; message: string; variant?: 'info' | 'success' | 'warning' | 'error' }) => void;
  onOpenUrl: (url: string) => void | Promise<void>;
}

interface ServiceRef {
  processName: string;
  instance: number;
}

export function showWorkspaceServiceSelect(args: ShowWorkspaceServiceSelectConfig): void {
  const services: Array<{ label: string; description?: string; value: string; ref: ServiceRef }> = [];

  for (const process of args.workspace.processes ?? []) {
    const count = normalizeProcessInstanceCount(process.instances);
    if (count === 0) {
      continue;
    }
    for (let instance = 1; instance <= count; instance += 1) {
      const browserPorts = getProcessPortsForInstance(process.ports, instance)
        .filter((port) => port.protocol !== 'tcp');
      if (browserPorts.length === 0) {
        continue;
      }
      const portNames = browserPorts.map((port) => port.name);
      services.push({
        label: `${process.name}#${instance}`,
        description: portNames.join(', '),
        value: `${process.name}:${instance}`,
        ref: { processName: process.name, instance },
      });
    }
  }

  if (services.length === 0) {
    args.showMessage({
      title: 'Open Service',
      message: `${args.workspace.name} has no browser-openable HTTP services.`,
      variant: 'info',
    });
    return;
  }

  const openLauncher = (ref: ServiceRef) => {
    const shown = showServiceLauncherSelect({
      workspace: args.workspace,
      processName: ref.processName,
      instance: ref.instance,
      showSelect: args.showSelect,
      onSelectUrl: args.onOpenUrl,
    });
    if (!shown) {
      args.showMessage({
        title: 'Open Service',
        message: `${ref.processName}#${ref.instance} has no browser-openable HTTP ports.`,
        variant: 'info',
      });
    }
  };

  if (services.length === 1) {
    openLauncher(services[0]!.ref);
    return;
  }

  const serviceByValue = new Map(services.map((service) => [service.value, service.ref]));
  args.showSelect({
    title: `${args.workspace.name} Services`,
    searchable: true,
    options: services.map(({ label, description, value }) => ({ label, description, value })),
    onSelect: (value) => {
      const selected = serviceByValue.get(value);
      if (selected) {
        openLauncher(selected);
      }
    },
  });
}
