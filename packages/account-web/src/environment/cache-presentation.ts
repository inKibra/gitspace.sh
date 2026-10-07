import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';

type Attachment = RuntimeSnapshot['attachments'][number];
export function cachePresentation(attachment: Attachment, now = Date.now()) {
  const offline = attachment.state === 'lost' || !attachment.heartbeatAt || now - Date.parse(attachment.heartbeatAt) > 30_000;
  if (offline) return { label: 'Offline', color: 'orange', priority: 4, ready: false } as const;
  if (attachment.cache?.setup.some(step => step.state === 'failed') || attachment.cacheAction?.status === 'failed') return { label: 'Setup failed', color: 'red', priority: 5, ready: false } as const;
  if (attachment.cache?.setup.some(step => step.state === 'waiting-for-approval')) return { label: 'Waiting approval', color: 'orange', priority: 4, ready: false } as const;
  if (attachment.cache?.state === 'reclaimed') return { label: 'Reclaimed', color: 'dim', priority: 2, ready: false } as const;
  if (attachment.state === 'draining' || attachment.cache?.state === 'draining') return { label: 'Draining', color: 'orange', priority: 3, ready: false } as const;
  if (attachment.cache?.state === 'paused') return { label: 'Paused', color: 'dim', priority: 2, ready: false } as const;
  if (attachment.state !== 'ready' || attachment.cache?.state === 'setup' || (attachment.role === 'cache' && !attachment.cache)) return { label: 'Setting up', color: 'orange', priority: 3, ready: false } as const;
  return { label: 'Live', color: 'green', priority: 1, ready: true } as const;
}

export function environmentCacheSummary(snapshot: RuntimeSnapshot, now = Date.now()) {
  const machines = snapshot.attachments.filter(attachment => attachment.state !== 'detached');
  const states = machines.map(attachment => cachePresentation(attachment, now));
  const worst = states.reduce<(typeof states)[number] | undefined>((current, next) => !current || next.priority > current.priority ? next : current, undefined);
  return { count: machines.length, ready: states.filter(state => state.ready).length, label: worst?.label ?? 'No machine', color: worst?.color ?? 'dim' } as const;
}
