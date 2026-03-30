import type { ResolvedProcessPort } from '../../types/processes.js';

export function getProcessPortsForInstance(
  ports: ResolvedProcessPort[] | undefined,
  instance: number,
): ResolvedProcessPort[] {
  return (ports ?? []).filter((port) => port.instance === instance);
}

export function getPrimaryProcessPort(
  ports: ResolvedProcessPort[] | undefined,
  instance: number,
): ResolvedProcessPort | null {
  return getProcessPortsForInstance(ports, instance)[0] ?? null;
}
