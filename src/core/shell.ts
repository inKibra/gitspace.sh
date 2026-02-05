/**
 * Shell session management - spawns subshells for workspaces
 * Uses tmux-lite for session persistence and management
 */

import { spawn, spawnSync } from 'child_process'
import { logger } from '../utils/logger.js'
import { hasSetupBeenRun, markSetupComplete } from '../utils/workspace-state.js'
import { runScriptsInTerminal, type RunScriptsOptions } from '../utils/run-scripts.js'
import { getScriptsPhaseDir, readProjectConfig } from './config.js'
import { getProjectSecrets } from '../utils/secrets.js'
import {
	listSessions,
	createSession,
	isNested,
	type Session,
} from '../lib/tmux-lite/cli.js'
import { autostartProcesses, getProcessSpecs, startProcessScheduler } from '../lib/processes/index.js'

/**
 * Print a message to terminal using echo (same mechanism as scripts)
 */
function printToTerminal(message: string): void {
	spawnSync('echo', [message], { stdio: 'inherit' })
}

/**
 * Open a workspace in an interactive subshell
 *
 * Flow:
 * 1. Determine if setup or select scripts should run
 * 2. Run the appropriate scripts in the terminal
 * 3. Spawn an interactive subshell in the workspace directory
 * 4. User gets control of the shell with their environment ready
 *
 * @param selectOnly - If true, only run select scripts (skip setup check). Used by TUI which handles setup during creation.
 * @param sessionName - Custom name for the tmux-lite session (required for new sessions)
 */
export async function openWorkspaceShell(
	workspacePath: string,
	projectName: string,
	repository: string,
	noSetup: boolean = false,
	selectOnly: boolean = false,
	sessionName?: string
): Promise<void> {
	const workspaceName = workspacePath.split('/').pop() || 'workspace'

	// Build script options with bundle values and secrets
	const projectConfig = readProjectConfig(projectName)
	const scriptOptions: RunScriptsOptions = {
		bundleValues: projectConfig.bundleValues,
	}

	// Fetch secrets from OS keychain if we have secret keys
	if (projectConfig.bundleSecretKeys && projectConfig.bundleSecretKeys.length > 0) {
		scriptOptions.bundleSecrets = await getProjectSecrets(projectName, projectConfig.bundleSecretKeys)
	}

	if (selectOnly) {
		// TUI mode: setup was done during creation, just run select scripts
		const selectScriptsDir = getScriptsPhaseDir(projectName, 'select')
		await runScriptsInTerminal(
			selectScriptsDir,
			workspacePath,
			workspaceName,
			repository,
			scriptOptions
		)
	} else {
		const setupAlreadyRun = hasSetupBeenRun(workspacePath)

		// Determine which scripts to run based on setup status
		if (setupAlreadyRun) {
			// Setup has been run before, run select scripts
			const selectScriptsDir = getScriptsPhaseDir(projectName, 'select')
			await runScriptsInTerminal(
				selectScriptsDir,
				workspacePath,
				workspaceName,
				repository,
				scriptOptions
			)
		} else if (!noSetup) {
			// First time setup, run setup scripts
			printToTerminal('Running setup scripts (first time)...')
			const setupScriptsDir = getScriptsPhaseDir(projectName, 'setup')
			await runScriptsInTerminal(
				setupScriptsDir,
				workspacePath,
				workspaceName,
				repository,
				scriptOptions
			)

			// Mark setup as complete
			markSetupComplete(workspacePath)
			printToTerminal('✓ Setup complete')
		}
	}

	printToTerminal('')
	printToTerminal('💡 Press Ctrl+Esc to detach and return to GitSpace TUI')
	printToTerminal('')

	// Create or attach to tmux-lite session
	await openTmuxLiteSession(workspacePath, projectName, workspaceName, sessionName)
}

/**
 * Build a full session name from components
 */
function buildSessionName(projectName: string, workspaceName: string, sessionName: string): string {
	return `${projectName}:${workspaceName}:${sessionName}`
}

/**
 * Open a tmux-lite session for the workspace
 * Creates a new session or attaches to an existing one
 * @param sessionName - Custom name for the session (required)
 */
async function openTmuxLiteSession(
	workspacePath: string,
	projectName: string,
	workspaceName: string,
	sessionName?: string
): Promise<void> {
	// Check if we're already in a tmux-lite session
	if (isNested()) {
		logger.error('Already inside a tmux-lite session. Detach first with Ctrl+Esc.')
		return
	}

	try {
		// Build the full session name
		if (!sessionName) {
			throw new Error('Session name is required')
		}
		const fullSessionName = buildSessionName(projectName, workspaceName, sessionName)

		logger.debug(`Creating tmux-lite session: ${fullSessionName}`)

		// Create new session
		const session = await createSession(fullSessionName, workspacePath)

		const specs = getProcessSpecs(workspacePath)
		await autostartProcesses(workspacePath, specs)

		// Spawn the CLI attach command as a subprocess with inherited stdio
		// This works better with TUI suspension than direct attach() call
		const cliPath = new URL('../lib/tmux-lite/cli.ts', import.meta.url).pathname
		const proc = spawn('bun', ['run', cliPath, 'attach', session.id, '-f'], {
			stdio: 'inherit',
			cwd: workspacePath,
		})

		const scheduler = startProcessScheduler(workspacePath)
		try {
			await new Promise<void>((resolve, reject) => {
				proc.on('exit', () => resolve())
				proc.on('error', (err) => reject(err))
			})
		} finally {
			clearInterval(scheduler)
		}
	} catch (error) {
		logger.error(`Failed to open tmux-lite session: ${(error as Error).message}`)
		throw error
	}
}
