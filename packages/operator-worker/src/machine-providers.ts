import type { FleetMachineDefinition } from './fleet-catalog.js';
import { controlCloudflareSandboxMachine, type SandboxProvisionerService } from './sandbox-provisioner.js';

export interface MachineProvider {
  readonly id: FleetMachineDefinition['provider'];
  status(machine: FleetMachineDefinition): Promise<FleetMachineDefinition>;
  sleep(machine: FleetMachineDefinition): Promise<FleetMachineDefinition>;
  resume(machine: FleetMachineDefinition): Promise<FleetMachineDefinition>;
  destroy(machine: FleetMachineDefinition): Promise<void>;
}

export class PhysicalMachineProvider implements MachineProvider {
  readonly id = 'physical' as const;
  async status(machine: FleetMachineDefinition): Promise<FleetMachineDefinition> { return machine; }
  async sleep(_machine: FleetMachineDefinition): Promise<FleetMachineDefinition> { throw new Error('Physical machine power lifecycle is not remotely managed'); }
  async resume(_machine: FleetMachineDefinition): Promise<FleetMachineDefinition> { throw new Error('Physical machine power lifecycle is not remotely managed'); }
  async destroy(_machine: FleetMachineDefinition): Promise<void> { throw new Error('Physical machines must be unenrolled by their owner'); }
}

export class CloudflareSandboxMachineProvider implements MachineProvider {
  readonly id = 'cloudflare-sandbox' as const;
  constructor(private readonly env: Env, private readonly userId: string, private readonly service?: SandboxProvisionerService) {}
  async status(machine: FleetMachineDefinition): Promise<FleetMachineDefinition> {
    const observed = await controlCloudflareSandboxMachine({ env: this.env, userId: this.userId, machineId: machine.id, action: 'status', service: this.service });
    if (!observed) throw new Error('Cloudflare Sandbox status returned no machine');
    return observed;
  }
  async sleep(machine: FleetMachineDefinition): Promise<FleetMachineDefinition> {
    const updated = await controlCloudflareSandboxMachine({ env: this.env, userId: this.userId, machineId: machine.id, action: 'sleep', service: this.service });
    if (!updated) throw new Error('Cloudflare Sandbox sleep returned no machine');
    return updated;
  }
  async resume(machine: FleetMachineDefinition): Promise<FleetMachineDefinition> {
    const updated = await controlCloudflareSandboxMachine({ env: this.env, userId: this.userId, machineId: machine.id, action: 'resume', service: this.service });
    if (!updated) throw new Error('Cloudflare Sandbox resume returned no machine');
    return updated;
  }
  async destroy(machine: FleetMachineDefinition): Promise<void> {
    await controlCloudflareSandboxMachine({ env: this.env, userId: this.userId, machineId: machine.id, action: 'destroy', service: this.service });
  }
}

export function machineProviderFor(env: Env, userId: string, machine: FleetMachineDefinition): MachineProvider {
  return machine.provider === 'cloudflare-sandbox' ? new CloudflareSandboxMachineProvider(env, userId) : new PhysicalMachineProvider();
}
