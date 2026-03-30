import { readMachineIdentity, writeMachineIdentity } from '../core/identity.js';
import type { PublicIdentity } from '../relay-client/machine-relay-client.js';

export function persistMachineIdentityFromServe(args: {
  existingIdentity: ReturnType<typeof readMachineIdentity>;
  machineId: string;
  relayUrl: string;
  publicIdentity: PublicIdentity;
}): void {
  writeMachineIdentity({
    machineId: args.machineId,
    machineName: args.existingIdentity?.machineName ?? args.publicIdentity.label ?? args.machineId,
    relayUrl: args.relayUrl,
    registeredAt: args.existingIdentity?.registeredAt ?? new Date().toISOString(),
  });
}
