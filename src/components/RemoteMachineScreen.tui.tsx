import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PasteEvent } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import type { Identity } from '../types/identity.js';
import type { MachineInfo } from './index.js';
import { useSpacesBrowser } from './SpacesBrowser.js';
import { SpacesBrowserTUI } from './SpacesBrowser.tui.js';
import { useInbox } from './Inbox.js';
import { InboxTUI } from './Inbox.tui.js';
import {
  useFlow,
  isFlowInput,
  isFlowConfirmTyped,
  isFlowWizard,
  getDefaultShortcuts,
} from './Flow.js';
import { FlowTUI } from './Flow.tui.js';
import { useRemoteTerminal } from '../hooks/useRemoteTerminal.tui.js';
import { useBundleRefreshAttachFlow } from '../session/index.js';
import { useBundleConfigFlow } from '../session/index.js';
import { useAttachController } from '../app/session/useAttachController.js';
import { useProcessActions } from '../app/session/useProcessActions.js';
import {
  resolveInboxCommand,
  resolveSessionBrowserCommand,
} from '../app/input/sessionCommands.js';
import { SessionTerminal } from './SessionTerminal.tui.js';
import { ScriptTerminal } from './ScriptTerminal.tui.js';
import { ReplayTerminal } from './ReplayTerminal.tui.js';
import { getKeyboardInputChunk, normalizeInputText } from '../tui/input-text.js';
import {
  applySearchableSelectPaste,
  handleSearchableSelectKey,
} from '../tui/flow-select-input.js';
import { useWorkspaceDeleteFlow } from '../app/session/useWorkspaceDeleteFlow.js';
import { useLifecycleController } from '../app/session/useLifecycleController.js';
import { buildEditProcessesCommand } from '../lib/processes/editor.js';
import { createLocalDeviceCertificate } from '../core/user-identity.js';
import { writeCrashLog } from '../utils/crash-log.js';
import { logger } from '../utils/logger.js';
import type { ReplayInfo } from '../lib/tmux-lite/replay/index.js';
import { useWorkspaceAgentSessions } from '../agents/useWorkspaceAgentSessions.js';
import { useWorkspaceAgentEvents } from '../agents/useWorkspaceAgentEvents.js';
import { usePersistedAgentSession } from '../agents/usePersistedAgentSession.js';
import { agentNotificationToInboxItem } from '../agents/agentNotificationToInboxItem.js';

const COLORS = {
  statusBar: '#333333',
  textDim: '#888888',
  loading: '#FFAA00',
  error: '#FF4444',
  title: '#00FF88',
};

function StatusBar({ hint }: { hint: string }) {
  return (
    <box height={1} width="100%" backgroundColor={COLORS.statusBar} paddingLeft={1}>
      <text fg={COLORS.textDim}>{hint}</text>
    </box>
  );
}

export interface RemoteMachineScreenProps {
  machine: MachineInfo;
  relayUrl: string;
  identity: Identity;
  onBack: () => void;
}

function formatRemoteConnectError(machine: MachineInfo, relayUrl: string, error: unknown): string[] {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const machineName = machine.label || machine.machineId;

  let detail = rawMessage;
  if (rawMessage.startsWith('Socket closed before handshake completed')) {
    detail =
      'The relay connection closed before the remote handshake finished. This usually means the relay or machine rejected the request or dropped the connection early.';
  } else if (rawMessage === 'Unexpected pre-handshake relay payload') {
    detail =
      'The relay returned data before the encrypted handshake completed. That usually means the relay and machine are out of sync about the connection state.';
  }

  return [
    `Could not connect to remote machine ${machineName}.`,
    `Relay: ${relayUrl}`,
    `Machine ID: ${machine.machineId}`,
    `Reason: ${detail}`,
    'See terminal stderr for the full stack trace.',
  ];
}

export function RemoteMachineScreen({ machine, relayUrl, identity, onBack }: RemoteMachineScreenProps) {
  const remote = useRemoteTerminal();
  const renderer = useRenderer();
  const [connectErrorLines, setConnectErrorLines] = useState<string[]>([]);
  const [deviceCertificate, setDeviceCertificate] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [showScriptTerminal, setShowScriptTerminal] = useState(false);
  const [isViewOnlySession, setIsViewOnlySession] = useState(false);
  const [scriptWorkspaceName, setScriptWorkspaceName] = useState('workspace');
  const [pendingProcessEditWorkspaceId, setPendingProcessEditWorkspaceId] = useState<string | null>(null);
  const [activeReplay, setActiveReplay] = useState<ReplayInfo | null>(null);
  const pendingProcessEditWorkspacesRef = useRef<unknown[] | null>(null);
  const pendingProcessEditValidationArmedRef = useRef(false);
  const lastScriptWorkspaceIdRef = useRef<string | null>(null);
  const activeConnectKeyRef = useRef<string | null>(null);
  const activeReplayDismissedRef = useRef(false);
  const connectRemoteRef = useRef(remote.connect);
  const disconnectRemoteRef = useRef(remote.disconnect);
  const flow = useFlow({
    onError: (error) => {
      remote.disconnect();
      logger.error(`[tui] Remote machine flow error: ${error.message}`);
    },
  });

  useEffect(() => {
    connectRemoteRef.current = remote.connect;
    disconnectRemoteRef.current = remote.disconnect;
  }, [remote.connect, remote.disconnect]);

  useEffect(() => {
    let cancelled = false;
    setDeviceCertificate(null);

    void createLocalDeviceCertificate(identity)
      .then((cert) => {
        if (!cancelled) {
          setDeviceCertificate(cert);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        flow.showMessage({
          title: 'Identity Error',
          message,
          variant: 'error',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [flow.showMessage, identity]);

  const resolveRemoteWorkspaceProjectName = useCallback((workspaceId: string) => {
    const separator = workspaceId.indexOf(':');
    if (separator > 0) {
      return workspaceId.slice(0, separator);
    }
    return remote.selectedProjectName;
  }, [remote.selectedProjectName]);

  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    flow,
    commandError: remote.commandError ?? null,
    attachSession: (params) => remote.attachSession(params),
    getBundleRefreshPlan: remote.getBundleRefreshPlan,
    applyBundleRefresh: remote.applyBundleRefresh,
    resolveProjectName: resolveRemoteWorkspaceProjectName,
  });

  const bundleConfigFlow = useBundleConfigFlow({
    flow,
    getBundleConfigState: remote.getBundleConfigState,
    applyBundleConfigUpdate: remote.applyBundleConfigUpdate,
    resolveProjectName: resolveRemoteWorkspaceProjectName,
    onApplied: async () => {
      remote.requestWorkspaces();
      remote.requestSessions();
      remote.requestReplays();
    },
  });

  const attachController = useAttachController({
    flow,
    attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
    defaultProjectName: remote.selectedProjectName,
    resolveProjectName: resolveRemoteWorkspaceProjectName,
    onBeforeAttach: ({ target, params }) => {
      if (target === 'workspace' && params.workspaceId && !params.command) {
        lastScriptWorkspaceIdRef.current = params.workspaceId;
        setShowInbox(false);
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        setShowScriptTerminal(true);
      }
    },
    onAttachCancelled: ({ target }) => {
      if (target === 'workspace' && showScriptTerminal) {
        return;
      }
      if (target === 'workspace') {
        setShowScriptTerminal(false);
      }
    },
    onAttachError: ({ target, message }) => {
      const isWorkspaceScriptFailure = message.startsWith('Workspace scripts failed during');
      const hasScriptRuntimeState = Boolean(remote.scriptState);

      if (target === 'workspace' && (!isWorkspaceScriptFailure || !hasScriptRuntimeState)) {
        setShowScriptTerminal(false);
      }

      flow.showMessage({
        title: isWorkspaceScriptFailure ? 'Workspace Script Failed' : 'Session Failed',
        message,
        variant: 'error',
      });
    },
  });

  const { deleteWorkspaceWithPrompt } = useWorkspaceDeleteFlow({
    flow,
    deleteWorkspace: remote.deleteWorkspace,
    onBeforeDelete: ({ target }) => {
      setShowInbox(false);
      setScriptWorkspaceName(target.workspaceName);
      setShowScriptTerminal(true);
    },
    onDeleteSuccess: async () => {
      setShowScriptTerminal(false);
      remote.requestWorkspaces();
      remote.requestSessions();
      remote.requestReplays();
    },
    onDeleteError: async ({ message }) => {
      setShowScriptTerminal(false);
      flow.showMessage({
        title: 'Delete Failed',
        message,
        variant: 'error',
      });
    },
  });

  const lifecycleController = useLifecycleController({
    flow,
    listGithubRepos: remote.listGithubRepos,
    listRemoteBranches: remote.listRemoteBranches,
    listLinearIssues: remote.listLinearIssues,
    createProject: remote.createProject,
    createWorkspace: remote.createWorkspace,
    deleteProject: remote.deleteProject,
    getProjectNames: () => remote.projects.map((project) => project.name),
    refreshProjects: () => remote.requestProjects(),
    refreshWorkspaces: () => remote.requestWorkspaces(),
    refreshSessions: () => remote.requestSessions(),
  });

  useEffect(() => {
    return () => {
      activeConnectKeyRef.current = null;
      disconnectRemoteRef.current();
    };
  }, [identity.id, machine.machineId, relayUrl]);

  useEffect(() => {
    if (!deviceCertificate) {
      return;
    }

    const connectKey = [relayUrl, machine.machineId, identity.id, deviceCertificate].join('|');
    if (activeConnectKeyRef.current === connectKey) {
      return;
    }

    activeConnectKeyRef.current = connectKey;
    let cancelled = false;
    setConnectErrorLines([]);

    void connectRemoteRef.current({
      relayUrl,
      identity,
      machineId: machine.machineId,
      machineLabel: machine.label,
      deviceCertificate,
    }).catch((error) => {
      if (cancelled) {
        return;
      }

      const messageLines = formatRemoteConnectError(machine, relayUrl, error);
      const logPath = writeCrashLog('remote-machine-connect', error, {
        relayUrl,
        machineId: machine.machineId,
        machineLabel: machine.label ?? null,
      });
      setConnectErrorLines(logPath ? [...messageLines, `Crash log: ${logPath}`] : messageLines);
      if (error instanceof Error && error.stack) {
        logger.error(`[tui] Remote machine connect error:\n${error.stack}`);
      } else {
        logger.error(`[tui] Remote machine connect error: ${String(error)}`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    deviceCertificate,
    identity,
    machine.label,
    machine.machineId,
    relayUrl,
  ]);

  useEffect(() => {
    if (remote.status !== 'established' || remote.mode !== 'browsing') {
      return;
    }
    remote.requestProjects();
    remote.requestWorkspaces();
    remote.requestSessions();
    remote.requestReplays();
    remote.requestNotificationConfig();
  }, [remote.mode, remote.status]);

  useEffect(() => {
    if (remote.mode === 'attached') {
      setShowScriptTerminal(false);
    }
  }, [remote.mode]);

  useEffect(() => {
    if (remote.mode !== 'attached') {
      setIsViewOnlySession(false);
    }
  }, [remote.mode]);

  useEffect(() => {
    if (remote.status !== 'established' || remote.mode !== 'browsing') {
      setActiveReplay(null);
    }
  }, [remote.mode, remote.status]);

  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => {
    setIsViewOnlySession(params.viewOnly ?? false);
    await attachController.attachFromSelection(params);
  }, [attachController]);

  useEffect(() => {
    if (
      !pendingProcessEditWorkspaceId ||
      !pendingProcessEditValidationArmedRef.current ||
      remote.mode !== 'browsing'
    ) {
      return;
    }
    remote.requestWorkspaces();
  }, [pendingProcessEditWorkspaceId, remote.mode, remote.requestWorkspaces]);

  useEffect(() => {
    if (
      !pendingProcessEditWorkspaceId ||
      !pendingProcessEditValidationArmedRef.current ||
      remote.mode !== 'browsing'
    ) {
      return;
    }

    if (
      pendingProcessEditWorkspacesRef.current &&
      pendingProcessEditWorkspacesRef.current === remote.workspaces
    ) {
      return;
    }
    pendingProcessEditWorkspacesRef.current = null;

    const workspace = remote.workspaces.find((item) => item.id === pendingProcessEditWorkspaceId);
    if (!workspace) {
      pendingProcessEditValidationArmedRef.current = false;
      setPendingProcessEditWorkspaceId(null);
      return;
    }

    if (workspace.processConfigError) {
      flow.showMessage({
        title: 'Invalid Processes Config',
        message: workspace.processConfigError,
        variant: 'error',
      });
    } else {
      const processCount = workspace.processes?.length ?? 0;
      flow.showMessage({
        title: 'Processes Config Updated',
        message: processCount === 0
          ? 'Config is valid. No processes are defined yet.'
          : `Config is valid. ${processCount} process${processCount === 1 ? '' : 'es'} defined.`,
        variant: 'success',
      });
    }

    pendingProcessEditValidationArmedRef.current = false;
    setPendingProcessEditWorkspaceId(null);
  }, [flow, pendingProcessEditWorkspaceId, remote.mode, remote.workspaces]);

  const processActions = useProcessActions({
    sessions: remote.sessions,
    startProcess: remote.startProcess,
    stopProcess: remote.stopProcess,
    attachSession: handleAttachSession,
    onStartProcessError: (error) => {
      flow.showMessage({
        title: 'Process Start Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onStopProcessError: (error) => {
      flow.showMessage({
        title: 'Process Stop Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onStartProcessAttachError: (error) => {
      flow.showMessage({
        title: 'Process Start Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onAttachError: (error) => {
      flow.showMessage({
        title: 'Attach Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    },
    onAttachTimeout: (target) => {
      flow.showMessage({
        title: 'Attach Timeout',
        message: `Process started but no active session was found for ${target.processName}#${target.instance}.`,
        variant: 'warning',
      });
    },
    onStartProcessFinally: () => {
      remote.requestWorkspaces();
      remote.requestSessions();
    },
    onStopProcessFinally: () => {
      remote.requestWorkspaces();
      remote.requestSessions();
    },
    onStartProcessAttachFinally: () => {
      remote.requestWorkspaces();
      remote.requestSessions();
    },
    pendingAttachCancelSignal: remote.commandError,
  });

  const handleStartProcess = processActions.handleStartProcess;
  const handleStartProcessAttach = processActions.handleStartProcessAttach;
  const handleStopProcess = processActions.handleStopProcess;

  const handleProcessDisabled = useCallback((params: { workspaceId: string; processName: string }) => {
    const workspace = remote.workspaces.find((item) => item.id === params.workspaceId);
    const workspaceLabel = workspace?.name ?? params.workspaceId;
    flow.showMessage({
      title: 'Process Disabled',
      message: `Process "${params.processName}" is disabled in ${workspaceLabel} (instances: 0).`,
      variant: 'error',
    });
  }, [flow, remote.workspaces]);

  const handleOpenEvents = useCallback(() => {
    flow.showMessage({
      title: 'Events Unavailable',
      message: 'Events view is not available in this remote TUI screen yet.',
      variant: 'info',
    });
  }, [flow]);

  const handleOpenReplay = useCallback(async (replayId: string) => {
    const replay = remote.replays.find((item) => item.replayId === replayId);
    if (!replay) {
      flow.showMessage({
        title: 'Replay Missing',
        message: 'That replay is no longer available.',
        variant: 'error',
      });
      return;
    }

    setShowInbox(false);
    setShowScriptTerminal(false);
    setActiveReplay(replay);
  }, [flow, remote.replays]);

  const handleReplayDismiss = useCallback(async (replayId: string) => {
    try {
      const replay = remote.replays.find((item) => item.replayId === replayId) ?? activeReplay;
      if (!activeReplayDismissedRef.current && replay?.status === 'running') {
        flow.showMessage({
          title: 'Replay Still Running',
          message: 'Running replays cannot be dismissed.',
          variant: 'info',
        });
        return false;
      }

      if (activeReplayDismissedRef.current) {
        await remote.undismissReplay(replayId);
        activeReplayDismissedRef.current = false;
        setActiveReplay((current) => current && current.replayId === replayId
          ? {
            ...current,
            dismissedAt: undefined,
            dismissedBy: undefined,
          }
          : current);
        return false;
      }

      await remote.dismissReplay(replayId);
      activeReplayDismissedRef.current = true;
      return true;
    } catch (error) {
      flow.showMessage({
        title: 'Replay Update Failed',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
      return false;
    } finally {
      remote.requestReplays();
    }
  }, [activeReplay, flow, remote]);

  useEffect(() => {
    activeReplayDismissedRef.current = Boolean(activeReplay?.dismissedAt);
  }, [activeReplay?.dismissedAt]);

  const loadReplayFrame = useCallback((replayId: string, target?: { atMs?: number; atSeq?: number }) => {
    return remote.getReplayFrame(replayId, target);
  }, [remote]);

  const loadReplayTimeline = useCallback((replayId: string) => {
    return remote.getReplayTimeline(replayId);
  }, [remote]);

  const handleEditProcesses = useCallback(({ workspaceId }: { workspaceId: string }) => {
    pendingProcessEditValidationArmedRef.current = false;
    pendingProcessEditWorkspacesRef.current = remote.workspaces;
    setPendingProcessEditWorkspaceId(workspaceId);
    const commandSpec = buildEditProcessesCommand();
    void attachController.attach({
      workspaceId,
      command: commandSpec.command,
      args: commandSpec.args,
    }).then((attached) => {
      if (!attached) {
        pendingProcessEditValidationArmedRef.current = false;
        pendingProcessEditWorkspacesRef.current = null;
        setPendingProcessEditWorkspaceId(null);
        return;
      }

      pendingProcessEditValidationArmedRef.current = true;
    });
  }, [attachController, remote.workspaces]);

  const handleManageBundleConfig = useCallback(async ({ workspaceId }: { workspaceId: string }) => {
    const workspace = remote.workspaces.find((item) => item.id === workspaceId);
    const projectName = workspace?.projectName ?? remote.selectedProjectName;
    await bundleConfigFlow.openBundleConfig({ workspaceId, projectName });
  }, [bundleConfigFlow, remote.selectedProjectName, remote.workspaces]);

  const remoteBackend = remote.sessionBackend;

  const workspaceAgentSessions = useWorkspaceAgentSessions({
    backend: remoteBackend,
  });

  // Agent event subscription — machine-side push state
  const [agentInboxItems, setAgentInboxItems] = useState<import('../lib/tmux-lite/protocol.js').InboxItem[]>([]);

  const agentEvents = useWorkspaceAgentEvents({
    backend: remoteBackend,
    onNotification: (notification) => {
      const workspace = remote.workspaces.find((w) => w.id === notification.workspaceId);
      const projectName = workspace?.projectName ?? 'unknown';
      const workspaceName = workspace?.name ?? notification.workspaceId;
      const item = agentNotificationToInboxItem(notification, projectName, workspaceName);
      setAgentInboxItems((prev) => [item, ...prev.slice(0, 49)]);
    },
  });

  const [agentPickerWorkspaceId, setAgentPickerWorkspaceId] = useState('');
  const agentSessionPref = usePersistedAgentSession(agentPickerWorkspaceId, remoteBackend);

  // Memoize agent session counts to preserve referential stability for useSpacesBrowser
  const agentSessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [wid, sessions] of Object.entries(workspaceAgentSessions.sessionsByWorkspace)) {
      counts[wid] = sessions.length;
    }
    for (const [wid, sessions] of Object.entries(agentEvents.workspaceStates)) {
      const eventCount = Object.keys(sessions).length;
      counts[wid] = Math.max(counts[wid] ?? 0, eventCount);
    }
    return counts;
  }, [workspaceAgentSessions.sessionsByWorkspace, agentEvents.workspaceStates]);

  const agentSessionsByWorkspace = useMemo(() => {
    const merged: Record<string, typeof workspaceAgentSessions.sessionsByWorkspace[string]> = {};
    const workspaceIds = new Set([
      ...Object.keys(workspaceAgentSessions.sessionsByWorkspace),
      ...Object.keys(agentEvents.workspaceStates),
    ]);

    for (const workspaceId of workspaceIds) {
      const baseSessions = workspaceAgentSessions.sessionsByWorkspace[workspaceId] ?? [];
      const liveStates = agentEvents.workspaceStates[workspaceId] ?? {};
      merged[workspaceId] = baseSessions.map((session) => {
        const live = liveStates[session.id];
        if (!live) return session;
        return {
          ...session,
          status: live.status,
          pendingPermissionCount: Object.keys(live.pendingPermissions).length,
        };
      });
    }

    return merged;
  }, [agentEvents.workspaceStates, workspaceAgentSessions.sessionsByWorkspace]);

  const spacesBrowserProps = useSpacesBrowser({
    workspaces: remote.workspaces,
    sessions: remote.sessions,
    replays: remote.replays,
    onRequestSessions: () => remote.requestSessions(),
    onAttachSession: handleAttachSession,
    onOpenReplay: handleOpenReplay,
    onEditProcesses: handleEditProcesses,
    onManageBundleConfig: handleManageBundleConfig,
    onStartProcess: handleStartProcess,
    onStartProcessAttach: handleStartProcessAttach,
    onStopProcess: handleStopProcess,
    onProcessDisabled: handleProcessDisabled,
    onOpenAgents: async (workspaceId) => {
      setAgentPickerWorkspaceId(workspaceId);
      await workspaceAgentSessions.loadWorkspaceSessions(workspaceId);
    },
    onOpenAgentSession: async (workspaceId, agentSessionId) => {
      agentSessionPref.persist(agentSessionId);
      if (!remoteBackend?.attachAgentSession) {
        throw new Error('Agent attach unavailable');
      }
      await remoteBackend.attachAgentSession(workspaceId, agentSessionId);
    },
    onCreateAgentSession: async (workspaceId) => {
      flow.showInput({
        title: 'New Agent Session',
        label: 'Session name:',
        placeholder: 'Investigate auth bug',
        validation: (value) => value.trim() ? null : 'Session name is required',
        onSubmit: async (value) => {
          const sessions = await workspaceAgentSessions.createSession(workspaceId, value.trim());
          const created = sessions.find((session) => session.title === value.trim()) ?? sessions[0];
          if (!created) return;
          agentSessionPref.persist(created.id);
          if (!remoteBackend?.attachAgentSession) {
            throw new Error('Agent attach unavailable');
          }
          await remoteBackend.attachAgentSession(workspaceId, created.id);
        },
      });
    },
    agentSessionsByWorkspace,
    agentSessionCounts,
    pendingPermissionsByWorkspace: agentEvents.pendingPermissionsByWorkspace,
    onOpenEvents: handleOpenEvents,
    onRefresh: remote.requestWorkspaces,
    onRefreshSessions: () => {
      remote.requestSessions();
      remote.requestReplays();
    },
    onBack,
    machineName: machine.label || machine.machineId,
  });

  const selectedProjectName = useMemo(() => {
    const selected = spacesBrowserProps.selectedItem;
    if (!selected) {
      return null;
    }
    if (selected.type === 'project') {
      return selected.name;
    }
    if (selected.type === 'workspace') {
      return selected.workspace.projectName;
    }
    if ('workspaceId' in selected && typeof selected.workspaceId === 'string') {
      const separator = selected.workspaceId.indexOf(':');
      return separator > 0 ? selected.workspaceId.slice(0, separator) : null;
    }
    return null;
  }, [spacesBrowserProps.selectedItem]);

  const allInboxItems = useMemo(
    () => [...remote.inbox, ...agentInboxItems],
    [remote.inbox, agentInboxItems],
  );

  const inboxProps = useInbox({
    items: allInboxItems,
    unreadCount: remote.inboxUnreadCount + agentInboxItems.filter((i) => !i.read).length,
    onClearItem: async (id) => {
      const isAgent = agentInboxItems.some((i) => i.id === id);
      if (isAgent) {
        setAgentInboxItems((prev) => prev.filter((i) => i.id !== id));
      } else {
        remote.clearInboxItem(id);
      }
    },
    onClearAll: async () => {
      setAgentInboxItems([]);
      remote.clearInboxItem();
    },
    onMarkRead: async (id) => {
      const isAgent = agentInboxItems.some((i) => i.id === id);
      if (isAgent) {
        setAgentInboxItems((prev) => prev.map((i) => i.id === id ? { ...i, read: true } : i));
      } else {
        remote.markInboxItemRead(id);
      }
    },
    onAttachSession: async (sessionId) => {
      setShowInbox(false);
      const agentItem = agentInboxItems.find((i) => i.sessionId === sessionId && i.agentAction);
      if (agentItem?.agentAction) {
        const { workspaceId, agentSessionId, permissionId, permissionTitle } = agentItem.agentAction;
        if (permissionId) {
          flow.showSelect<'allow' | 'deny' | 'dismiss'>({
            title: `Permission: ${permissionTitle ?? 'Action requested'}`,
            options: [
              { label: 'Allow', value: 'allow' as const, description: 'Grant the agent permission to proceed' },
              { label: 'Deny', value: 'deny' as const, description: 'Deny the agent and stop this action' },
              { label: 'Dismiss', value: 'dismiss' as const, description: 'Close without responding (agent keeps waiting)' },
            ],
            onSelect: async (choice) => {
              if (choice === 'allow' || choice === 'deny') {
                await agentEvents.respondToPermission(workspaceId, agentSessionId, permissionId, choice);
              }
              setAgentInboxItems((prev) => prev.map((i) => i.sessionId === sessionId ? { ...i, read: true } : i));
            },
          });
        } else {
          setAgentPickerWorkspaceId(workspaceId);
          agentSessionPref.persist(agentSessionId);
          if (!remoteBackend?.attachAgentSession) {
            throw new Error('Agent attach unavailable');
          }
          await remoteBackend.attachAgentSession(workspaceId, agentSessionId);
        }
        return;
      }
      await handleAttachSession({ sessionId });
    },
    onClose: () => {
      setShowInbox(false);
    },
  });

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      const rawText = event.text ?? '';

      if (flow.isOpen && applySearchableSelectPaste(flow, rawText)) {
        event.preventDefault();
        return;
      }

      if (!flow.isOpen) {
        return;
      }

      const text = normalizeInputText(rawText);
      if (!text) {
        return;
      }

      const isWizardTextStep =
        isFlowWizard(flow.flow) &&
        (() => {
          const step = flow.flow.steps[flow.flow.currentStep];
          return step?.type === 'input' || step?.type === 'secret';
        })();

      if (isFlowInput(flow.flow) || isFlowConfirmTyped(flow.flow) || isWizardTextStep) {
        const current = 'inputValue' in flow.flow ? flow.flow.inputValue || '' : '';
        flow.handleInput(current + text);
        event.preventDefault();
        return;
      }

    };

    renderer.keyInput.on('paste', handlePaste);
    return () => {
      renderer.keyInput.off('paste', handlePaste);
    };
  }, [flow, renderer]);

  useKeyboard(async (key) => {
    const scriptTerminalRunning =
      showScriptTerminal &&
      (remote.scriptState?.isRunning ?? true);

    if (flow.isOpen && !scriptTerminalRunning) {
      if (flow.flow.type === 'confirm') {
        if (key.raw === 'y' || key.name === 'return') {
          await flow.handleConfirm();
        } else if (key.raw === 'n' || key.name === 'escape') {
          flow.handleCancel();
        }
        return;
      }

      const isWizardTextStep =
        isFlowWizard(flow.flow) &&
        (() => {
          const step = flow.flow.steps[flow.flow.currentStep];
          return step?.type === 'input' || step?.type === 'secret';
        })();

      if (isFlowInput(flow.flow) || isFlowConfirmTyped(flow.flow) || isWizardTextStep) {
        if (key.name === 'escape') {
          flow.handleCancel();
        } else if (key.name === 'return') {
          await flow.handleConfirm();
        } else if (key.name === 'backspace') {
          const current = 'inputValue' in flow.flow ? flow.flow.inputValue || '' : '';
          flow.handleInput(current.slice(0, -1));
        } else {
          const chunk = getKeyboardInputChunk(key);
          if (!chunk) {
            return;
          }
          const current = 'inputValue' in flow.flow ? flow.flow.inputValue || '' : '';
          flow.handleInput(current + chunk);
        }
        return;
      }

      if (await handleSearchableSelectKey(flow, key)) {
        return;
      }

      if (key.name === 'escape') {
        flow.handleCancel();
      } else if (key.name === 'return') {
        await flow.handleConfirm();
      } else if (key.name === 'up' || key.raw === 'k') {
        flow.moveUp();
      } else if (key.name === 'down' || key.raw === 'j') {
        flow.moveDown();
      }
      return;
    }

    if (remote.mode === 'attached') {
      return;
    }

    if (activeReplay) {
      return;
    }

    if (showScriptTerminal) {
      if (remote.scriptState?.isRunning && (key.raw === 'c' || key.name === 'c')) {
        remote.cancelPendingScripts();
        return;
      }

      if (
        !remote.scriptState?.isRunning &&
        !!remote.scriptState?.error &&
        (key.raw === 'a' || key.name === 'a') &&
        !!lastScriptWorkspaceIdRef.current
      ) {
        const workspaceId = lastScriptWorkspaceIdRef.current;
        if (!workspaceId) {
          return;
        }

        await attachController.attach({
          workspaceId,
          scriptPolicy: 'skip',
        });
        return;
      }

      if (
        !remote.scriptState?.isRunning &&
        (key.name === 'escape' || key.name === 'n' || key.raw === 'n')
      ) {
        lastScriptWorkspaceIdRef.current = null;
        setShowScriptTerminal(false);
      }
      return;
    }

    if (showInbox) {
      const command = resolveInboxCommand({
        name: key.name,
        raw: key.raw,
        shift: key.shift,
      });

      if (command === 'back') {
        if (inboxProps.isViewingThread) {
          inboxProps.closeThread();
        } else {
          setShowInbox(false);
        }
      } else if (command === 'move-up') {
        inboxProps.moveUp();
      } else if (command === 'move-down') {
        inboxProps.moveDown();
      } else if (command === 'activate') {
        if (inboxProps.isViewingThread) {
          await inboxProps.attachToSession();
        } else {
          await inboxProps.openThread();
        }
      } else if (command === 'delete') {
        if (inboxProps.isViewingThread) {
          await inboxProps.deleteThread();
        } else {
          await inboxProps.deleteSelected();
        }
      } else if (command === 'clear') {
        await inboxProps.clearAll();
      } else if (command === 'attach' && inboxProps.isViewingThread) {
        await inboxProps.attachToSession();
      }
      return;
    }

    const browseCommand = resolveSessionBrowserCommand({
      name: key.name,
      raw: key.raw,
      shift: key.shift,
    });

    if (browseCommand === 'back') {
      onBack();
      return;
    }

    if (remote.status !== 'established' || remote.mode !== 'browsing') {
      return;
    }

    if (browseCommand === 'help') {
      flow.showHelp(getDefaultShortcuts());
      return;
    }

    if (browseCommand === 'move-up') {
      spacesBrowserProps.moveUp();
    } else if (browseCommand === 'move-down') {
      spacesBrowserProps.moveDown();
    } else if (browseCommand === 'activate') {
      spacesBrowserProps.activateSelected();
    } else if (browseCommand === 'new') {
      lifecycleController.openCreateMenu(selectedProjectName);
    } else if (browseCommand === 'bundle') {
      const selected = spacesBrowserProps.selectedItem;
      const workspaceId = selected?.type === 'workspace'
        ? selected.workspace.id
        : selected && 'workspaceId' in selected
          ? selected.workspaceId
          : null;
      if (workspaceId) {
        await handleManageBundleConfig({ workspaceId });
      }
    } else if (browseCommand === 'refresh') {
      spacesBrowserProps.refresh();
    } else if (browseCommand === 'open-inbox') {
      remote.requestInbox();
      setShowInbox(true);
    } else if (browseCommand === 'kill') {
      const selected = spacesBrowserProps.selectedItem;
      if (selected?.type === 'session') {
        flow.showConfirm({
          title: 'Kill Session',
          message: `Kill session "${selected.session.name}"?`,
          variant: 'warning',
          confirmLabel: 'Kill',
          onConfirm: () => {
            remote.killSession(selected.session.id);
          },
        });
      } else if (selected?.type === 'process' && selected.status === 'running') {
        flow.showConfirm({
          title: 'Stop Process',
          message: `Stop process "${selected.processName}"?`,
          variant: 'warning',
          confirmLabel: 'Stop',
          onConfirm: () => {
            handleStopProcess({
              workspaceId: selected.workspaceId,
              processName: selected.processName,
            });
          },
        });
      }
    } else if (browseCommand === 'delete') {
      const selected = spacesBrowserProps.selectedItem;
      if (selected?.type === 'project') {
        lifecycleController.openDeleteProjectFlow(selected.name);
      } else if (selected?.type === 'workspace') {
        flow.showConfirmTyped({
          title: 'Delete Workspace',
          message: `Delete workspace "${selected.workspace.name}"?`,
          confirmText: selected.workspace.name,
          warning:
            selected.workspace.sessionCount > 0
              ? `This kills ${selected.workspace.sessionCount} active session(s).`
              : undefined,
          onConfirm: () => {
            void deleteWorkspaceWithPrompt({
              projectName: selected.workspace.projectName,
              workspaceId: selected.workspace.id,
              workspaceName: selected.workspace.name,
            });
          },
        });
      }
    }
  });

  const statusMessage = useMemo(() => {
    if (remote.status === 'connecting') {
      return 'Connecting to remote machine...';
    }
    if (remote.status === 'error') {
      return 'Connection failed';
    }
    if (remote.status === 'disconnected') {
      return 'Disconnected';
    }
    return '';
  }, [remote.status]);

  if (remote.mode === 'attached' && remote.attachedSessionId) {
    return (
      <Fragment>
        <SessionTerminal
          sessionName={remote.attachedSessionName ?? remote.attachedSessionId}
          endpointLabel="remote"
          onData={remote.send}
          onResize={remote.resize}
          onDetach={remote.detachSession}
          setWriteCallback={remote.setWriteCallback}
          readOnly={isViewOnlySession}
        />
      </Fragment>
    );
  }

  if (showScriptTerminal && remote.status === 'established' && remote.mode === 'browsing') {
    const isRunning = remote.scriptState?.isRunning ?? true;
    const scriptHint = isRunning
      ? '[Running scripts... c: cancel + attach anyway]'
      : remote.scriptState?.error
        ? '[←/→ or [/] Phase  [↑/↓ PgUp/PgDn] Scroll  [a] Attach anyway  [Esc/n] Back'
        : '[←/→ or [/] Phase  [↑/↓ PgUp/PgDn] Scroll  [Esc/n] Back';

    return (
      <Fragment>
        <box flexDirection="column" flexGrow={1} width="100%" height="100%">
          <ScriptTerminal
            phase={remote.scriptState?.phase ?? 'remove'}
            workspaceName={scriptWorkspaceName}
            isRunning={isRunning}
            error={remote.scriptState?.error}
            exitCode={remote.scriptState?.exitCode}
            modalOpen={flow.isOpen}
            setWriteCallback={remote.setWriteCallback}
          />
          <StatusBar hint={scriptHint} />
          {!isRunning && <FlowTUI flow={flow} />}
        </box>
      </Fragment>
    );
  }

  if (showInbox) {
    return (
      <Fragment>
        <InboxTUI {...inboxProps} focused={true} />
        <FlowTUI flow={flow} />
        <StatusBar hint="[↑↓] Navigate  [Enter] Open/Attach  [x] Delete  [c] Clear  [Esc] Back" />
      </Fragment>
    );
  }

  if (activeReplay && remote.status === 'established' && remote.mode === 'browsing') {
    return (
      <Fragment>
        <ReplayTerminal
          replay={activeReplay}
          loadReplayFrame={loadReplayFrame}
          loadReplayTimeline={loadReplayTimeline}
          onBack={() => {
            setActiveReplay(null);
          }}
          onDismiss={activeReplay.status === 'running' ? undefined : handleReplayDismiss}
          onCleanup={remote.cancelPendingReplayRequests}
        />
        <FlowTUI flow={flow} />
      </Fragment>
    );
  }

  if (remote.status !== 'established') {
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={remote.status === 'error' ? COLORS.error : COLORS.loading}>{statusMessage}</text>
        {connectErrorLines.length > 0 && (
          <box marginTop={1} width={76} border borderStyle="single" borderColor={COLORS.error} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexDirection="column">
            {connectErrorLines.map((line, index) => (
              <text key={`${index}:${line}`} fg={COLORS.error}>{line}</text>
            ))}
          </box>
        )}
        <text fg={COLORS.textDim} marginTop={1}>Press Esc to return to machines</text>
        <FlowTUI flow={flow} />
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.title}>{`● ${machine.label || machine.machineId}`}</text>
        <text fg={COLORS.textDim}>{`Inbox: ${remote.inboxUnreadCount}`}</text>
      </box>
      <SpacesBrowserTUI {...spacesBrowserProps} focused={true} />
      <FlowTUI flow={flow} />
      <StatusBar hint="[↑↓] Navigate  [Enter] Open/Join  [n] Create  [b] Bundle  [x] Kill  [d] Delete  [i] Inbox  [Esc] Back" />
    </box>
  );
}
