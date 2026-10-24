import type { RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';

export type ShareEnd = NonNullable<RuntimeBrowserSharePreview['ended']>;

/** Why a share ended, as the person watching it reads it. */
export const SHARE_END_TEXT: Record<ShareEnd, (sharer: string) => string> = {
  revoked: sharer => `${sharer || 'The person sharing'} stopped sharing.`,
  expired: () => 'Its time ran out.',
  closed: () => 'The shared tab was closed.',
};

/** Pointer colors: one per viewer, the same on every screen. */
const POINTER_COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#dc2626'];

export function pointerColor(viewerId: string): string {
  // FNV-1a: ids differing in a few characters still land on different colors.
  let hash = 0x811c9dc5;
  for (const char of viewerId) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return POINTER_COLORS[hash % POINTER_COLORS.length]!;
}

/** "3:45 PM, in 52 minutes": when a share ends, from `now`. */
export function shareEndsText(expiresAt: string, now: number): string {
  const end = new Date(expiresAt);
  const minutes = Math.max(0, Math.round((end.getTime() - now) / 60_000));
  const sameDay = end.toDateString() === new Date(now).toDateString();
  const at = end.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const left = minutes < 1 ? 'in less than a minute'
    : minutes < 90 ? `in ${minutes} minute${minutes === 1 ? '' : 's'}`
      : `in about ${Math.round(minutes / 60)} hours`;
  return `${at}, ${left}`;
}
