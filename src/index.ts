#!/usr/bin/env bun

/**
 * GitSpace CLI (gssh) - Main entry point
 *
 * Thin orchestrator that handles:
 * 1. Internal subprocess commands (--internal-tmux-server, --internal-process-runner)
 * 2. TUI launch (no args or only --relay/--ignore-keychain-and-skip-secrets)
 * 3. Workspace session guard (GSSH_SESSION_MODE=workspace)
 * 4. CLI command dispatch via src/cli/index.ts
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

// ============================================================================
// Imports
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { VERSION as GENERATED_VERSION } from './version.generated.js';
import { logger } from './utils/logger.js';
import { getCrashLogPath, writeCrashLog } from './utils/crash-log.js';
import { SpacesError } from './types/errors.js';
import { initializeOwnerSync } from './core/owner-sync.js';
import { findReachableRelayCandidate } from './core/relay-discovery.js';
import { keypairExists, loadKeypair } from './core/identity.js';
import { promptPassword } from './utils/prompts.js';
import type { Identity } from './types/identity.js';

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

try {
	await initializeOwnerSync();
} catch {
	// owner sync is best-effort; continue on local cache
}

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

// Detect TUI mode: no args, or only --relay / --ignore-keychain-and-skip-secrets
let relayUrlFromArgs: string | undefined;
let ignoreKeychainAndSkipSecrets = false;
let hasOnlyTuiOptions = true;

async function resolveRemoteTuiIdentity(options: {
	relayRequestedExplicitly: boolean;
	relayLabel: string;
}): Promise<Identity | null> {
	if (!keypairExists()) {
		if (options.relayRequestedExplicitly) {
			throw new SpacesError(
				'Remote relay access requires a local device identity. Run `gssh user auth login` or create one before using `gssh --relay`.',
				'USER_ERROR',
				1,
			);
		}
		return null;
	}

	const passwordFromEnv = process.env.GITSPACE_IDENTITY_PASSWORD;
	if (passwordFromEnv) {
		try {
			return await loadKeypair(passwordFromEnv);
		} catch (error) {
			if (options.relayRequestedExplicitly) {
				throw error instanceof SpacesError
					? error
					: new SpacesError('Failed to unlock local device identity.', 'USER_ERROR', 1);
			}
			logger.warning(
				`Could not unlock local device identity for remote machines (${error instanceof Error ? error.message : String(error)}). Falling back to an interactive prompt.`,
			);
		}
	}

	if (!(process.stdin.isTTY && process.stdout.isTTY)) {
		if (options.relayRequestedExplicitly) {
			throw new SpacesError(
				'Remote relay access requires unlocking your local device identity in an interactive terminal.',
				'USER_ERROR',
				1,
			);
		}
		return null;
	}

	logger.log('');
	logger.info(`Remote machines are available via ${options.relayLabel}.`);
	const password = await promptPassword('Enter password to unlock your local device identity (leave blank to stay local):');
	if (!password) {
		if (options.relayRequestedExplicitly) {
			throw new SpacesError('Cancelled', 'USER_ERROR', 1);
		}
		logger.dim('Starting in local-only mode. Use `gssh --relay <url>` to try again later.');
		return null;
	}

	try {
		return await loadKeypair(password);
	} catch (error) {
		if (options.relayRequestedExplicitly) {
			throw error instanceof SpacesError
				? error
				: new SpacesError('Failed to unlock local device identity.', 'USER_ERROR', 1);
		}
		logger.warning(
			`Could not unlock local device identity for remote machines (${error instanceof Error ? error.message : String(error)}). Starting in local-only mode.`,
		);
		return null;
	}
}

for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === '--relay') {
		const value = args[i + 1];
		if (!value || value.startsWith('--')) {
			hasOnlyTuiOptions = false;
			break;
		}
		relayUrlFromArgs = value;
		i += 1;
		continue;
	}

	if (arg === '--ignore-keychain-and-skip-secrets') {
		ignoreKeychainAndSkipSecrets = true;
		continue;
	}

	hasOnlyTuiOptions = false;
	break;
}

if (process.argv.length === 2 || hasOnlyTuiOptions) {
	// ---- TUI mode ----
	const { checkFirstTimeSetup } = await import('./cli/setup.js');
	const { launchTUI } = await import('./tui/index.js');

	checkFirstTimeSetup()
		.then(async () => {
			const relayCandidate = relayUrlFromArgs
				? { url: relayUrlFromArgs, label: relayUrlFromArgs, source: 'explicit' as const }
				: await findReachableRelayCandidate({ includeLocalRelay: false });

			const remoteIdentity = relayCandidate
				? await resolveRemoteTuiIdentity({
					relayRequestedExplicitly: Boolean(relayUrlFromArgs),
					relayLabel: relayCandidate.label,
				})
				: null;

			const relayConfig = relayCandidate && remoteIdentity
				? {
					url: relayCandidate.url,
					label: relayCandidate.label,
					source: relayCandidate.source,
					autoConnected: !relayUrlFromArgs,
				}
				: undefined;

			return launchTUI(relayConfig, {
				ignoreKeychainAndSkipSecrets,
				remoteIdentity,
			});
		})
		.catch((error) => {
			if (error instanceof SpacesError) {
				logger.error(error.message);
				process.exit(error.exitCode);
			}
			logger.error(`Failed to launch TUI: ${error instanceof Error ? error.message : 'Unknown error'}`);
			process.exit(1);
		});
} else {
	// ---- CLI mode ----
	const { createProgram } = await import('./cli/index.js');
	const program = createProgram(VERSION);
	program.parse();
}
