/**
 * TUI-only re-exports that must NOT be imported by the web shell.
 *
 * These modules pull in Node/Bun-only dependencies (tmux-lite/cli.ts,
 * core/config.ts with fs/path, etc.) that break the Vite browser build.
 */

// Daemon status polling — imports tmux-lite/cli.ts (has shebang, uses Bun APIs)
export { useDaemonStatus, formatRelayStatus } from '../../hooks/useDaemonStatus.tui.js';

// Agent display / notification helpers
export { agentNotificationToInboxItem } from '../../agents/agentNotificationToInboxItem.js';
export { getAgentSessionDisplayTitle } from '../../agents/session-display.js';

// Core config reads (uses fs/path)
export { readProjectConfig, getProjectBaseDir, projectExists } from '../../core/config.js';

// Process config validation (uses fs/path)
export { loadProcessesConfigWithDiagnostics } from '../../lib/processes/config.js';

// Session command spec builders
export { buildWorkspaceSessionCommand } from '../../session/workspace-shell-hooks.js';
