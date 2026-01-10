/**
 * Linear API integration for issue management
 */

import { LinearClient, LinearError, type Issue } from '@linear/sdk'
import { SpacesError } from '../types/errors.js'
import { logger } from '../utils/logger.js'
import type { LinearIssue } from '../types/workspace.js'
import type { LinearTeamInfo } from '../types/config.js'
import { readGlobalConfig, readProjectConfig, getCurrentProject } from './config.js'
import { getSecret } from '../utils/secrets.js'

/** Key used to store Linear API key in keychain */
export const LINEAR_API_KEY_SECRET = 'linear-api-key'

/**
 * Singleton Linear client instance
 */
let clientInstance: LinearClient | null = null

/**
 * Get or create Linear client instance
 */
function getLinearClient(apiKey: string): LinearClient {
	if (!clientInstance) {
		clientInstance = new LinearClient({ apiKey })
	}
	return clientInstance
}

/**
 * Reset the Linear client (useful when API key changes)
 */
export function resetLinearClient(): void {
	clientInstance = null
}

/**
 * Custom error class for Linear API errors
 */
export class LinearAPIError extends SpacesError {
	constructor(message: string, originalError?: unknown) {
		super(message, 'SERVICE_ERROR', 3)
		this.name = 'LinearAPIError'

		if (originalError) {
			logger.debug(`Linear API error: ${originalError}`)
		}
	}
}

/**
 * Retry a function with exponential backoff
 */
async function fetchWithRetry<T>(
	fetchFn: () => Promise<T>,
	maxRetries = 3
): Promise<T> {
	let lastError: unknown

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return await fetchFn()
		} catch (error: unknown) {
			lastError = error

			// Check if it's a retryable error (429 or 5xx)
			let shouldRetry = false
			let statusCode: number | undefined

			if (error instanceof LinearError) {
				// @ts-ignore - response may or may not have status
				statusCode = error.response?.status
			}

			if (statusCode === 429 || (statusCode && statusCode >= 500)) {
				shouldRetry = true
			}

			if (shouldRetry && attempt < maxRetries - 1) {
				// Exponential backoff: 200ms, 400ms, 800ms
				const delay = 200 * Math.pow(2, attempt)
				await new Promise((resolve) => setTimeout(resolve, delay))
				continue
			}

			throw error
		}
	}

	throw lastError
}

/**
 * Fetch all pages from a paginated Linear SDK response
 */
async function fetchAllPages<T extends { id: string }>(initialPage: {
	nodes: T[]
	pageInfo: { hasNextPage: boolean }
	fetchNext?: () => Promise<{ nodes: T[]; pageInfo: { hasNextPage: boolean } }>
}): Promise<T[]> {
	const allItems: T[] = []
	const seenIds = new Set<string>()
	let currentPage = initialPage

	while (true) {
		// Add unique items
		for (const item of currentPage.nodes) {
			if (!seenIds.has(item.id)) {
				seenIds.add(item.id)
				allItems.push(item)
			}
		}

		if (!currentPage.pageInfo.hasNextPage || !currentPage.fetchNext) {
			break
		}

		currentPage = await currentPage.fetchNext()
	}

	return allItems
}

/**
 * Fetch unstarted issues from Linear
 * @param apiKey Linear API key
 * @param teamKey Optional team key to filter by (e.g., "ENG")
 * @returns Array of unstarted issues
 */
export async function fetchUnstartedIssues(
	apiKey: string,
	teamKey?: string
): Promise<LinearIssue[]> {
	try {
		return await fetchWithRetry(async () => {
			const client = getLinearClient(apiKey)

			// Build filter for unstarted issues
			const filter = {
				state: { type: { eq: 'unstarted' } },
			}

			let linearIssues: Issue[]

			if (teamKey) {
				// Fetch team first
				const teamsConnection = await client.teams({
					filter: { key: { eq: teamKey } },
				})

				const team = teamsConnection.nodes[0]

				if (!team) {
					throw new LinearAPIError(`Team with key "${teamKey}" not found`)
				}

				// Fetch issues for the team
				const issuesConnection = await team.issues({ filter })
				linearIssues = await fetchAllPages(issuesConnection)
			} else {
				// Fetch all unstarted issues
				const issuesConnection = await client.issues({ filter })
				linearIssues = await fetchAllPages(issuesConnection)
			}

			const convertedIssues: LinearIssue[] = []
			for (let i = 0; i < linearIssues.length; i++) {
				const issue = linearIssues[i]

				// Create a lazy function for attachments (only fetched when called)
				const attachments = async () => {
					const attachmentsConnection = await issue.attachments()
					const linearAttachments = await fetchAllPages(attachmentsConnection)

					// Convert to our attachment format
					return linearAttachments.map((att) => ({
						id: att.id,
						url: att.url,
						title: att.title ?? null,
						sourceType: att.sourceType ?? null,
						createdAt: att.createdAt,
					}))
				}

				convertedIssues.push({
					id: issue.id,
					identifier: issue.identifier,
					title: issue.title,
					description: issue.description ?? null,
					state: issue.state,
					url: issue.url,
					assignee: issue.assignee,
					createdAt: issue.createdAt,
					updatedAt: issue.updatedAt,
					attachments,
				})
			}

			return convertedIssues
		})
	} catch (error) {
		if (error instanceof LinearAPIError) {
			throw error
		}

		if (error instanceof LinearError) {
			throw new LinearAPIError(`Linear API error: ${error.message}`, error)
		}

		throw new LinearAPIError(
			`Failed to fetch Linear issues: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			error
		)
	}
}

/**
 * Validate a Linear API key by fetching the viewer (authenticated user)
 */
export async function validateLinearApiKey(apiKey: string): Promise<boolean> {
	try {
		logger.debug('Validating Linear API key...')
		const testClient = new LinearClient({ apiKey })
		await testClient.viewer
		logger.debug('Linear API key validation successful')
		return true
	} catch (error) {
		logger.debug(
			`Linear API key validation failed: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`
		)
		return false
	}
}

/**
 * Fetch all teams accessible with the API key
 */
export async function fetchLinearTeams(apiKey: string): Promise<LinearTeamInfo[]> {
	try {
		return await fetchWithRetry(async () => {
			const client = getLinearClient(apiKey)
			const teamsConnection = await client.teams()
			const teams = await fetchAllPages(teamsConnection)

			return teams.map((team) => ({
				id: team.id,
				key: team.key,
				name: team.name,
			}))
		})
	} catch (error) {
		if (error instanceof LinearAPIError) {
			throw error
		}

		if (error instanceof LinearError) {
			throw new LinearAPIError(`Linear API error: ${error.message}`, error)
		}

		throw new LinearAPIError(
			`Failed to fetch Linear teams: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			error
		)
	}
}

/**
 * Resolved Linear configuration with API key and team info
 */
export interface ResolvedLinearConfig {
	/** API key from keychain (null if not configured) */
	apiKey: string | null
	/** Team keys to use (from project or user default) */
	teamKeys: string[]
	/** Full team info from user config */
	teams: LinearTeamInfo[]
	/** Whether config came from project or user level */
	scope: 'project' | 'user' | 'none'
}

/**
 * Get Linear configuration with project -> user fallback
 *
 * Resolution order:
 * 1. Project-level linearTeams (if set)
 * 2. User-level linearDefaultTeam (if set)
 * 3. First team in user's linearTeams
 *
 * API key always comes from user-level keychain.
 */
export async function getLinearConfig(projectName?: string): Promise<ResolvedLinearConfig> {
	const project = projectName || getCurrentProject()

	// Get API key from keychain (user-level)
	const apiKey = await getSecret(LINEAR_API_KEY_SECRET)

	// Get user-level config
	const globalConfig = readGlobalConfig()
	const userTeams = globalConfig.linearTeams || []
	const userDefaultTeam = globalConfig.linearDefaultTeam

	// If no API key or no teams, return empty config
	if (!apiKey || userTeams.length === 0) {
		return {
			apiKey,
			teamKeys: [],
			teams: userTeams,
			scope: 'none',
		}
	}

	// Check for project-level override
	if (project) {
		try {
			const projectConfig = readProjectConfig(project)

			// Handle legacy config (deprecated linearApiKey/linearTeamKey)
			if (projectConfig.linearApiKey || projectConfig.linearTeamKey) {
				// Legacy config exists - use linearTeamKey if set
				const legacyTeamKey = projectConfig.linearTeamKey
				if (legacyTeamKey) {
					return {
						apiKey,
						teamKeys: [legacyTeamKey],
						teams: userTeams,
						scope: 'project',
					}
				}
			}

			// New config - project-level team override
			if (projectConfig.linearTeams && projectConfig.linearTeams.length > 0) {
				return {
					apiKey,
					teamKeys: projectConfig.linearTeams,
					teams: userTeams,
					scope: 'project',
				}
			}
		} catch {
			// Project doesn't exist, fall through to user config
		}
	}

	// Fall back to user-level config
	const teamKeys = userDefaultTeam
		? [userDefaultTeam]
		: userTeams.length > 0
			? [userTeams[0].key]
			: []

	return {
		apiKey,
		teamKeys,
		teams: userTeams,
		scope: teamKeys.length > 0 ? 'user' : 'none',
	}
}

/**
 * Check if Linear is configured (has API key and at least one team)
 */
export async function isLinearConfigured(): Promise<boolean> {
	const config = await getLinearConfig()
	return config.apiKey !== null && config.teamKeys.length > 0
}
