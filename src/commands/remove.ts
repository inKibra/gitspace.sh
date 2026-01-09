/**
 * Remove command implementation
 * Handles 'gssh remove workspace' and 'gssh remove project'
 */

import { existsSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import {
	getCurrentProject,
	readProjectConfig,
	getProjectWorkspacesDir,
	getProjectBaseDir,
	getProjectDir,
	readGlobalConfig,
	updateGlobalConfig,
	getAllProjectNames,
	getScriptsPhaseDir,
} from '../core/config.js'
import {
	removeWorktree,
	deleteLocalBranch,
	getWorktreeInfo,
} from '../core/git.js'
import { logger } from '../utils/logger.js'
import { selectItem, promptConfirm, promptInput } from '../utils/prompts.js'
import { SpacesError, NoProjectError } from '../types/errors.js'
import { runScriptsInTerminal } from '../utils/run-scripts.js'

/**
 * Remove a workspace
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
	const baseDir = getProjectBaseDir(currentProject)

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

	// Get workspace info
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

	// Run remove scripts (cleanup before deletion)
	const projectConfig = readProjectConfig(currentProject)
	const removeScriptsDir = getScriptsPhaseDir(currentProject, 'remove')
	await runScriptsInTerminal(
		removeScriptsDir,
		workspacePath,
		workspaceName,
		projectConfig.repository
	)

	// Remove worktree
	logger.info('Removing worktree...')
	await removeWorktree(baseDir, workspacePath, true)

	logger.success(`Removed worktree: ${workspaceName}`)

	// Ask about deleting local branch unless --keep-branch
	if (!options.keepBranch) {
		// const deleteBranch = await promptConfirm(`Delete local branch "${info.branch}"?`, false);
		const deleteBranch = true

		if (deleteBranch) {
			try {
				await deleteLocalBranch(baseDir, info.branch, true)
				logger.success(`Deleted branch: ${info.branch}`)
			} catch (error) {
				logger.warning(
					`Could not delete branch: ${
						error instanceof Error ? error.message : 'Unknown error'
					}`
				)
			}
		}
	}
}

/**
 * Remove a project
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

	// Remove entire project directory
	logger.info('Removing project directory...')
	rmSync(projectDir, { recursive: true, force: true })

	logger.success(`Removed project: ${projectName}`)

	// Update global config if this was the current project
	const globalConfig = readGlobalConfig()
	if (globalConfig.currentProject === projectName) {
		updateGlobalConfig({ currentProject: null })
		logger.info('Cleared current project (was this project)')
	}
}
