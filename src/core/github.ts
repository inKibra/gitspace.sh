/**
 * GitHub repository operations using gh CLI
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { SpacesError } from '../types/errors.js'
import { logger } from '../utils/logger.js'

const execAsync = promisify(exec)

/**
 * Get current GitHub user login
 */
async function getCurrentUser(): Promise<string> {
	try {
		const { stdout } = await execAsync('gh api user --jq .login')
		return stdout.trim()
	} catch (error) {
		throw new SpacesError(
			`Failed to get GitHub user: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SERVICE_ERROR',
			3
		)
	}
}

/**
 * Get all organizations the user belongs to
 */
async function getUserOrgs(): Promise<string[]> {
	try {
		const { stdout } = await execAsync(
			'gh api user/orgs --paginate --jq ".[].login"'
		)
		const orgs = stdout
			.trim()
			.split('\n')
			.filter((org) => org.length > 0)
		return orgs
	} catch (error) {
		// If no orgs, that's okay
		return []
	}
}

/**
 * Get repositories for a specific owner (user or org)
 */
async function getReposForOwner(
	owner: string,
	limit: number = 1000
): Promise<string[]> {
	try {
		const { stdout } = await execAsync(
			`gh repo list "${owner}" --limit ${limit} --json 'name,owner' | jq -r '.[] | "\\(.owner.login)/\\(.name)"'`
		)

		const repos = stdout
			.trim()
			.split('\n')
			.filter((repo) => repo.length > 0)

		return repos
	} catch (error) {
		logger.debug(
			`Failed to get repos for ${owner}: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`
		)
		return []
	}
}

/**
 * List all accessible GitHub repositories
 */
export async function listAllRepos(orgFilter?: string): Promise<string[]> {
	try {
		const allRepos: string[] = []

		if (orgFilter) {
			// Only fetch repos for the specified org
			const repos = await getReposForOwner(orgFilter)
			allRepos.push(...repos)
		} else {
			// Get current user
			const currentUser = await getCurrentUser()

			// Get user's repos
			const userRepos = await getReposForOwner(currentUser)
			allRepos.push(...userRepos)

			// Get orgs and their repos
			const orgs = await getUserOrgs()
			for (const org of orgs) {
				const orgRepos = await getReposForOwner(org)
				allRepos.push(...orgRepos)
			}
		}

		// Remove duplicates and sort
		const uniqueRepos = Array.from(new Set(allRepos))
		uniqueRepos.sort()

		return uniqueRepos
	} catch (error) {
		if (error instanceof SpacesError) {
			throw error
		}

		throw new SpacesError(
			`Failed to list GitHub repositories: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SERVICE_ERROR',
			3
		)
	}
}

/**
 * Clone a repository
 */
export async function cloneRepository(
	repository: string,
	destination: string
): Promise<void> {
	try {
		logger.debug(`Cloning ${repository} to ${destination}`)

		const { stdout, stderr } = await execAsync(
			`gh repo clone ${repository} "${destination}"`
		)

		logger.debug(stdout)
		if (stderr) {
			logger.debug(stderr)
		}
	} catch (error) {
		throw new SpacesError(
			`Failed to clone repository ${repository}: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		)
	}
}
