#!/usr/bin/env bun

// Pre-extract embedded native addon before pi-natives initializes (no-op in dev).
import './native-addon-embed.generated.js';

/**
 * GitSpace CLI (gssh) - Main entry point
 *
 * Thin orchestrator that handles:
 * 1. Internal subprocess commands (--internal-tmux-server, --internal-process-runner,
 *    --internal-agent-worker, --internal-offload-worker)
 * 2. Workspace session guard (GSSH_SESSION_MODE=workspace)
 * 3. CLI command dispatch via src/cli/index.ts
 *
 * There is no TUI: the interactive surface is the web app, served by
 * `gssh machine serve start`.
 */

// ============================================================================
// Internal commands (must be before any other imports)
// ============================================================================

if (process.argv.includes('--internal-tmux-server')) {
	if (process.argv.includes('--test')) {
		process.env.TMUX_LITE_SOCKET = '/tmp/tmux-lite-test.sock';
		process.env.TMUX_LITE_SESSION_DIR = '/tmp/tmux-lite-test';
		process.env.TMUX_LITE_PID_FILE = '/tmp/tmux-lite-test.pid';
	}
	await import('./lib/tmux-lite/server.js');
	await new Promise(() => {});
}

if (process.argv.includes('--internal-process-runner')) {
	await import('./lib/processes/runner.js');
	await new Promise(() => {});
}

if (process.argv.includes('--internal-agent-worker')) {
	await import('./lib/tmux-lite/agents/worker/agent-worker.js');
	await new Promise(() => {});
}

if (process.argv.includes('--internal-offload-worker')) {
	await import('./lib/tmux-lite/offload/offload-worker.js');
	await new Promise(() => {});
}

// ============================================================================
// Imports
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { VERSION as GENERATED_VERSION } from './version.generated.js';
import { logger } from './utils/logger.js';
import { getCrashLogPath, writeCrashLog } from './utils/crash-log.js';
import { SpacesError } from './types/errors.js';
import { installOwnerSyncWriteHandler } from './core/owner-sync.js';
import { promptPassword } from './utils/prompts.js';

// ============================================================================
// Version resolution
// ============================================================================

let VERSION = GENERATED_VERSION;
try {
	const pkgPath = join(import.meta.dir, '../package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
	VERSION = pkg.version;
} catch {
	// Compiled binary — use generated version
}

// ============================================================================
// Workspace session guard
// ============================================================================

function isWorkspaceScopedSession(): boolean {
	return process.env.GSSH_SESSION_MODE === 'workspace';
}

function isAllowedWorkspaceSessionCommand(args: string[]): boolean {
	if (args.length === 0) return false;
	const first = args[0];
	if (!first) return false;

	// Always allowed
	if (first === 'space') return true;
	if (first === '--help' || first === '-h' || first === '--version' || first === '-V') return true;
	if (first === 'help') return true;

	return false;
}

// ============================================================================
// Global error handlers
// ============================================================================

process.on('uncaughtException', (error) => {
	const logPath = writeCrashLog('uncaughtException', error);
	logger.error(`Uncaught exception: ${error.message}`);
	if (logPath) {
		logger.error(`Crash log written to ${logPath}`);
	}
	logger.debug(error.stack || '');
	process.exit(1);
});

process.on('unhandledRejection', (reason) => {
	const logPath = writeCrashLog('unhandledRejection', reason);
	logger.error(`Unhandled rejection: ${reason}`);
	if (logPath) {
		logger.error(`Crash log written to ${logPath}`);
	}
	process.exit(1);
});

logger.debug(`Crash log path: ${getCrashLogPath()}`);
// ============================================================================
// Main dispatch
// ============================================================================

const args = process.argv.slice(2);

installOwnerSyncWriteHandler();

// Guard: workspace session only allows `space` and help commands
if (isWorkspaceScopedSession() && !isAllowedWorkspaceSessionCommand(args)) {
	if (args.length === 0) {
		logger.error('Bare `gssh` is disabled inside a workspace session.');
	} else if (args[0] === 'tmux') {
		logger.error('tmux commands are disabled inside workspace sessions.');
	} else {
		logger.error('This command is disabled inside a workspace session.');
	}
	logger.log('Use `space ...` for workspace-scoped operations.');
	process.exit(1);
}

// Main dispatch — the CLI is the only entrypoint (the TUI was removed; the
// interactive surface is the web app, served via `gssh machine serve start`).
const { createProgram } = await import('./cli/index.js');
const program = createProgram(VERSION);
if (process.argv.length === 2) {
	// Bare `gssh` — show help rather than doing nothing.
	program.outputHelp();
	process.exit(0);
}
program.parse();
