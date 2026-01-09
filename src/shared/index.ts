/**
 * Shared module exports
 *
 * Platform-agnostic types, providers, hooks, and components for TUI and Web.
 */

// Types
export type {
  MachineStatus,
  MachineInfo as SharedMachineInfo,
  Project,
  Workspace,
  WorkspaceSession,
  InboxItem,
  InboxItemType,
  SessionStream,
  NavigationLocation,
  PanelFocus,
} from './types.js';

// Providers
export type {
  MachineProvider,
  CreateSessionOptions,
  AttachSessionOptions,
  MachineProviderEvent,
  MachineProviderEventHandler,
  EventedMachineProvider,
  RemoteMachineProviderConfig,
} from './providers/index.js';

export {
  LocalMachineProvider,
  getLocalMachineProvider,
  RemoteMachineProvider,
  createRemoteMachineProvider,
} from './providers/index.js';

// Hooks
export type {
  NavigationState,
  NavigationAction,
} from './hooks/index.js';

export {
  createInitialNavigationState,
  navigationReducer,
  getCurrentMachineId,
  getCurrentProjectName,
  canGoBack,
} from './hooks/index.js';

// Components - MachineList
export type {
  ConnectionStatus,
  MachineInfo,
  UseMachineListProps,
  MachineListItem,
  UseMachineListReturn,
} from './components/index.js';

export {
  useMachineList,
  formatLastSeen,
  getStatusColor,
  getMachineLabel,
} from './components/index.js';

// Components - SpacesBrowser
export type {
  WorkspaceInfo,
  SessionInfo,
  TreeItem,
  TreeItemWithState,
  UseSpacesBrowserProps,
  UseSpacesBrowserReturn,
} from './components/index.js';

export {
  useSpacesBrowser,
  formatTime,
} from './components/index.js';

// Components - Inbox
export type {
  InboxItem as SharedInboxItem,
  InboxItemType as SharedInboxItemType,
  ParsedSessionName,
  SessionGroup,
  WorkspaceGroup,
  ProjectGroup,
  InboxDisplayItem,
  UseInboxProps,
  UseInboxReturn,
} from './components/index.js';

export {
  useInbox,
  parseSessionName,
  getInboxIcon,
  getInboxTypeLabel,
  formatTimeAgo,
} from './components/index.js';

// Components - ProjectList
export type {
  ProjectInfo,
  ProjectListItem,
  UseProjectListProps,
  UseProjectListReturn,
} from './components/index.js';

export {
  useProjectList,
  getProjectDisplayName,
  getShortRepoName,
  formatWorkspaceCount,
} from './components/index.js';

// Components - renderers (import separately for tree-shaking)
// Web: import { MachineListWeb, SpacesBrowserWeb, InboxWeb, ProjectListWeb } from '@spaces/shared/components'
// TUI: import { MachineListTUI, SpacesBrowserTUI, InboxTUI, ProjectListTUI } from '@spaces/shared/components'
