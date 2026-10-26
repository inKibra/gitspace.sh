import type { RuntimeBrowserSharePreview, RuntimeBrowserShareTarget } from '@gitspace/protocol-runtime';

export type ShareEnd = NonNullable<RuntimeBrowserSharePreview['ended']>;

/** Why a share ended, as the person watching it reads it. */
export const SHARE_END_TEXT: Record<ShareEnd, (sharer: string) => string> = {
  revoked: sharer => `${sharer || 'The person sharing'} stopped sharing.`,
  expired: () => 'Its time ran out.',
  closed: () => 'The shared tab was closed.',
};

/** "52 min": how long a share has left, from `now`; days once it is two days or more (capture shares last up to 30). */
export function shareTimeLeft(expiresAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 90) return `${minutes} min`;
  if (minutes < 2 * 1440) return `about ${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

/** `link “Pricing”`: what a comment is on, by the element's accessible role and name. */
export function shareTargetLabel(target: Pick<RuntimeBrowserShareTarget, 'role' | 'name'>): string {
  const role = target.role || 'element';
  return target.name ? `${role} “${target.name}”` : role;
}
