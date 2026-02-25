export type {
  BackendKey,
  BackendKind,
  BackendDescriptor,
  SessionBackend,
  AttachSessionParams,
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
} from './backend.js';

export type {
  WorkspaceSource,
  SessionLinearAttachmentSummary,
  SessionLinearIssueSummary,
} from '../types/lifecycle.js';

export type {
  BundleRefreshStep,
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';

export type {
  BackendEvent,
} from './events.js';

export type {
  ScriptRuntimeState,
  BackendSessionState,
  SessionEngineState,
  SessionEngineAction,
} from './types.js';

export {
  buildRemoteBackendKey,
} from './backend-key.js';

export {
  createInitialSessionEngineState,
  sessionEngineReducer,
} from './reducer.js';

export {
  getActiveBackendKey,
  getActiveBackendState,
  getBackendState,
  getBackendKeys,
  getConnectedBackendKeys,
} from './selectors.js';

export {
  BackendManager,
} from './backend-manager.js';

export {
  useSessionEngine,
} from './useSessionEngine.js';

export type {
  RemoteSessionConnectionStatus,
  RemoteSessionPtyBackend,
  UseRemoteSessionClientOptions,
  UseRemoteSessionClientReturn,
} from './useRemoteSessionClient.js';

export {
  useRemoteSessionClient,
} from './useRemoteSessionClient.js';

export type {
  BundleRefreshCommandError,
  BundleRefreshAttachParams,
  UseBundleRefreshAttachFlowOptions,
  UseBundleRefreshAttachFlowResult,
} from './useBundleRefreshAttachFlow.js';

export {
  useBundleRefreshAttachFlow,
} from './useBundleRefreshAttachFlow.js';

export type {
  RemoteSessionSocketHandlers,
  RemoteSessionSocketAdapter,
  RemoteSessionCryptoAdapter,
  RemoteSessionHandshakeAdapter,
  RemoteSessionBackendOptions,
} from './backends/remote-session-backend.js';

export {
  RemoteSessionBackend,
} from './backends/remote-session-backend.js';

export type {
  LocalSessionBackendDependencies,
  LocalSessionBackendOptions,
} from './backends/local-session-backend.js';

export {
  LocalSessionBackend,
} from './backends/local-session-backend.js';

export type {
  NodeRemoteSocket,
} from './adapters/node-remote.js';

export {
  nodeRemoteSocketAdapter,
  nodeRemoteCryptoAdapter,
  nodeRemoteHandshakeAdapter,
  createNodeRelaySigner,
} from './adapters/node-remote.js';

export type {
  BrowserRemoteSocket,
  BrowserRemoteFrameCodec,
} from './adapters/browser-remote.js';

export {
  browserRemoteSocketAdapter,
  createBrowserRemoteCryptoAdapter,
  createBrowserRemoteHandshakeAdapter,
  deriveRelayUrlFromBrowserSocket,
} from './adapters/browser-remote.js';
