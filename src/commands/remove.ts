/**
 * Remove command implementation
 * Handles 'gssh remove workspace' and 'gssh remove project'
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import {
	getCurrentProject,
	readProjectConfig,
	getProjectWorkspacesDir,
	getProjectDir,
	getAllProjectNames,
} from '../core/config.js'
import { getWorktreeInfo } from '../core/git.js'
import {
	deleteWorkspaceCore,
	deleteProjectCore,
} from '../core/workspace.js'
import { logger } from '../utils/logger.js'
import { selectItem, promptConfirm, promptInput } from '../utils/prompts.js'
import { SpacesError, NoProjectError } from '../types/errors.js'

/**
 * Remove a workspace (CLI command)
 * Handles interactive prompts and delegates to core deletion logic
 */
export async function removeWorkspace(
	workspaceNameArg?: string,
	options: {
		force?: boolean
		keepBranch?: boolean
	} = {}
): Promise<void> {
	const currentProject = getCurrentProject()
	if (!currentProject) {
		throw new NoProjectError()
	}

	const workspacesDir = getProjectWorkspacesDir(currentProject)

	if (!existsSync(workspacesDir)) {
		throw new SpacesError('No workspaces found', 'USER_ERROR', 1)
	}

	const workspaceNames = readdirSync(workspacesDir)

	if (workspaceNames.length === 0) {
		throw new SpacesError('No workspaces found', 'USER_ERROR', 1)
	}

	let workspaceName: string

	if (workspaceNameArg) {
		if (!workspaceNames.includes(workspaceNameArg)) {
			throw new SpacesError(
				`Workspace "${workspaceNameArg}" not found`,
				'USER_ERROR',
				1
			)
		}
		workspaceName = workspaceNameArg
	} else {
		// Select workspace
		const selected = await selectItem(
			workspaceNames,
			'Select workspace to remove:'
		)

		if (!selected) {
			logger.info('Cancelled')
			return
		}

		workspaceName = selected
	}

	const workspacePath = join(workspacesDir, workspaceName)

	// Get workspace info for display
	const info = await getWorktreeInfo(workspacePath)

	if (!info) {
		throw new SpacesError(
			`Could not get information for workspace "${workspaceName}"`,
			'SYSTEM_ERROR',
			2
		)
	}

	// Show git status
	logger.log(`\nWorkspace: ${workspaceName}`)
	logger.log(`Branch: ${info.branch}`)
	logger.log(`Uncommitted changes: ${info.uncommittedChanges}`)

	if (info.uncommittedChanges > 0) {
		logger.warning(
			`This workspace has ${info.uncommittedChanges} uncommitted changes`
		)
	}

	// Ask for confirmation unless --force
	if (!options.force) {
		const confirmed = await promptConfirm(
			`Remove workspace "${workspaceName}"?`,
			false
		)

		if (!confirmed) {
			logger.info('Cancelled')
			return
		}
	}

	// Delegate to core deletion logic (interactive mode for CLI)
	logger.info('Removing workspace...')
	const runDelete = async (scriptPolicy: 'enforce' | 'skip') => {
		return deleteWorkspaceCore(currentProject, workspaceName, {
			nonInteractive: false, // CLI is interactive
			keepBranch: options.keepBranch,
			removeScriptPolicy: scriptPolicy,
		})
	}

	let result = await runDelete('enforce')

	if (!result.success && result.errorCode === 'REMOVE_SCRIPT_FAILED') {
		logger.warning(result.error || 'Remove scripts failed')
		const removeAnyway = options.force
			? true
			: await promptConfirm(
				`Remove workspace "${workspaceName}" anyway and skip cleanup scripts?`,
				false
			)

		if (!removeAnyway) {
			logger.info('Cancelled')
			return
		}

		result = await runDelete('skip')
	}

	if (!result.success) {
		throw new SpacesError(
			result.error || 'Failed to remove workspace',
			'SYSTEM_ERROR',
			2
		)
	}

	logger.success(`Removed worktree: ${workspaceName}`)

	if (result.sessionsKilled > 0) {
		logger.info(`Killed ${result.sessionsKilled} active session(s)`)
	}

	if (result.branchDeleted) {
		logger.success(`Deleted branch: ${result.branch}`)
	} else if (result.branch && !options.keepBranch) {
		logger.warning(`Could not delete branch: ${result.branch}`)
	}
}

/**
 * Remove a project (CLI command)
 * Handles interactive prompts and delegates to core deletion logic
 */
export async function removeProject(
	projectNameArg?: string,
	options: {
		force?: boolean
	} = {}
): Promise<void> {
	const allProjects = getAllProjectNames()

	if (allProjects.length === 0) {
		throw new SpacesError('No projects found', 'USER_ERROR', 1)
	}

	let projectName: string

	if (projectNameArg) {
		if (!allProjects.includes(projectNameArg)) {
			throw new SpacesError(
				`Project "${projectNameArg}" not found`,
				'USER_ERROR',
				1
			)
		}
		projectName = projectNameArg
	} else {
		// Select project
		const projectOptions = allProjects.map((name) => {
			const config = readProjectConfig(name)
			return `${name} - ${config.repository}`
		})

		const selected = await selectItem(
			projectOptions,
			'Select project to remove:'
		)

		if (!selected) {
			logger.info('Cancelled')
			return
		}

		projectName = selected.split(' - ')[0]
	}

	const projectDir = getProjectDir(projectName)
	const workspacesDir = getProjectWorkspacesDir(projectName)

	// List workspaces
	let workspaceCount = 0
	if (existsSync(workspacesDir)) {
		workspaceCount = readdirSync(workspacesDir).length
	}

	logger.warning(
		`\nThis will permanently delete project "${projectName}" and all its data:`
	)
	logger.log(`  - Project directory: ${projectDir}`)
	logger.log(`  - Workspaces: ${workspaceCount}`)

	// Ask for confirmation - require typing project name unless --force
	if (!options.force) {
		const confirmName = await promptInput(
			`Type the project name "${projectName}" to confirm:`
		)

		if (confirmName !== projectName) {
			logger.info('Cancelled (name mismatch)')
			return
		}
	}

	// Delegate to core deletion logic (interactive mode for CLI)
	logger.info('Removing project...')
	const result = await deleteProjectCore(projectName, {
		nonInteractive: false, // CLI is interactive
	})

	if (!result.success) {
		if (result.errors.length > 0) {
			for (const error of result.errors) {
				logger.warning(`  ${error}`)
			}
		}
		throw new SpacesError(
			'Failed to remove project completely',
			'SYSTEM_ERROR',
			2
		)
	}

	// Log any partial errors that occurred during cleanup (even on success)
	if (result.errors.length > 0) {
		logger.warning('Some cleanup operations had issues:')
		for (const error of result.errors) {
			logger.warning(`  ${error}`)
		}
	}

	logger.success(`Removed project: ${projectName}`)

	if (result.sessionsKilled > 0) {
		logger.info(`Killed ${result.sessionsKilled} active session(s)`)
	}

	if (result.workspacesDeleted > 0) {
		logger.info(`Cleaned up ${result.workspacesDeleted} workspace(s)`)
	}

	if (result.wasCurrentProject) {
		logger.info('Cleared current project (was this project)')
	}
}
