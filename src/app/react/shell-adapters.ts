/**
 * Re-exports of domain helpers and hooks that shells need but should not import
 * directly from low-level layers. This module is safe to import from the web
 * shell — it contains no Node/Bun-only dependencies.
 *
 * TUI-only re-exports live in shell-adapters.tui.ts to avoid pulling
 * tmux-lite/cli.ts (shebang + Bun APIs) into the Vite browser bundle.
 */

// Activity tracking
export { useUserActivity } from '../../hooks/index.js';

// Process command spec builders (web-safe — no fs/path)
export { buildEditProcessesCommand } from '../../lib/processes/editor.js';
