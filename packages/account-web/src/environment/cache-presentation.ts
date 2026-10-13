import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';

type Attachment = RuntimeSnapshot['attachments'][number];
export interface CachePresentation {
  label: 'Offline' | 'Reclaimed' | 'Draining' | 'Paused' | 'Starting' | 'Ready';
  color: 'orange' | 'red' | 'dim' | 'green';
  priority: number;
  ready: boolean;
}
/** Ready means online with sync running. Setup results and sync errors are shown separately and never change it. */
export function cachePresentation(attachment: Attachment, now = Date.now()): CachePresentation {
  const offline = attachment.state === 'lost' || !attachment.heartbeatAt || now - Date.parse(attachment.heartbeatAt) > 30_000;
  if (offline) return { label: 'Offline', color: 'orange', priority: 4, ready: false } as const;
  if (attachment.cache?.state === 'reclaimed') return { label: 'Reclaimed', color: 'dim', priority: 2, ready: false } as const;
  if (attachment.state === 'draining' || attachment.cache?.state === 'draining') return { label: 'Draining', color: 'orange', priority: 3, ready: false } as const;
  if (attachment.cache?.state === 'paused') return { label: 'Paused', color: 'dim', priority: 2, ready: false } as const;
  if (attachment.state !== 'ready') return { label: 'Starting', color: 'orange', priority: 3, ready: false } as const;
  return { label: 'Ready', color: 'green', priority: 1, ready: true } as const;
}

/** Live attachments can still run work. `lost` is terminal: it is kept only as released history, never counted or offered. */
export function partitionAttachments(attachments: readonly Attachment[]) {
  return { live: attachments.filter(attachment => attachment.state !== 'lost' && attachment.state !== 'detached'), lost: attachments.filter(attachment => attachment.state === 'lost') };
}

export interface AttachedMachine extends CachePresentation {
  id: Attachment['machineId'];
  attachment: Attachment;
  /** Setup step errors, a failed explicit cache action, and the last recorded machine-side failure. */
  errors: string[];
  /** Label-ready status: the presentation label followed by every error. */
  status: string;
}

/** One attached cache as every surface shows it: status label plus the setup errors that explain it. */
export function attachedMachine(attachment: Attachment, now = Date.now()): AttachedMachine {
  const presentation = cachePresentation(attachment, now);
  const errors = [
    ...(attachment.cache?.setup.flatMap(step => step.error ? [`${step.phase}: ${step.error}`] : []) ?? []),
    ...(attachment.cacheAction?.status === 'failed' && attachment.cacheAction.error ? [`${attachment.cacheAction.action}: ${attachment.cacheAction.error}`] : []),
    ...(attachment.failure ? [`${attachment.failure.operation}: ${attachment.failure.message}`] : []),
  ];
  return { id: attachment.machineId, attachment, ...presentation, errors, status: [presentation.label, ...errors].join(' · ') };
}

/** The workspace's attached machines: every live cache attachment, whatever its setup state.
 * This is the single definition behind machine counts, run-machine choices, and terminal machines. */
export function attachedMachines(attachments: readonly Attachment[], now = Date.now()) {
  return partitionAttachments(attachments).live.filter(attachment => attachment.role === 'cache').map(attachment => attachedMachine(attachment, now));
}

export function environmentCacheSummary(snapshot: RuntimeSnapshot, now = Date.now()) {
  const machines = attachedMachines(snapshot.attachments, now);
  const worst = machines.reduce<AttachedMachine | undefined>((current, next) => !current || next.priority > current.priority ? next : current, undefined);
  return { count: machines.length, ready: machines.filter(machine => machine.ready).length, label: worst?.label ?? 'No machine', color: worst?.color ?? 'dim' } as const;
}
