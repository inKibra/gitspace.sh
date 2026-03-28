// Engine
export { GitSpaceEngine, LOCAL_BACKEND_KEY } from './engine/engine.js';
export type { GitSpaceEngineListener } from './engine/engine.js';

// Types
export type { GitSpaceConfig, PlatformAdapters, CreateRemoteBackendParams } from './engine/types.js';

// React
export { GitSpaceProvider, useGitSpace, useGitSpaceEngine } from './react.js';
export type { GitSpaceProviderProps, GitSpaceContextValue } from './react.js';

// Re-export key domain types that SDK consumers need
export type { MultiMachineState, BackendMachineState, BackendScopedWorkspaceRef, BackendScopedSessionRef, BackendScopedAgentSessionRef } from '../machine/multi/types.js';
export type { BackendKey, SessionBackend } from '../session/backend.js';
export type { Identity } from '../types/identity.js';
export type { RelayDescriptor } from '../relay-client/index.js';
