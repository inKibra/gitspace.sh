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
  portLabel: string
): string {
  const workspaceSegment = normalizeHostLabel(workspaceId);
  const processSegment = normalizeHostLabel(processName);
  const portSegment = normalizeHostLabel(portLabel);

  const base = `${portSegment}.${processSegment}-${instance}`;
  const suffix = `.${serveDomain}`;
  let hostname = `${base}.${workspaceSegment}${suffix}`;

  if (hostname.length <= MAX_HOSTNAME_LENGTH) {
    return hostname;
  }

  const availableWorkspace = MAX_HOSTNAME_LENGTH - base.length - suffix.length - 1;
  const trimmedWorkspace = clampLabel(workspaceSegment, Math.max(1, availableWorkspace));
  hostname = `${base}.${trimmedWorkspace}${suffix}`;
  return hostname;
}
