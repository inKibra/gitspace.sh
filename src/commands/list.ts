/**
 * List command implementation
 * Handles 'gssh list' (workspaces), 'gssh list projects', and 'gssh list workspaces'
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import {
	getAllProjectNames,
	readProjectConfig,
	getCurrentProject,
	getProjectWorkspacesDir,
	readGlobalConfig,
} from '../core/config.js'
import { getWorktreeInfo } from '../core/git.js'
import { logger } from '../utils/logger.js'
import { SpacesError, NoProjectError } from '../types/errors.js'
import type { ProjectInfo, WorktreeInfo } from '../types/workspace.js'

/**
 * List all projects
 */
export async function listProjects(
	options: {
		json?: boolean
		verbose?: boolean
	} = {}
): Promise<void> {
	const projectNames = getAllProjectNames()

	if (projectNames.length === 0) {
		logger.info('No projects found')
		logger.log('\nCreate a project:\n  gssh add project')
		return
	}

	const currentProject = getCurrentProject()
	const projects: ProjectInfo[] = []

	for (const name of projectNames) {
		const config = readProjectConfig(name)
		const workspacesDir = getProjectWorkspacesDir(name)

		let workspaceCount = 0
		if (existsSync(workspacesDir)) {
			workspaceCount = readdirSync(workspacesDir).length
		}

		projects.push({
			name,
			repository: config.repository,
			path: workspacesDir,
			workspaceCount,
			isCurrent: name === currentProject,
		})
	}

	if (options.json) {
		console.log(JSON.stringify(projects, null, 2))
		return
	}

	logger.bold('Projects:')

	for (const project of projects) {
		const indicator = project.isCurrent ? ' *' : '  '
		const currentLabel = project.isCurrent ? ' (current)' : ''

		if (options.verbose) {
			logger.log(
				`${indicator} ${project.name.padEnd(20)} ${project.repository.padEnd(
					30
				)} ${project.workspaceCount} workspaces${currentLabel}`
			)
		} else {
			logger.log(
				`${indicator} ${project.name.padEnd(20)} ${
					project.repository
				}${currentLabel}`
			)
		}
	}
}

/**
 * Calculate days since last commit
 */
function daysSinceCommit(date: Date): number {
	const now = new Date()
	const diff = now.getTime() - date.getTime()
	return Math.floor(diff / (1000 * 60 * 60 * 24))
}

/**
 * List workspaces in the current project
 */
export async function listWorkspaces(
	options: {
		json?: boolean
		verbose?: boolean
	} = {}
): Promise<void> {
	const currentProject = getCurrentProject()
	if (!currentProject) {
		throw new NoProjectError()
	}

	const workspacesDir = getProjectWorkspacesDir(currentProject)

	if (!existsSync(workspacesDir)) {
		logger.info(`No workspaces found in project "${currentProject}"`)
		logger.log('\nCreate a workspace:\n  gssh add')
		return
	}

	const workspaceNames = readdirSync(workspacesDir).filter((entry) => {
		const path = join(workspacesDir, entry)
		return existsSync(path)
	})

	if (workspaceNames.length === 0) {
		logger.info(`No workspaces found in project "${currentProject}"`)
		logger.log('\nCreate a workspace:\n  gssh add')
		return
	}

	// Get workspace info
	const workspaces: WorktreeInfo[] = []
	const globalConfig = readGlobalConfig()

	for (const name of workspaceNames) {
		const workspacePath = join(workspacesDir, name)
		const info = await getWorktreeInfo(workspacePath)

		if (info) {
			workspaces.push(info)
		}
	}

	if (options.json) {
		console.log(JSON.stringify(workspaces, null, 2))
		return
	}

	logger.bold(`Workspaces (${currentProject}):`)

	for (const workspace of workspaces) {
		const parts: string[] = []
		parts.push(addSpace(2)) // indent
		parts.push(truncateName(workspace.name, 40).padEnd(45)) // workspace name

		// Branch and ahead/behind
		if (workspace.ahead > 0 || workspace.behind > 0) {
			parts.push(`+${workspace.ahead} -${workspace.behind}`.padEnd(10))
		} else {
			parts.push('+0 -0'.padEnd(10))
		}

		// Uncommitted changes
		if (workspace.uncommittedChanges > 0) {
			parts.push(`${workspace.uncommittedChanges} uncommitted`.padEnd(20))
		} else {
			parts.push('clean'.padEnd(20))
		}

		// Stale workspace warning
		const daysSince = daysSinceCommit(workspace.lastCommitDate)
		if (daysSince > globalConfig.staleDays) {
			parts.push(`[stale: ${daysSince} days]`)
		}

		logger.log(parts.join(' '))

		// Verbose mode: show last commit
		if (options.verbose) {
			logger.dim(`    Last commit: ${workspace.lastCommit}`)
			logger.dim(`    Date: ${workspace.lastCommitDate.toLocaleDateString()}\n`)
		}
	}
}

function truncateName(
	name: string,
	maxLength: number,
	includeEllipsis = true
): string {
	if (name.length <= maxLength) {
		return name
	}

	if (includeEllipsis) {
		return name.substring(0, maxLength - 3) + '...'
	}

	return name.substring(0, maxLength)
}

function addSpace(size: number): string {
	return ' '.repeat(size)
}
