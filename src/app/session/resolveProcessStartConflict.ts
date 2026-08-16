import { PortConflictError, type PortConflictInfo } from '../../lib/processes/port-conflicts.js';

export class ProcessStartCancelledError extends Error {
  constructor() {
    super('Process start cancelled');
    this.name = 'ProcessStartCancelledError';
  }
}

interface ShowConfirmLike {
  (config: {
    title: string;
    message: string;
    variant?: 'danger' | 'warning' | 'info';
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void | Promise<void>;
    onCancel?: () => void | Promise<void>;
  }): void;
}

export function isPortConflictError(error: unknown): error is PortConflictError {
  return error instanceof PortConflictError;
}

export async function promptToResolveProcessStartConflict(args: {
  error: PortConflictError;
  showConfirm: ShowConfirmLike;
  resolveConflict: (conflict: PortConflictInfo) => Promise<void>;
}): Promise<boolean> {
  const conflict = args.error.conflicts[0];
  if (!conflict) {
    return false;
  }

  const title = 'Port Already In Use';
  const message = conflict.managedSessionId
    ? `Port ${conflict.port} is already used by ${conflict.managedProcessName ?? 'another service'}#${conflict.managedInstance ?? 1} in ${conflict.managedWorkspaceId ?? 'another workspace'}. Stop it and continue?`
    : `Port ${conflict.port} is already used by ${conflict.command ?? 'another process'} (pid ${conflict.pid}${conflict.user ? `, ${conflict.user}` : ''}). Kill it and continue?`;
  const confirmLabel = conflict.managedSessionId ? 'Stop and Continue' : 'Kill and Continue';

  return new Promise((resolve) => {
    args.showConfirm({
      title,
      message,
      variant: 'warning',
      confirmLabel,
      cancelLabel: 'Cancel',
      onConfirm: async () => {
        await args.resolveConflict(conflict);
        resolve(true);
      },
      onCancel: () => {
        resolve(false);
      },
    });
  });
}
