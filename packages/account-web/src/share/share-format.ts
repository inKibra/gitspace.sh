import type { RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';

export type ShareEnd = NonNullable<RuntimeBrowserSharePreview['ended']>;

/** Why a share ended, as the person watching it reads it. */
export const SHARE_END_TEXT: Record<ShareEnd, (sharer: string) => string> = {
  revoked: sharer => `${sharer || 'The person sharing'} stopped sharing.`,
  expired: () => 'Its time ran out.',
  closed: () => 'The shared tab was closed.',
};

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
