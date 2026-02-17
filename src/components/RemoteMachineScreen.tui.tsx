import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { useAttachController } from '../app/session/useAttachController.js';
import {
  resolveInboxCommand,
  resolveSessionBrowserCommand,
} from '../app/input/sessionCommands.js';
import { SessionTerminal } from './SessionTerminal.tui.js';
import { ScriptTerminal, type ScriptTerminalHandle } from './ScriptTerminal.tui.js';
import { getKeyboardInputChunk, normalizeInputText } from '../tui/input-text.js';
import { useWorkspaceDeleteFlow } from '../app/session/useWorkspaceDeleteFlow.js';

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

export function RemoteMachineScreen({ machine, relayUrl, identity, onBack }: RemoteMachineScreenProps) {
  const remote = useRemoteTerminal();
  const renderer = useRenderer();
  const [showInbox, setShowInbox] = useState(false);
  const [showScriptTerminal, setShowScriptTerminal] = useState(false);
  const [scriptWorkspaceName, setScriptWorkspaceName] = useState('workspace');
  const scriptTerminalRef = useRef<ScriptTerminalHandle | null>(null);
  const flow = useFlow({
    onError: (error) => {
      remote.disconnect();
      console.error(`[tui] Remote machine flow error: ${error.message}`);
    },
  });
  const bundleRefreshAttach = useBundleRefreshAttachFlow({
    flow,
    commandError: remote.commandError ?? null,
    attachSession: (params) => remote.attachSession(params),
    getBundleRefreshPlan: remote.getBundleRefreshPlan,
    applyBundleRefresh: remote.applyBundleRefresh,
    resolveProjectName: (workspaceId) => {
      const separator = workspaceId.indexOf(':');
      if (separator > 0) {
        return workspaceId.slice(0, separator);
      }
      return remote.selectedProjectName;
    },
  });

  const attachController = useAttachController({
    flow,
    attachSessionWithBundleRefresh: bundleRefreshAttach.attachSessionWithBundleRefresh,
    defaultProjectName: remote.selectedProjectName,
    resolveProjectName: (workspaceId) => {
      const separator = workspaceId.indexOf(':');
      if (separator > 0) {
        return workspaceId.slice(0, separator);
      }
      return remote.selectedProjectName;
    },
    onBeforeAttach: ({ target, params }) => {
      if (target === 'workspace' && params.workspaceId) {
        setShowInbox(false);
        setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        setShowScriptTerminal(true);
      }
    },
    onAttachCancelled: ({ target }) => {
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

  useEffect(() => {
    if (!showScriptTerminal || remote.mode !== 'browsing') {
      return;
    }

    remote.setWriteCallback((data) => {
      scriptTerminalRef.current?.feed(data);
    });

    return () => {
      remote.setWriteCallback(null);
    };
  }, [remote.mode, remote.setWriteCallback, showScriptTerminal]);

  useEffect(() => {
    void remote.connect({
      relayUrl,
      identity,
      machineId: machine.machineId,
      machineLabel: machine.label,
    });

    return () => {
      remote.disconnect();
    };
  }, [identity, machine.label, machine.machineId, relayUrl]);

  useEffect(() => {
    if (remote.status !== 'established' || remote.mode !== 'browsing') {
      return;
    }
    remote.requestProjects();
    remote.requestWorkspaces();
    remote.requestSessions();
    remote.requestNotificationConfig();
  }, [remote.mode, remote.status]);

  useEffect(() => {
    if (remote.mode === 'attached') {
      setShowScriptTerminal(false);
    }
  }, [remote.mode]);

  const spacesBrowserProps = useSpacesBrowser({
    workspaces: remote.workspaces,
    sessions: remote.sessions,
    onRequestSessions: () => remote.requestSessions(),
    onAttachSession: attachController.attachFromSelection,
    onRefresh: remote.requestWorkspaces,
    onRefreshSessions: () => remote.requestSessions(),
    onBack,
    machineName: machine.label || machine.machineId,
  });

  const inboxProps = useInbox({
    items: remote.inbox,
    unreadCount: remote.inboxUnreadCount,
    onClearItem: async (id) => {
      remote.clearInboxItem(id);
    },
    onClearAll: async () => {
      remote.clearInboxItem();
    },
    onMarkRead: async (id) => {
      remote.markInboxItemRead(id);
    },
    onAttachSession: async (sessionId) => {
      setShowInbox(false);
      await attachController.attach({ sessionId });
    },
    onClose: () => {
      setShowInbox(false);
    },
  });

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (!flow.isOpen) {
        return;
      }

      const text = normalizeInputText(event.text ?? '');
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

    if (showScriptTerminal) {
      if (
        !remote.scriptState?.isRunning &&
        (key.name === 'escape' || key.name === 'n' || key.raw === 'n')
      ) {
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
      spacesBrowserProps.createNewSession();
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
      }
    } else if (browseCommand === 'delete') {
      const selected = spacesBrowserProps.selectedItem;
      if (selected?.type === 'workspace') {
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
        />
      </Fragment>
    );
  }

  if (showScriptTerminal && remote.status === 'established' && remote.mode === 'browsing') {
    const isRunning = remote.scriptState?.isRunning ?? true;
    return (
      <Fragment>
        <ScriptTerminal
          ref={scriptTerminalRef}
          phase={remote.scriptState?.phase ?? 'remove'}
          workspaceName={scriptWorkspaceName}
          isRunning={isRunning}
          error={remote.scriptState?.error}
          exitCode={remote.scriptState?.exitCode}
        />
        {!isRunning && <FlowTUI flow={flow} />}
        <StatusBar hint={isRunning ? '[Running scripts...]' : '[Esc/n] Back to workspaces'} />
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

  if (remote.status !== 'established') {
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={remote.status === 'error' ? COLORS.error : COLORS.loading}>{statusMessage}</text>
        <text fg={COLORS.textDim} marginTop={1}>Press Esc to return to machines</text>
        <FlowTUI flow={flow} />
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.title}>● {machine.label || machine.machineId}</text>
        <text fg={COLORS.textDim}>Inbox: {remote.inboxUnreadCount}</text>
      </box>
      <SpacesBrowserTUI {...spacesBrowserProps} focused={true} />
      <FlowTUI flow={flow} />
      <StatusBar hint="[↑↓] Navigate  [Enter] Open/Join  [n] New Session  [x] Kill  [d] Delete  [i] Inbox  [Esc] Back" />
    </box>
  );
}
