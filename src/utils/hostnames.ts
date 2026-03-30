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

export function buildServeHostnamePattern(serveDomain: string, rootSubdomain: string): string {
  return `<service>--<workspace>--<machine>--<port>--<instance>--${buildServeNamespaceSegment(rootSubdomain)}.${serveDomain}`;
}

export function buildProcessHostname(
  serveDomain: string,
  rootSubdomain: string,
  workspaceId: string,
  processName: string,
  instance: number,
  portLabel: string,
  machineName?: string,
): string {
  const processSegment = normalizeHostLabel(processName);
  const workspaceSegment = normalizeHostLabel(workspaceId);
  const machineSegment = machineName ? normalizeHostLabel(machineName) : undefined;
  const portSegment = normalizeHostLabel(portLabel);
  const userSegment = normalizeHostLabel(rootSubdomain);

  const base = buildProcessHostLabel({
    processSegment,
    workspaceSegment,
    machineSegment,
    portSegment,
    instance,
    userSegment,
  });
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

function buildServeNamespaceSegment(rootSubdomain: string): string {
  return `${normalizeHostLabel(rootSubdomain)}-srv`;
}

function buildProcessHostLabel(args: {
  processSegment: string;
  workspaceSegment: string;
  machineSegment?: string;
  portSegment: string;
  instance: number;
  userSegment: string;
}): string {
  const full = [
    args.processSegment,
    args.workspaceSegment,
    args.machineSegment ?? null,
    args.portSegment,
    String(args.instance),
    buildServeNamespaceSegment(args.userSegment),
  ]
    .filter(Boolean)
    .join('--');
  if (full.length <= MAX_LABEL_LENGTH) {
    return full;
  }

  const hash = createHash('sha256')
    .update(JSON.stringify(args))
    .digest('hex')
    .slice(0, 8);

  const compactPrefix = [
    `p${clampLabel(args.processSegment, 8)}`,
    `w${clampLabel(args.workspaceSegment, 8)}`,
    args.machineSegment ? `m${clampLabel(args.machineSegment, 6)}` : null,
    `o${clampLabel(args.portSegment, 6)}`,
    `i${args.instance}`,
    `h${hash}`,
  ]
    .filter(Boolean)
    .join('-');

  const namespaceSuffix = `--${buildServeNamespaceSegment(args.userSegment)}`;
  const availablePrefixLength = Math.max(1, MAX_LABEL_LENGTH - namespaceSuffix.length);
  return `${clampLabel(compactPrefix, availablePrefixLength)}${namespaceSuffix}`;
}
