/**
 * TUI entry point
 * Exports the main TUI launcher
 */

export { launchTUI, type TUIRelayConfig } from './app.jsx';
export * from './state.js';
// Note: hooks/index exports AppState which conflicts with state.js
// Explicitly re-export without the duplicate
export {
  useRemoteMachines,
  type RelayConfig,
  type UseRemoteMachinesOptions,
  type ConnectionStatus,
  type UseRemoteMachinesReturn,
  useAppState,
  type AppView,
  type PanelFocus,
  type AppAction,
  type UseAppStateOptions,
  useTUIInbox,
} from './hooks/index.js';
// Export hook's AppState with a distinct name
export type { AppState as HookAppState } from './hooks/index.js';
