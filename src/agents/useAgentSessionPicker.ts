import { useCallback } from 'react';
import type { UseFlowReturn } from '../components/Flow.js';
import type { AgentSessionInfo } from './useWorkspaceAgentSessions.js';

function statusBadge(session: AgentSessionInfo): string {
  if (!session.status) return '';
  switch (session.status.type) {
    case 'busy': return ' ● Running';
    case 'retry': return ` ↺ Retrying (attempt ${session.status.attempt})`;
    case 'idle': return ' ○ Idle';
    default: return '';
  }
}

export interface OpenPickerOptions {
  /** If set, immediately open this session (skip the picker UI) */
  preselectSessionId?: string;
}

export interface UseAgentSessionPickerOptions {
  flow: UseFlowReturn;
  loadWorkspaceSessions: (workspaceId: string) => Promise<AgentSessionInfo[]>;
  createSession: (workspaceId: string, title?: string) => Promise<AgentSessionInfo[]>;
  abortSession: (workspaceId: string, sessionId: string) => Promise<AgentSessionInfo[]>;
  onOpenSession?: (session: AgentSessionInfo) => Promise<void> | void;
  /** Persisted last-selected session ID for the workspace */
  persistedSessionId?: string | null;
  /** Called when a session is selected to persist the choice */
  onPersistSession?: (sessionId: string) => void;
}

type PickerValue =
  | { type: 'new' }
  | { type: 'session'; session: AgentSessionInfo }
  | { type: 'abort'; session: AgentSessionInfo };

export function useAgentSessionPicker(options: UseAgentSessionPickerOptions) {
  const {
    flow,
    loadWorkspaceSessions,
    createSession,
    abortSession,
    onOpenSession,
    persistedSessionId,
    onPersistSession,
  } = options;

  const openPicker = useCallback(async (
    workspaceId: string,
    workspaceLabel: string,
    pickerOptions?: OpenPickerOptions,
  ) => {
    const openSelector = async (sessions?: AgentSessionInfo[]) => {
      const resolvedSessions = sessions ?? await loadWorkspaceSessions(workspaceId);

      // Check if the persisted session still exists in the current list
      const resumeSession = persistedSessionId
        ? resolvedSessions.find((s) => s.id === persistedSessionId)
        : null;

      // If preselectSessionId is given, immediately open that session
      if (pickerOptions?.preselectSessionId) {
        const preselected = resolvedSessions.find((s) => s.id === pickerOptions.preselectSessionId);
        if (preselected) {
          onPersistSession?.(preselected.id);
          if (onOpenSession) {
            await onOpenSession(preselected);
            return;
          }
        }
      }

      const options2: Array<{ label: string; value: PickerValue; description?: string }> = [];

      // Resume option at top if available
      if (resumeSession) {
        options2.push({
          label: `↩ Resume: ${resumeSession.title}`,
          value: { type: 'session', session: resumeSession },
          description: `Last used${statusBadge(resumeSession)}`,
        });
      }

      options2.push({
        label: '+ New agent session',
        value: { type: 'new' },
        description: 'Create a new OpenCode session in this workspace.',
      });

      for (const session of resolvedSessions) {
        const badge = statusBadge(session);
        options2.push({
          label: session.title,
          value: { type: 'session', session },
          description: session.updatedAt
            ? `Updated ${new Date(session.updatedAt).toLocaleString()}${badge}`
            : `${session.id}${badge}`,
        });
        // Add Abort option for busy/retrying sessions
        if (session.status?.type === 'busy' || session.status?.type === 'retry') {
          options2.push({
            label: `  ✗ Abort: ${session.title}`,
            value: { type: 'abort', session },
            description: 'Stop this running session',
          });
        }
      }

      flow.showSelect<PickerValue>({
        title: `Agent Sessions: ${workspaceLabel}`,
        searchable: true,
        options: options2,
        onSelect: async (selection) => {
          if (selection.type === 'new') {
            flow.showInput({
              title: `New Agent Session: ${workspaceLabel}`,
              label: 'Session title',
              placeholder: 'Investigate auth regression',
              defaultValue: '',
              onSubmit: async (value) => {
                const updated = await createSession(workspaceId, value.trim() || undefined);
                await openSelector(updated);
              },
            });
            return;
          }

          if (selection.type === 'abort') {
            flow.showConfirm({
              title: 'Abort Session',
              message: `Stop running session "${selection.session.title}"?`,
              confirmLabel: 'Abort',
              cancelLabel: 'Cancel',
              variant: 'warning',
              onConfirm: async () => {
                const updated = await abortSession(workspaceId, selection.session.id);
                await openSelector(updated);
              },
            });
            return;
          }

          // type === 'session'
          onPersistSession?.(selection.session.id);
          if (onOpenSession) {
            await onOpenSession(selection.session);
          }
        },
      });
    };

    try {
      flow.showLoading({
        title: 'Loading Agent Sessions',
        message: `Fetching OpenCode sessions for ${workspaceLabel}...`,
      });
      const sessions = await loadWorkspaceSessions(workspaceId);
      await openSelector(sessions);
    } catch (error) {
      flow.showMessage({
        title: 'Agent Sessions Unavailable',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    }
  }, [createSession, abortSession, flow, loadWorkspaceSessions, onOpenSession, persistedSessionId, onPersistSession]);

  return {
    openPicker,
  };
}
