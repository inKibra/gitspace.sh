/**
 * Shared components exports
 *
 * NOTE: Web components (*.web.js) are NOT exported here because they
 * depend on react-dom which is not available in CLI/TUI context.
 * Import web components directly from their files in the web project.
 *
 * TUI components are also not exported here to avoid @opentui/core deps.
 * Import TUI components directly from their files in the TUI project.
 */

// MachineList
export type {
  ConnectionStatus,
  MachineInfo,
  UseMachineListProps,
  MachineListItem,
  UseMachineListReturn,
} from './MachineList.js';

export {
  useMachineList,
  formatLastSeen,
  getStatusColor,
  getMachineLabel,
} from './MachineList.js';

// SpacesBrowser
export type {
  WorkspaceProcessInfo,
  WorkspaceProcessPort,
  WorkspaceInfo,
  SessionInfo,
  TreeItem,
  TreeItemWithState,
  UseSpacesBrowserProps,
  UseSpacesBrowserReturn,
} from './SpacesBrowser.js';

export {
  useSpacesBrowser,
  formatTime,
} from './SpacesBrowser.js';

// Inbox
export type {
  InboxItemType,
  InboxItem,
  ParsedSessionName,
  SessionGroup,
  WorkspaceGroup,
  ProjectGroup,
  InboxDisplayItem,
  UseInboxProps,
  UseInboxReturn,
} from './Inbox.js';

export {
  useInbox,
  parseSessionName,
  getInboxIcon,
  getInboxTypeLabel,
  formatTimeAgo,
} from './Inbox.js';

// ProjectList
export type {
  ProjectInfo,
  ProjectListItem,
  UseProjectListProps,
  UseProjectListReturn,
} from './ProjectList.js';

export {
  useProjectList,
  getProjectDisplayName,
  getShortRepoName,
  formatWorkspaceCount,
} from './ProjectList.js';

// Flow (Modal System)
export type {
  FlowNone,
  FlowMessage,
  FlowLoading,
  FlowHelp,
  FlowConfirm,
  FlowConfirmTyped,
  FlowInput,
  FlowSelect,
  FlowWizardStep,
  FlowWizard,
  FlowState,
  UseFlowProps,
  UseFlowReturn,
} from './Flow.js';

export {
  useFlow,
  getDefaultShortcuts,
  isFlowInput,
  isFlowConfirmTyped,
  isFlowWizard,
  hasInputValue,
} from './Flow.js';
