/**
 * TUI entry point
 * Exports the main TUI launcher
 */

export { launchTUI, type TUIRelayConfig } from './app.js';
// Re-export selected hooks used by consumers.
export {
  useRemoteMachines,
  type RelayConfig,
  type UseRemoteMachinesOptions,
  type ConnectionStatus,
  type UseRemoteMachinesReturn,
  useRemoteTerminal,
  type SessionMode,
  type ScriptState,
  useLocalSession,
} from '../hooks/index.tui.js';
