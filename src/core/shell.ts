/**
 * Shell session management - spawns subshells for workspaces
 * Uses tmux-lite for session persistence and management
 */

import { spawn, spawnSync } from 'child_process'
import { logger } from '../utils/logger.js'
import { prepareWorkspaceForSession } from './workspace-lifecycle.js'
import {
	createSession,
	isNested,
} from '../lib/tmux-lite/cli.js'

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
 * @param sessionName - Custom name for the tmux-lite session (required for new sessions)
 */
export async function openWorkspaceShell(
	workspacePath: string,
	projectName: string,
	repository: string,
	noSetup: boolean = false,
	sessionName?: string
): Promise<void> {
	const workspaceName = workspacePath.split('/').pop() || 'workspace'

	const prepareResult = await prepareWorkspaceForSession({
		projectName,
		workspacePath,
		workspaceName,
		repository,
		noSetup,
		interactiveScripts: true,
		bundleMode: 'prompt-refresh',
	})

	if (!prepareResult.success) {
		throw new Error(`Workspace scripts failed during ${prepareResult.phase} phase: ${prepareResult.error}`)
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
 * @param sessionName - Custom suffix for the session name
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
		const suffix = sessionName && sessionName.trim().length > 0
			? sessionName
			: `${Date.now()}`
		const fullSessionName = buildSessionName(projectName, workspaceName, suffix)

		logger.debug(`Creating tmux-lite session: ${fullSessionName}`)

		// Create new session
		const session = await createSession(fullSessionName, workspacePath)

		// Spawn the CLI attach command as a subprocess with inherited stdio
		// This works better with TUI suspension than direct attach() call
		const cliPath = new URL('../lib/tmux-lite/cli.ts', import.meta.url).pathname
		const proc = spawn('bun', ['run', cliPath, 'attach', session.id, '-f'], {
			stdio: 'inherit',
			cwd: workspacePath,
		})

		await new Promise<void>((resolve, reject) => {
			proc.on('exit', () => resolve())
			proc.on('error', (err) => reject(err))
		})
	} catch (error) {
		logger.error(`Failed to open tmux-lite session: ${(error as Error).message}`)
		throw error
	}
}
