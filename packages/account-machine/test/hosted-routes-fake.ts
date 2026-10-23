import { hostedServiceUrlKind, type HostedServicePointer, type HostedServiceRoute } from '@gitspace/protocol';
import type { HostedRouteAuthority } from '../src/workspace-services.js';

/**
 * The account's hosted route registry as the machines of one test see it: a machine URL is leased by its one machine,
 * a workspace URL by the machine its pointer names (claimed by the first declared service, moved only by a pin).
 */
export class HostedRoutesFake {
  readonly leases = new Map<string, Omit<HostedServiceRoute, 'updatedAt'>>();
  readonly pointers = new Map<string, HostedServicePointer>();
  constructor(private readonly machines: ReadonlyArray<{ id: string; label: string }>) {}

  authority(machineId: string): HostedRouteAuthority {
    const label = this.machines.find(machine => machine.id === machineId)?.label ?? machineId;
    const accepted = (route: Omit<HostedServiceRoute, 'updatedAt'>, pointer: HostedServicePointer | null) => {
      this.leases.set(route.hostname, route);
      return { route: { ...route, updatedAt: new Date().toISOString() }, pointer };
    };
    return {
      listMachineDefinitions: async () => this.machines,
      listHostedRoutes: async () => ({ routes: [...this.leases.values()].map(route => ({ ...route, updatedAt: new Date().toISOString() })), pointers: [...this.pointers.values()] }),
      leaseHostedRoute: async (_projectId, route) => {
        if (hostedServiceUrlKind(route.hostname) === 'machine') {
          const current = this.leases.get(route.hostname);
          if (current && current.machineId !== route.machineId) throw new Error('Hosted route lease owner or generation conflict');
          return accepted(route, null);
        }
        const pointer = this.pointers.get(route.hostname);
        if (pointer && !(pointer.machineId === route.machineId && pointer.source === route.source && pointer.serviceName === route.serviceName && pointer.portName === route.portName)) return { route: null, pointer };
        if (!pointer && route.source !== 'declared') return { route: null, pointer: null };
        const claimed: HostedServicePointer = pointer ?? { hostname: route.hostname, workspaceId: route.workspaceId, machineId, machineLabel: label, serviceName: route.serviceName, source: route.source, portName: route.portName, setAt: new Date().toISOString(), setBy: 'start' };
        this.pointers.set(route.hostname, claimed);
        return accepted(route, claimed);
      },
      pinHostedRoute: async (_projectId, route) => {
        const pointer: HostedServicePointer = { hostname: route.hostname, workspaceId: route.workspaceId, machineId, machineLabel: label, serviceName: route.serviceName, source: route.source, portName: route.portName, setAt: new Date().toISOString(), setBy: 'pin' };
        this.pointers.set(route.hostname, pointer);
        return accepted(route, pointer);
      },
      releaseHostedRoute: async (_projectId, hostname) => this.leases.get(hostname)?.machineId === machineId && this.leases.delete(hostname),
    };
  }
}
