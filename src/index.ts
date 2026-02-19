#!/usr/bin/env bun

/**
 * GitSpace CLI (gssh) - Main entry point
 * Manages GitHub workspaces with git worktrees and secure remote terminal access
 */

// Internal command: run tmux-lite server directly (for compiled binary)
// This must be checked before any other imports to avoid loading unnecessary modules
if (process.argv.includes('--internal-tmux-server')) {
	// Pass through --test flag if present
	if (process.argv.includes('--test')) {
		process.env.TMUX_LITE_SOCKET = '/tmp/tmux-lite-test.sock';
		process.env.TMUX_LITE_SESSION_DIR = '/tmp/tmux-lite-test';
		process.env.TMUX_LITE_PID_FILE = '/tmp/tmux-lite-test.pid';
	}
	// Import and run server (module auto-starts on import)
	await import('./lib/tmux-lite/server.js');
	// Keep process alive - server runs via Bun.listen() which is async
	// We need to prevent the rest of this file from executing
	await new Promise(() => {}); // Block forever
}

import { Command } from 'commander'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isFirstTimeSetup, initializeSpaces } from './core/config.js'
import { VERSION as GENERATED_VERSION } from './version.generated.js'

// Read version from package.json in dev, fall back to generated for compiled binary
let VERSION = GENERATED_VERSION
try {
	const pkgPath = join(import.meta.dir, '../package.json')
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
	VERSION = pkg.version
} catch {
	// Compiled binary - use generated version
}
import { logger } from './utils/logger.js'
import { SpacesError } from './types/errors.js'
import { addProject, addWorkspace } from './commands/add.js'
import { switchProject, switchWorkspace } from './commands/switch.js'
import { listProjects, listWorkspaces } from './commands/list.js'
import { removeWorkspace, removeProject } from './commands/remove.js'
import { ensureDependencies } from './utils/deps.js'
import { getProjectDirectory } from './commands/directory.js'
import { launchTUI } from './tui/index.js'
import { addAccessKey, listAccessKeys, removeAccessKey } from './commands/access.js'
import { createShare } from './commands/share.js'
import { initIdentity, showIdentity } from './commands/identity.js'
import { connectToRemote } from './commands/connect.js'
import { serve, serveStart, serveStop, serveStatus } from './commands/serve.js'
import { startRelay, authorizeMachine, revokeMachine, listMachines, listTrustedRelays, untrustRelay } from './commands/relay.js'
import { authLogin, authLogout, authStatus } from './commands/auth.js'
import { hostReserve, hostRelease, hostList, hostSetPrimary, hostStatus } from './commands/host.js'
import { startTmux, stopTmux, statusTmux, listTmux, newTmux, attachTmux, killTmux } from './commands/tmux.js'
import { showStatus } from './commands/status.js'
import { configNotifications, linearSetup, linearShow, linearClear } from './commands/config.js'
import { migrateCleanupLegacy } from './commands/migrate.js'
import { notificationsInstall, notificationsUninstall, notificationsHook, notificationsStatus } from './commands/notifications.js'
import { bundleRefresh, bundleStatus } from './commands/bundle.js'
import {
	openReview,
	showReviewNotes,
	importReview,
	pushReview,
	listReviewHunks,
	addHunkReview,
	addFileReview,
	addLineReview,
	showSpaceContext,
} from './commands/review.js'

const program = new Command()

// Package info
program
	.name('gssh')
	.description('GitSpace CLI - Manage GitHub workspaces with secure remote terminal access')
	.version(VERSION)

// First-time setup check
async function checkFirstTimeSetup(): Promise<void> {
	if (isFirstTimeSetup()) {
		logger.bold('Welcome to GitSpace CLI!\n')
		logger.log('Initializing gitspace directory...\n')

		// Check dependencies
		try {
			await ensureDependencies()
		} catch (error) {
			if (error instanceof SpacesError) {
				logger.error(error.message)
				process.exit(error.exitCode)
			}
			throw error
		}

		// Initialize spaces
		initializeSpaces()

		logger.success('GitSpace initialized!\n')
		logger.log('Get started by adding a project:')
		logger.command('  gssh add project\n')
	}
}

// ============================================================================
// Add Commands
// ============================================================================

const addCommand = program
	.command('add')
	.description('Add a new project or workspace')

addCommand
	.command('project')
	.description('Add a new project from GitHub')
	.option('--no-clone', 'Create project structure without cloning')
	.option('--org <org>', 'Filter repos to specific organization')
	.option('--linear-key <key>', 'Provide Linear API key via flag')
	.option('--bundle-url <url>', 'Load bundle from remote URL (zip archive)')
	.option('--bundle-path <path>', 'Load bundle from local directory')
	.option('--skip-bundle', 'Skip bundle detection and onboarding')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await addProject(options)
		} catch (error) {
			handleError(error)
		}
	})

addCommand
	.argument('[workspace-name]', 'Name of the workspace to create')
	.option(
		'--branch <name>',
		'Specify different branch name from workspace name'
	)
	.option('--from <branch>', 'Create from specific branch instead of base')
	.option('--no-shell', "Don't open interactive shell after creating workspace")
	.option('--no-setup', 'Skip setup commands')
	.action(async (workspaceName, options) => {
		await checkFirstTimeSetup()
		try {
			// Map commander option names to CreateWorkspaceOptions property names
			await addWorkspace(workspaceName, {
				branchName: options.branch,
				fromBranch: options.from,
				noShell: options.shell === false,
				noSetup: options.setup === false,
			})
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Switch Commands
// ============================================================================

const switchCommand = program
	.command('switch')
	.alias('sw')
	.description('Switch to a different project or workspace')

switchCommand
	.command('project')
	.description('Switch to a different project')
	.argument('[project-name]', 'Name of the project to switch to')
	.action(async (projectName) => {
		await checkFirstTimeSetup()
		try {
			await switchProject(projectName)
		} catch (error) {
			handleError(error)
		}
	})

switchCommand
	.argument('[workspace-name]', 'Name of the workspace to switch to')
	.option('--no-shell', "Don't open interactive shell, just print path")
	.option('-f, --force', 'Jump to first fuzzy match without confirmation')
	.action(async (workspaceName, options) => {
		await checkFirstTimeSetup()
		try {
			await switchWorkspace(workspaceName, options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// List Commands
// ============================================================================

const listCommand = program
	.command('list')
	.alias('ls')
	.description('List projects or workspaces')

listCommand
	.command('projects')
	.description('List all projects')
	.option('--json', 'Output in JSON format')
	.option('--verbose', 'Show additional details')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await listProjects(options)
		} catch (error) {
			handleError(error)
		}
	})

listCommand
	.command('workspaces')
	.description('List workspaces in current project')
	.option('--json', 'Output in JSON format')
	.option('--verbose', 'Show additional details')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await listWorkspaces(options)
		} catch (error) {
			handleError(error)
		}
	})

// Default list command (alias for list workspaces)
listCommand.action(async (options) => {
	await checkFirstTimeSetup()
	try {
		await listWorkspaces(options)
	} catch (error) {
		handleError(error)
	}
})

// ============================================================================
// Remove Commands
// ============================================================================

const removeCommand = program
	.command('remove')
	.alias('rm')
	.description('Remove a workspace or project')

removeCommand
	.command('workspace')
	.description('Remove a workspace')
	.argument('[workspace-name]', 'Name of the workspace to remove')
	.option('--force', 'Skip confirmation prompts')
	.option('--keep-branch', "Don't delete git branch when removing workspace")
	.action(async (workspaceName, options) => {
		await checkFirstTimeSetup()
		try {
			await removeWorkspace(workspaceName, options)
		} catch (error) {
			handleError(error)
		}
	})

removeCommand
	.command('project')
	.description('Remove a project')
	.argument('[project-name]', 'Name of the project to remove')
	.option('--force', 'Skip confirmation prompts')
	.action(async (projectName, options) => {
		await checkFirstTimeSetup()
		try {
			await removeProject(projectName, options)
		} catch (error) {
			handleError(error)
		}
	})

// Default remove command (alias for remove workspace)
removeCommand.action(async (options) => {
	await checkFirstTimeSetup()
	try {
		await removeWorkspace(undefined, options)
	} catch (error) {
		handleError(error)
	}
})

// ============================================================================
// Directory Commands
// ============================================================================

const directoryCommand = program
	.command('directory')
	.alias('dir')
	.description('Manage directories')

directoryCommand.action(async (options) => {
	await checkFirstTimeSetup()
	try {
		await getProjectDirectory(options)
	} catch (error) {
		handleError(error)
	}
})

// ============================================================================
// Identity Commands
// ============================================================================

const identityCommand = program
	.command('identity')
	.description('Manage machine identity for secure remote connections')

identityCommand
	.command('init')
	.description('Initialize a new identity keypair')
	.option('--force', 'Overwrite existing identity')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await initIdentity(options)
		} catch (error) {
			handleError(error)
		}
	})

identityCommand
	.command('show')
	.description('Show identity information')
	.option('--fingerprint', 'Show only fingerprint')
	.option('--json', 'Output in JSON format')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await showIdentity(options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Access Commands
// ============================================================================

const accessCommand = program
	.command('access')
	.description('Manage access control for remote connections')

accessCommand
	.command('add')
	.description('Add a new access key (grants full access)')
	.argument('<pubkey>', 'Public key (gssh-pub:SIGNING:KEYEXCHANGE or just SIGNING)')
	.option('--label <name>', 'Human-readable label for this key')
	.action(async (pubkey, options) => {
		await checkFirstTimeSetup()
		try {
			await addAccessKey(pubkey, options)
		} catch (error) {
			handleError(error)
		}
	})

accessCommand
	.command('list')
	.alias('ls')
	.description('List all access keys')
	.option('--json', 'Output in JSON format')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await listAccessKeys(options)
		} catch (error) {
			handleError(error)
		}
	})

accessCommand
	.command('remove')
	.alias('rm')
	.description('Remove an access key')
	.argument('<pubkey|label>', 'Public key, identity ID prefix, or label')
	.option('--force', 'Skip confirmation prompt')
	.action(async (pubkeyOrLabel, options) => {
		await checkFirstTimeSetup()
		try {
			await removeAccessKey(pubkeyOrLabel, options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Share Commands
// ============================================================================

const shareCommand = program
	.command('share')
	.description('Share workspace access via invite tokens')

shareCommand
	.command('create')
	.description('Create a share invite token (view-only session access)')
	.option('--expires <duration>', 'Token validity duration (e.g., 1h, 24h, 7d, 1w)', '24h')
	.option('--session <id>', 'Specific session ID to share (defaults to current session)')
	.option('--relay <url>', 'Relay server URL', 'wss://relay.gitspace.sh')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await createShare(options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Connect Command
// ============================================================================

program
	.command('connect')
	.description('Connect to a remote machine via invite token')
	.argument('[invite]', 'Invite token or URL (https://gitspace.sh/join#...)')
	.option('--relay <url>', 'Override relay URL from invite token')
	.action(async (invite, options) => {
		await checkFirstTimeSetup()
		try {
			await connectToRemote(invite, options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Serve Command
// ============================================================================

const serveCommand = program
	.command('serve')
	.description('Manage remote access daemon')

serveCommand
	.command('start')
	.description('Start the serve daemon')
	.option('--relay <url>', 'Override default relay URL')
	.option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
	.option('--ignore-keychain-and-skip-secrets', 'Skip keychain preload and skip secret-dependent scripts')
	.option('--password-stdin', 'Read password from stdin')
	.option('--foreground', 'Run in foreground (don\'t daemonize)')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await serveStart(options)
		} catch (error) {
			handleError(error)
		}
	})

serveCommand
	.command('stop')
	.description('Stop the serve daemon')
	.action(async () => {
		try {
			await serveStop()
		} catch (error) {
			handleError(error)
		}
	})

serveCommand
	.command('status')
	.description('Show serve daemon status')
	.action(async () => {
		try {
			await serveStatus()
		} catch (error) {
			handleError(error)
		}
	})

// Default action for 'gssh serve' (backwards compatibility - same as start)
serveCommand
	.option('--relay <url>', 'Override default relay URL')
	.option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
	.option('--ignore-keychain-and-skip-secrets', 'Skip keychain preload and skip secret-dependent scripts')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			// Default to interactive (non-daemon) mode for backwards compatibility
			await serve(options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Relay Commands
// ============================================================================

const relayCommand = program
	.command('relay')
	.description('Manage relay server')

relayCommand
	.command('start')
	.description('Start the relay server')
	.option('--port <port>', 'Port to listen on', '4480')
	.option('--bind <address>', 'Address to bind to', '0.0.0.0')
	.option('--hostname <host>', 'Only serve requests for this domain (optional)')
	.option('--label <label>', 'Human-readable label for this relay')
	.action(async (options) => {
		try {
			await startRelay({
				port: parseInt(options.port, 10),
				bind: options.bind,
				hostname: options.hostname,
				label: options.label,
			})
		} catch (error) {
			handleError(error)
		}
	})

relayCommand
	.command('authorize')
	.description('Authorize a machine to connect to this relay')
	.argument('<pubkey>', 'Machine public key in gssh-pub:SIGNING:KEYEXCHANGE format')
	.option('--label <label>', 'Human-readable label for this machine')
	.action(async (pubkey, options) => {
		try {
			await authorizeMachine(pubkey, { label: options.label })
		} catch (error) {
			handleError(error)
		}
	})

relayCommand
	.command('revoke')
	.description("Revoke a machine's authorization")
	.argument('<fingerprint-or-label>', 'Fingerprint or label of machine to revoke')
	.action(async (fingerprintOrLabel) => {
		try {
			await revokeMachine(fingerprintOrLabel)
		} catch (error) {
			handleError(error)
		}
	})

relayCommand
	.command('machines')
	.description('List authorized machines')
	.action(async () => {
		try {
			await listMachines()
		} catch (error) {
			handleError(error)
		}
	})

relayCommand
	.command('trusted')
	.description('List trusted relays (machine-side)')
	.action(async () => {
		try {
			await listTrustedRelays()
		} catch (error) {
			handleError(error)
		}
	})

relayCommand
	.command('untrust')
	.description('Remove trust for a relay (machine-side)')
	.argument('<url-or-fingerprint>', 'URL, fingerprint, or label of relay to untrust')
	.action(async (urlOrFingerprint) => {
		try {
			await untrustRelay(urlOrFingerprint)
		} catch (error) {
			handleError(error)
		}
	})


// ============================================================================
// Tmux Commands (tmux-lite daemon management)
// ============================================================================

const tmuxCommand = program
	.command('tmux')
	.description('Manage tmux-lite terminal session daemon')

tmuxCommand
	.command('start')
	.description('Start the tmux-lite server daemon')
	.action(async () => {
		try {
			await startTmux()
		} catch (error) {
			handleError(error)
		}
	})

tmuxCommand
	.command('stop')
	.description('Stop the tmux-lite server daemon')
	.option('--force', 'Stop even if sessions are active')
	.action(async (options) => {
		try {
			await stopTmux({ force: options.force })
		} catch (error) {
			handleError(error)
		}
	})

tmuxCommand
	.command('status')
	.description('Show tmux-lite server status')
	.action(async () => {
		try {
			await statusTmux()
		} catch (error) {
			handleError(error)
		}
	})

tmuxCommand
	.command('list')
	.description('List active tmux-lite sessions')
	.action(async () => {
		try {
			await listTmux()
		} catch (error) {
			handleError(error)
		}
	})

tmuxCommand
	.command('new [name]')
	.description('Create and attach to a new session')
	.action(async (name) => {
		try {
			await newTmux(name)
		} catch (error) {
			handleError(error)
		}
	})

tmuxCommand
	.command('attach <id>')
	.description('Attach to a session (by id or name)')
	.option('--force', 'Take over if attached elsewhere')
	.action(async (id, options) => {
		try {
			await attachTmux(id, { force: options.force })
		} catch (error) {
			handleError(error)
		}
	})

tmuxCommand
	.command('kill <id>')
	.description('Kill a session (by id or name)')
	.action(async (id) => {
		try {
			await killTmux(id)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Config Commands
// ============================================================================

const configCommand = program
	.command('config')
	.description('Configure gitspace settings')

// gssh config notifications
configCommand
	.command('notifications')
	.description('Configure notification settings')
	.option('--show', 'Show current settings')
	.option('--reset', 'Reset to defaults')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await configNotifications(options)
		} catch (error) {
			handleError(error)
		}
	})

// gssh config linear
const configLinearCommand = configCommand
	.command('linear')
	.description('Configure Linear integration')

configLinearCommand
	.command('setup')
	.description('Configure Linear integration')
	.option('--project <name>', 'Configure for specific project (uses user API key)')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await linearSetup(options)
		} catch (error) {
			handleError(error)
		}
	})

configLinearCommand
	.command('show')
	.description('Show Linear configuration')
	.option('--project <name>', 'Show project-specific configuration')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await linearShow(options)
		} catch (error) {
			handleError(error)
		}
	})

configLinearCommand
	.command('clear')
	.description('Clear Linear configuration')
	.option('--global', 'Clear user-level configuration')
	.option('--project <name>', 'Clear project-specific configuration')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await linearClear(options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Migration Commands
// ============================================================================

const migrateCommand = program
	.command('migrate')
	.description('Migration and cleanup utilities')

migrateCommand
	.command('cleanup-legacy')
	.description('Delete legacy keychain entries kept for backwards compatibility')
	.option('-y, --yes', 'Skip confirmation prompt')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await migrateCleanupLegacy(options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Notifications Commands
// ============================================================================

const notificationsCommand = program
	.command('notifications')
	.alias('notify')
	.description('Manage notification settings and shell hooks')

notificationsCommand
	.command('install')
	.description('Install shell hooks for notification integration')
	.action(async () => {
		try {
			await notificationsInstall()
		} catch (error) {
			handleError(error)
		}
	})

notificationsCommand
	.command('uninstall')
	.description('Remove shell hooks from shell config files')
	.action(async () => {
		try {
			await notificationsUninstall()
		} catch (error) {
			handleError(error)
		}
	})

notificationsCommand
	.command('hook')
	.description('Print shell hook snippet for manual installation')
	.option('--shell <shell>', 'Shell type (bash, zsh, fish)')
	.action(async (options) => {
		try {
			await notificationsHook(options.shell)
		} catch (error) {
			handleError(error)
		}
	})

notificationsCommand
	.command('status')
	.description('Show notification settings and hook installation status')
	.action(async () => {
		try {
			await notificationsStatus()
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Bundle Commands
// ============================================================================

const bundleCommand = program
	.command('bundle')
	.description('Manage bundle configuration')

bundleCommand
	.command('refresh')
	.description('Re-run bundle onboarding (keeps previous values as defaults)')
	.option('--force', 'Force refresh even if no changes detected')
	.option('--project <name>', 'Specify project name')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await bundleRefresh(options)
		} catch (error) {
			handleError(error)
		}
	})

bundleCommand
	.command('status')
	.description('Show bundle status for current project')
	.option('--project <name>', 'Specify project name')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await bundleStatus(options)
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Review Commands
// ============================================================================

function withReviewSetup<T extends unknown[]>(
	handler: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
	return async (...args: T): Promise<void> => {
		await checkFirstTimeSetup()
		try {
			await handler(...args)
		} catch (error) {
			handleError(error)
		}
	}
}

function addReviewScopeOptions(command: Command): Command {
	return command
		.option('--workspace <name>', 'Workspace name')
		.option('--project <name>', 'Project name')
}

function registerReviewSubcommands(command: Command): void {
	addReviewScopeOptions(
		command
			.command('notes')
			.description('Print review threads as structured JSON (LLM-friendly)')
	)
		.option('--format <format>', 'Output format: json (default) or text')
		.action(withReviewSetup(async (options) => {
			await showReviewNotes(options)
		}))

	addReviewScopeOptions(
		command
			.command('import')
			.description('Import GitHub PR review comments as local threads')
	)
		.option('--pr <number>', 'PR number to import from', (v) => parseInt(v, 10))
		.action(withReviewSetup(async (options) => {
			await importReview(options)
		}))

	addReviewScopeOptions(
		command
			.command('push')
			.description('Push local review decisions to GitHub as a formal PR review')
	)
		.option('--pr <number>', 'PR number to submit review on', (v) => parseInt(v, 10))
		.action(withReviewSetup(async (options) => {
			await pushReview(options)
		}))

	addReviewScopeOptions(
		command
			.command('hunks <file>')
			.description('List hunks in a changed file (AI-friendly target IDs)')
	)
		.option('--format <format>', 'Output format: json (default) or text')
		.action(withReviewSetup(async (file, options) => {
			await listReviewHunks(file, options)
		}))

	addReviewScopeOptions(
		command
			.command('add-hunk <file>')
			.description('Add or update hunk review by hunk index')
	)
		.requiredOption('--index <number>', '1-based hunk index', (v) => parseInt(v, 10))
		.option('--body <text>', 'Optional comment body')
		.option('--approve', 'Set hunk decision to approved')
		.option('--reject', 'Set hunk decision to rejected')
		.option('--pending', 'Set hunk decision to pending')
		.option('--json', 'Output structured JSON')
		.action(withReviewSetup(async (file, options) => {
			await addHunkReview(file, options)
		}))

	addReviewScopeOptions(
		command
			.command('add-file <file>')
			.description('Add a file-level review thread')
	)
		.requiredOption('--body <text>', 'Comment body')
		.option('--json', 'Output structured JSON')
		.action(withReviewSetup(async (file, options) => {
			await addFileReview(file, options)
		}))

	addReviewScopeOptions(
		command
			.command('add-line <file>')
			.description('Add a line-range review thread')
	)
		.requiredOption('--start <number>', '1-based start line', (v) => parseInt(v, 10))
		.option('--end <number>', '1-based end line (defaults to start)', (v) => parseInt(v, 10))
		.option('--side <side>', 'LEFT or RIGHT side of diff (default: RIGHT)')
		.requiredOption('--body <text>', 'Comment body')
		.option('--json', 'Output structured JSON')
		.action(withReviewSetup(async (file, options) => {
			await addLineReview(file, options)
		}))
}

const reviewCommand = program
	.command('review')
	.description('Open or interact with the diff review system')
	.option('--workspace <name>', 'Workspace name')
	.option('--project <name>', 'Project name')
	.option('--port <number>', 'Port of the serve daemon (default: 4480)', (v) => parseInt(v, 10))
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await openReview(options)
		} catch (error) {
			handleError(error)
		}
	})

registerReviewSubcommands(reviewCommand)

// Hidden workspace-scoped command surface.
// Intended to be used from `space` shell function injected into workspace sessions.
const spaceCommand = program
	.command('space', { hidden: true })
	.description('Workspace-scoped commands')

spaceCommand
	.command('context')
	.description('Show resolved workspace context')
	.option('--workspace <name>', 'Workspace name')
	.option('--project <name>', 'Project name')
	.option('--json', 'Output structured JSON')
	.action(async (options) => {
		await checkFirstTimeSetup()
		try {
			await showSpaceContext(options)
		} catch (error) {
			handleError(error)
		}
	})

const spaceReviewCommand = spaceCommand
	.command('review')
	.description('Workspace review commands')

registerReviewSubcommands(spaceReviewCommand)

// ============================================================================
// Auth Commands (gitspace.sh)
// ============================================================================

const authCommand = program
	.command('auth')
	.description('Manage gitspace.sh authentication')

authCommand
	.command('login')
	.description('Login with GitHub')
	.action(async () => {
		await checkFirstTimeSetup()
		try {
			await authLogin()
		} catch (error) {
			handleError(error)
		}
	})

authCommand
	.command('logout')
	.description('Logout and clear credentials')
	.action(async () => {
		try {
			await authLogout()
		} catch (error) {
			handleError(error)
		}
	})

authCommand
	.command('status')
	.description('Show login status')
	.action(async () => {
		try {
			await authStatus()
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Host Commands (gitspace.sh hosting)
// ============================================================================

const hostCommand = program
	.command('host')
	.description('Manage gitspace.sh hosting')

hostCommand
	.command('reserve <subdomain>')
	.description('Reserve a subdomain (e.g., brad.gitspace.sh)')
	.action(async (subdomain) => {
		await checkFirstTimeSetup()
		try {
			await hostReserve(subdomain)
		} catch (error) {
			handleError(error)
		}
	})

hostCommand
	.command('release [subdomain]')
	.description('Release a subdomain')
	.action(async (subdomain) => {
		try {
			await hostRelease(subdomain)
		} catch (error) {
			handleError(error)
		}
	})

hostCommand
	.command('list')
	.alias('ls')
	.description('List your subdomains')
	.action(async () => {
		try {
			await hostList()
		} catch (error) {
			handleError(error)
		}
	})

hostCommand
	.command('set-primary <subdomain>')
	.description('Set primary subdomain for `gssh serve`')
	.action(async (subdomain) => {
		try {
			await hostSetPrimary(subdomain)
		} catch (error) {
			handleError(error)
		}
	})

hostCommand
	.command('status')
	.description('Show hosting status')
	.action(async () => {
		try {
			await hostStatus()
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Status Command (unified daemon status)
// ============================================================================

program
	.command('status')
	.description('Show status of all spaces daemons')
	.action(async () => {
		try {
			await showStatus()
		} catch (error) {
			handleError(error)
		}
	})

// ============================================================================
// Error Handling
// ============================================================================

function handleError(error: unknown): never {
	if (error instanceof SpacesError) {
		logger.error(error.message)
		process.exit(error.exitCode)
	}

	if (error instanceof Error) {
		logger.error(`Unexpected error: ${error.message}`)
		logger.debug(error.stack || '')
		process.exit(1)
	}

	logger.error('An unexpected error occurred')
	process.exit(1)
}

// ============================================================================
// Parse and Execute
// ============================================================================

// Handle uncaught errors
process.on('uncaughtException', (error) => {
	logger.error(`Uncaught exception: ${error.message}`)
	logger.debug(error.stack || '')
	process.exit(1)
})

process.on('unhandledRejection', (reason) => {
	logger.error(`Unhandled rejection: ${reason}`)
	process.exit(1)
})

function isWorkspaceScopedSession(): boolean {
	return process.env.GSSH_SESSION_MODE === 'workspace'
}

function isAllowedWorkspaceSessionCommand(args: string[]): boolean {
	if (args.length === 0) {
		return false
	}

	const first = args[0]
	if (!first) {
		return false
	}

	if (first === 'space') {
		return true
	}

	if (first === '--help' || first === '-h' || first === '--version' || first === '-V') {
		return true
	}

	if (first === 'help') {
		return true
	}

	return false
}

// Parse command line arguments
// Check for global relay options (TUI mode with relay)
const args = process.argv.slice(2)

if (isWorkspaceScopedSession() && !isAllowedWorkspaceSessionCommand(args)) {
	if (args.length === 0) {
		logger.error('Bare `gssh` is disabled inside a workspace session.')
	} else if (args[0] === 'tmux') {
		logger.error('tmux commands are disabled inside workspace sessions.')
	} else {
		logger.error('This command is disabled inside a workspace session.')
	}
	logger.log('Use `space ...` for workspace-scoped operations.')
	process.exit(1)
}

let relayUrlFromArgs: string | undefined
let ignoreKeychainAndSkipSecrets = false
let hasOnlyTuiOptions = true

for (let i = 0; i < args.length; i += 1) {
	const arg = args[i]
	if (arg === '--relay') {
		const value = args[i + 1]
		if (!value || value.startsWith('--')) {
			hasOnlyTuiOptions = false
			break
		}
		relayUrlFromArgs = value
		i += 1
		continue
	}

	if (arg === '--ignore-keychain-and-skip-secrets') {
		ignoreKeychainAndSkipSecrets = true
		continue
	}

	hasOnlyTuiOptions = false
	break
}

// If no args provided or only relay options, launch TUI
if (process.argv.length === 2 || hasOnlyTuiOptions) {
	// Build relay config if provided (auth now via challenge-response, not token)
	const relayConfig = relayUrlFromArgs ? {
		url: relayUrlFromArgs,
	} : undefined

	// Launch TUI
	checkFirstTimeSetup()
		.then(() => launchTUI(relayConfig, { ignoreKeychainAndSkipSecrets }))
		.catch((error) => {
			if (error instanceof SpacesError) {
				logger.error(error.message)
				process.exit(error.exitCode)
			}
			logger.error(`Failed to launch TUI: ${error instanceof Error ? error.message : 'Unknown error'}`)
			process.exit(1)
		})
} else {
	program.parse()
}
