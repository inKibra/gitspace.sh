import type { InboxItem } from '../lib/tmux-lite/protocol.js';

export type AgentNotificationType = 'permission_needed' | 'agent_idle' | 'agent_error';

export interface AgentNotification {
  type: AgentNotificationType;
  workspaceId: string;
  sessionId: string;
  sessionTitle: string;
  /** For permission_needed */
  permissionId?: string;
  permissionTitle?: string;
  /** For agent_idle */
  messagePreview?: string;
  /** For agent_error */
  errorMessage?: string;
  timestamp: number;
}

let _idCounter = 0;
function nextId(): string {
  return `agent-${Date.now()}-${++_idCounter}`;
}

/**
 * Convert an AgentNotification to an InboxItem for the existing inbox pipeline.
 *
 * sessionName format: "<project>:<workspace>:agent:<sessionTitle>"
 * This slots naturally into the inbox hierarchical grouping.
 */
export function agentNotificationToInboxItem(
  notification: AgentNotification,
  projectName: string,
  workspaceName: string,
): InboxItem {
  const safeTitle = notification.sessionTitle.replace(/:/g, '-');
  const sessionName = `${projectName}:${workspaceName}:agent:${safeTitle}`;

  switch (notification.type) {
    case 'permission_needed':
      return {
        id: nextId(),
        sessionId: notification.sessionId,
        sessionName,
        type: 'agent_permission',
        context: notification.permissionTitle ?? 'Permission requested',
        timestamp: notification.timestamp,
        read: false,
        processTitle: 'agent',
        agentAction: {
          workspaceId: notification.workspaceId,
          agentSessionId: notification.sessionId,
          permissionId: notification.permissionId,
          permissionTitle: notification.permissionTitle,
        },
      };

    case 'agent_idle':
      return {
        id: nextId(),
        sessionId: notification.sessionId,
        sessionName,
        type: 'agent_idle',
        context: notification.messagePreview ?? 'Agent finished and is waiting',
        timestamp: notification.timestamp,
        read: false,
        processTitle: 'agent',
        agentAction: {
          workspaceId: notification.workspaceId,
          agentSessionId: notification.sessionId,
          messagePreview: notification.messagePreview,
        },
      };

    case 'agent_error':
      return {
        id: nextId(),
        sessionId: notification.sessionId,
        sessionName,
        type: 'agent_error',
        context: notification.errorMessage ?? 'Agent error',
        timestamp: notification.timestamp,
        read: false,
        processTitle: 'agent',
        agentAction: {
          workspaceId: notification.workspaceId,
          agentSessionId: notification.sessionId,
        },
      };
  }
}
