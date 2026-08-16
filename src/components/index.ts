/**
 * Shared components exports
 *
 * NOTE: Web components (*.web.js) are NOT exported here because they
 * depend on react-dom which is not available in CLI/TUI context.
 * Import web components directly from their files in the web project.
 *
 * (The TUI has been removed; the web app is the only UI surface.)
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
  ReplayInfo,
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
