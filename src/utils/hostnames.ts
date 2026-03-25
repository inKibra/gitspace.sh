import { createHash } from 'crypto';

const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;

function clampLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const trimmed = value.slice(0, maxLength).replace(/-+$/g, '');
  return trimmed.length > 0 ? trimmed : 'x';
}

export function normalizeHostLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) return 'x';
  return clampLabel(normalized, MAX_LABEL_LENGTH);
}

export function buildProcessHostname(
  serveDomain: string,
  workspaceId: string,
  processName: string,
  instance: number,
  portLabel: string,
  machineName?: string,
 ): string {
  const workspaceSegment = normalizeHostLabel(workspaceId);
  const processSegment = normalizeHostLabel(processName);
  const portSegment = normalizeHostLabel(portLabel);
  const machineSegment = machineName ? normalizeHostLabel(machineName) : undefined;

  const base = buildProcessHostLabel(machineSegment, workspaceSegment, processSegment, instance, portSegment);
  const suffix = `.${serveDomain}`;
  let hostname = `${base}${suffix}`;

  if (hostname.length <= MAX_HOSTNAME_LENGTH) {
    return hostname;
  }

  const availableBase = MAX_HOSTNAME_LENGTH - suffix.length;
  const trimmedBase = clampLabel(base, Math.max(1, availableBase));
  hostname = `${trimmedBase}${suffix}`;
  return hostname;
}

function buildProcessHostLabel(
  machineSegment: string | undefined,
  workspaceSegment: string,
  processSegment: string,
  instance: number,
  portSegment: string,
 ): string {
  const label = [
    machineSegment ? `m-${machineSegment}` : null,
    `w-${workspaceSegment}`,
    `p-${processSegment}`,
    `i-${instance}`,
    `o-${portSegment}`,
  ]
    .filter(Boolean)
    .join('-');
  if (label.length <= MAX_LABEL_LENGTH) {
    return label;
  }

  const hash = createHash('sha256')
    .update(JSON.stringify({ machineSegment, workspaceSegment, processSegment, instance, portSegment }))
    .digest('hex')
    .slice(0, 8);
  const suffix = `-i-${instance}-${hash}`;
  const prefix = clampLabel(
    [
      machineSegment ? `m-${machineSegment}` : null,
      `w-${workspaceSegment}`,
      `p-${processSegment}`,
      `o-${portSegment}`,
    ]
      .filter(Boolean)
      .join('-'),
    Math.max(1, MAX_LABEL_LENGTH - suffix.length)
  );
  return `${prefix}${suffix}`;
}
