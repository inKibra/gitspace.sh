/** "in 4h 12m", "17m ago", "due now": how far `value` is from `now`. */
export function formatRelativeTime(value: Date | null, now = Date.now()): string {
  if (value === null) return 'Never';
  const difference = value.getTime() - now;
  const absolute = Math.abs(difference);
  if (absolute < 60_000) return difference >= 0 ? 'due now' : 'just now';
  const suffix = difference >= 0 ? '' : ' ago';
  const prefix = difference >= 0 ? 'in ' : '';
  if (absolute < 3_600_000) return `${prefix}${Math.round(absolute / 60_000)}m${suffix}`;
  if (absolute < 86_400_000) {
    const totalMinutes = Math.round(absolute / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${prefix}${hours}h${minutes > 0 ? ` ${minutes}m` : ''}${suffix}`;
  }
  const days = Math.round(absolute / 86_400_000);
  return `${prefix}${days}d${suffix}`;
}
