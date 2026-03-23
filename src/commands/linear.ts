/**
 * Linear integration CLI commands
 *
 * Provides commands for configuring Linear integration at user and project levels.
 */

import { logger } from '../utils/logger.js'
import { SpacesError } from '../types/errors.js'
import {
	promptPassword,
	promptConfirm,
	selectMultiple,
	selectOne,
} from '../utils/prompts.js'
import {
	validateLinearApiKey,
	fetchLinearTeams,
	getLinearConfig,
	resetLinearClient,
	LINEAR_API_KEY_SECRET,
	getProjectLinearSecretKey,
} from '../core/linear.js'
import {
	readGlobalConfig,
	updateGlobalConfig,
	readProjectConfig,
	updateProjectConfig,
	projectExists,
} from '../core/config.js'
import { setSecret, getSecret, deleteSecret } from '../utils/secrets.js'
import type { LinearTeamInfo } from '../types/config.js'

// ============================================================================
// Types
// ============================================================================

export interface LinearSetupOptions {
	project?: string
}

export interface LinearShowOptions {
	project?: string
}

export interface LinearClearOptions {
	global?: boolean
	project?: string
}

/** Result of team selection */
interface TeamSelectionResult {
	selectedTeams: LinearTeamInfo[]
	defaultTeam: string
}

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Prompt for API key and validate it
 * @returns Valid API key or null if cancelled
 */
async function promptAndValidateApiKey(promptMessage: string): Promise<string | null> {
	const apiKey = await promptPassword(promptMessage)

	if (!apiKey) {
		logger.info('Cancelled')
		return null
	}

	logger.info('Validating API key...')
	const valid = await validateLinearApiKey(apiKey)

	if (!valid) {
		throw new SpacesError(
			'Invalid Linear API key. Get your API key from Linear → Settings → API → Personal API keys',
			'USER_ERROR',
			1
		)
	}

	logger.success('API key valid')
	return apiKey
}

/**
 * Select teams and choose a default team
 * @param availableTeams Teams to choose from
 * @param currentTeamKeys Currently selected team keys (for pre-checking)
 * @param message Prompt message
 * @returns Selected teams and default, or null if cancelled
 */
async function selectAndConfigureTeams(
	availableTeams: LinearTeamInfo[],
	currentTeamKeys?: Set<string>,
	message = 'Select teams you work with:'
): Promise<TeamSelectionResult | null> {
	const selectedTeams = await selectMultiple(
		availableTeams.map((t) => ({
			label: `${t.key} - ${t.name}`,
			value: t,
			checked: currentTeamKeys ? currentTeamKeys.has(t.key) : true,
		})),
		message
	)

	if (selectedTeams === null || selectedTeams.length === 0) {
		logger.info('Cancelled - at least one team is required')
		return null
	}

	// Determine default team
	let defaultTeam: string

	if (selectedTeams.length === 1) {
		defaultTeam = selectedTeams[0].key
	} else {
		const selected = await selectOne(
			selectedTeams.map((t) => ({
				label: `${t.key} - ${t.name}`,
				value: t.key,
			})),
			'Select your default team:'
		)

		if (selected === null) {
			logger.info('Cancelled')
			return null
		}

		defaultTeam = selected
	}

	return { selectedTeams, defaultTeam }
}

/**
 * Mask API key for display
 */
function maskApiKey(apiKey: string): string {
	if (apiKey.length <= 8) {
		return '●'.repeat(apiKey.length)
	}
	return '●'.repeat(apiKey.length - 4) + apiKey.slice(-4)
}

// ============================================================================
// Setup Command
// ============================================================================

/**
 * Run Linear setup wizard
 *
 * - Without --project: User-level setup (API key + teams)
 * - With --project: Project-level setup (team selection only, uses user API key)
 */
export async function linearSetup(options: LinearSetupOptions = {}): Promise<void> {
	const { project } = options

	if (project) {
		await setupProjectLinear(project)
	} else {
		await setupUserLinear()
	}
}

/**
 * User-level Linear setup wizard
 */
async function setupUserLinear(): Promise<void> {
	// Check if already configured
	const existingApiKey = await getSecret(LINEAR_API_KEY_SECRET)
	const globalConfig = readGlobalConfig()
	const existingTeams = globalConfig.linearTeams || []

	if (existingApiKey && existingTeams.length > 0) {
		// Already configured - show menu
		const maskedKey = maskApiKey(existingApiKey)
		const teamList = existingTeams.map((t) => t.key).join(', ')
		const defaultTeam = globalConfig.linearDefaultTeam || existingTeams[0]?.key

		logger.log('\nLinear is already configured:')
		logger.log(`  API key: ${maskedKey}`)
		logger.log(`  Teams: ${teamList} (default: ${defaultTeam})`)
		logger.log('')

		const action = await selectOne(
			[
				{ label: 'Update API key', value: 'api-key' },
				{ label: 'Modify teams', value: 'teams' },
				{ label: 'Cancel', value: 'cancel' },
			],
			'What would you like to do?'
		)

		if (action === null || action === 'cancel') {
			logger.info('Cancelled')
			return
		}

		if (action === 'api-key') {
			await updateApiKey()
		} else if (action === 'teams') {
			await updateTeams(existingApiKey)
		}

		return
	}

	// First-time setup
	logger.log('\n── Linear Integration Setup ──\n')

	// Step 1: API Key
	const apiKey = await promptAndValidateApiKey('Enter your Linear API key (from Settings → API):')
	if (!apiKey) return

	// Step 2: Fetch and select teams
	logger.info('Fetching teams...')
	const teams = await fetchLinearTeams(apiKey)

	if (teams.length === 0) {
		logger.warning('No teams found for this API key')
		// Save API key and reset client after saving
		await setSecret(LINEAR_API_KEY_SECRET, apiKey)
		resetLinearClient()
		updateGlobalConfig({ linearTeams: [], linearDefaultTeam: undefined })
		logger.success('\nLinear API key saved (no teams available)')
		return
	}

	const result = await selectAndConfigureTeams(teams)
	if (!result) return

	// Save configuration - reset client AFTER saving to keychain
	await setSecret(LINEAR_API_KEY_SECRET, apiKey)
	resetLinearClient()
	updateGlobalConfig({
		linearTeams: result.selectedTeams,
		linearDefaultTeam: result.defaultTeam,
	})

	const teamList = result.selectedTeams.map((t) => t.key).join(', ')
	logger.success(`\nLinear configured (teams: ${teamList}, default: ${result.defaultTeam})`)
	logger.log('\nProjects will inherit this config unless overridden.')
	logger.log("Run 'gssh user config linear setup --project <name>' to customize per-project.")
}

/**
 * Update API key (part of re-setup flow)
 */
async function updateApiKey(): Promise<void> {
	const apiKey = await promptAndValidateApiKey('Enter new Linear API key:')
	if (!apiKey) return

	// Save new key and reset client AFTER saving
	await setSecret(LINEAR_API_KEY_SECRET, apiKey)
	resetLinearClient()

	// Re-fetch teams with new key
	logger.info('Fetching teams with new API key...')
	const teams = await fetchLinearTeams(apiKey)

	if (teams.length === 0) {
		logger.warning('No teams found for this API key')
		updateGlobalConfig({ linearTeams: [], linearDefaultTeam: undefined })
		logger.success('\nLinear API key updated (no teams available)')
		return
	}

	const result = await selectAndConfigureTeams(teams)
	if (!result) {
		logger.info('Keeping existing team config')
		return
	}

	updateGlobalConfig({
		linearTeams: result.selectedTeams,
		linearDefaultTeam: result.defaultTeam,
	})

	logger.success('\nLinear API key and teams updated')
}

/**
 * Modify teams (part of re-setup flow)
 */
async function updateTeams(apiKey: string): Promise<void> {
	const globalConfig = readGlobalConfig()
	const currentTeamKeys = new Set((globalConfig.linearTeams || []).map((t) => t.key))
	const currentDefault = globalConfig.linearDefaultTeam

	logger.info('Fetching teams...')
	const teams = await fetchLinearTeams(apiKey)

	if (teams.length === 0) {
		logger.warning('No teams found for this API key')
		return
	}

	const result = await selectAndConfigureTeams(teams, currentTeamKeys)
	if (!result) return

	// Preserve current default if it's still in selection
	const selectedKeys = result.selectedTeams.map((t) => t.key)
	const defaultTeam = currentDefault && selectedKeys.includes(currentDefault)
		? currentDefault
		: result.defaultTeam

	updateGlobalConfig({
		linearTeams: result.selectedTeams,
		linearDefaultTeam: defaultTeam,
	})

	logger.success('\nLinear teams updated')
}

/**
 * Project-level Linear setup
 */
async function setupProjectLinear(projectName: string): Promise<void> {
	if (!projectExists(projectName)) {
		throw new SpacesError(`Project '${projectName}' not found`, 'USER_ERROR', 1)
	}

	// Check for existing project-level API key
	const projectSecretKey = getProjectLinearSecretKey(projectName)
	const existingProjectApiKey = await getSecret(projectSecretKey)

	// Check for user-level API key
	const userApiKey = await getSecret(LINEAR_API_KEY_SECRET)

	logger.log(`\n── Linear Setup (Project: ${projectName}) ──\n`)

	// If project already has its own API key, show menu
	if (existingProjectApiKey) {
		const maskedKey = maskApiKey(existingProjectApiKey)
		logger.log(`  Current API key: ${maskedKey} (project-specific)`)
		logger.log('')

		const action = await selectOne(
			[
				{ label: 'Update project API key', value: 'update-key' },
				{ label: 'Switch to user-level API key', value: 'use-user' },
				{ label: 'Modify teams', value: 'teams' },
				{ label: 'Cancel', value: 'cancel' },
			],
			'What would you like to do?'
		)

		if (action === null || action === 'cancel') {
			logger.info('Cancelled')
			return
		}

		if (action === 'update-key') {
			await setupProjectWithOwnKey(projectName)
		} else if (action === 'use-user') {
			// Clear project API key, fall back to user
			await deleteSecret(projectSecretKey)
			resetLinearClient()
			logger.success(`\nProject '${projectName}' will now use user-level API key`)

			// Let user configure teams
			const globalConfig = readGlobalConfig()
			const userTeams = globalConfig.linearTeams || []
			if (userTeams.length > 0) {
				await selectProjectTeams(projectName, userTeams)
			}
		} else if (action === 'teams') {
			// Use existing project API key to fetch teams
			await updateProjectTeamsWithKey(projectName, existingProjectApiKey)
		}
		return
	}

	// No project API key - ask what they want to do
	if (userApiKey) {
		const choice = await selectOne(
			[
				{ label: 'Use user-level API key', value: 'user', description: 'Inherit from user config' },
				{ label: 'Use project-specific API key', value: 'project', description: 'Enter a different API key for this project' },
				{ label: 'Cancel', value: 'cancel' },
			],
			'Which API key would you like to use?'
		)

		if (choice === null || choice === 'cancel') {
			logger.info('Cancelled')
			return
		}

		if (choice === 'project') {
			await setupProjectWithOwnKey(projectName)
		} else {
			// Use user-level key, just configure teams
			const globalConfig = readGlobalConfig()
			const userTeams = globalConfig.linearTeams || []

			if (userTeams.length === 0) {
				logger.warning('No teams configured at user level.')
				logger.log("Run 'gssh user config linear setup' to configure teams first.")
				return
			}

			await selectProjectTeams(projectName, userTeams)
		}
	} else {
		// No user API key - must set up project-specific key or user key first
		const choice = await selectOne(
			[
				{ label: 'Set up user-level API key first', value: 'user', description: 'Recommended - share across projects' },
				{ label: 'Use project-specific API key', value: 'project', description: 'Only for this project' },
				{ label: 'Cancel', value: 'cancel' },
			],
			'No user-level API key configured. What would you like to do?'
		)

		if (choice === null || choice === 'cancel') {
			logger.info('Cancelled')
			return
		}

		if (choice === 'user') {
			await setupUserLinear()

			// Check if setup was successful, then configure project teams
			const newApiKey = await getSecret(LINEAR_API_KEY_SECRET)
			if (newApiKey) {
				const newConfig = readGlobalConfig()
				const newTeams = newConfig.linearTeams || []
				if (newTeams.length > 0) {
					logger.log('')
					await selectProjectTeams(projectName, newTeams)
				}
			}
		} else {
			await setupProjectWithOwnKey(projectName)
		}
	}
}

/**
 * Set up a project with its own API key
 */
async function setupProjectWithOwnKey(projectName: string): Promise<void> {
	const apiKey = await promptAndValidateApiKey('Enter Linear API key for this project:')
	if (!apiKey) return

	// Fetch teams with this key
	logger.info('Fetching teams...')
	const teams = await fetchLinearTeams(apiKey)

	if (teams.length === 0) {
		logger.warning('No teams found for this API key')
		// Still save the key
		const projectSecretKey = getProjectLinearSecretKey(projectName)
		await setSecret(projectSecretKey, apiKey)
		resetLinearClient()
		updateProjectConfig(projectName, { linearTeams: [] })
		logger.success(`\nProject API key saved for '${projectName}' (no teams available)`)
		return
	}

	const result = await selectAndConfigureTeams(teams, undefined, `Select teams for '${projectName}':`)
	if (!result) return

	// Save project-specific API key
	const projectSecretKey = getProjectLinearSecretKey(projectName)
	await setSecret(projectSecretKey, apiKey)
	resetLinearClient()

	// Save selected teams
	const teamKeys = result.selectedTeams.map((t) => t.key)
	updateProjectConfig(projectName, { linearTeams: teamKeys })

	const teamList = teamKeys.join(', ')
	logger.success(`\nProject '${projectName}' configured with its own API key (teams: ${teamList})`)
}

/**
 * Update project teams using an existing project API key
 */
async function updateProjectTeamsWithKey(projectName: string, apiKey: string): Promise<void> {
	const projectConfig = readProjectConfig(projectName)
	const currentTeamKeys = new Set(projectConfig.linearTeams || [])

	logger.info('Fetching teams...')
	const teams = await fetchLinearTeams(apiKey)

	if (teams.length === 0) {
		logger.warning('No teams found for this API key')
		return
	}

	const result = await selectAndConfigureTeams(teams, currentTeamKeys, `Select teams for '${projectName}':`)
	if (!result) return

	const teamKeys = result.selectedTeams.map((t) => t.key)
	updateProjectConfig(projectName, { linearTeams: teamKeys })

	const teamList = teamKeys.join(', ')
	logger.success(`\nProject '${projectName}' teams updated: ${teamList}`)
}

/**
 * Select teams for a project
 */
async function selectProjectTeams(
	projectName: string,
	userTeams: LinearTeamInfo[]
): Promise<void> {
	const projectConfig = readProjectConfig(projectName)
	const currentProjectTeams = new Set(projectConfig.linearTeams || [])

	const selectedTeams = await selectMultiple(
		userTeams.map((t) => ({
			label: `${t.key} - ${t.name}`,
			value: t.key,
			checked: currentProjectTeams.size > 0
				? currentProjectTeams.has(t.key)
				: true, // Default to all if no current config
		})),
		`Select teams for '${projectName}':`
	)

	if (selectedTeams === null) {
		logger.info('Cancelled')
		return
	}

	if (selectedTeams.length === 0) {
		// Clear project-level override (use user defaults)
		updateProjectConfig(projectName, { linearTeams: undefined })
		const globalConfig = readGlobalConfig()
		const defaultTeam = globalConfig.linearDefaultTeam || globalConfig.linearTeams?.[0]?.key || 'user default'
		logger.success(`\nProject '${projectName}' will use: ${defaultTeam}`)
	} else {
		updateProjectConfig(projectName, { linearTeams: selectedTeams })
		const teamList = selectedTeams.join(', ')
		logger.success(`\nProject '${projectName}' will use: ${teamList}`)
	}
}

// ============================================================================
// Show Command
// ============================================================================

/**
 * Show Linear configuration
 */
export async function linearShow(options: LinearShowOptions = {}): Promise<void> {
	const { project } = options

	if (project) {
		await showProjectConfig(project)
	} else {
		await showUserConfig()
	}
}

/**
 * Show user-level config
 */
async function showUserConfig(): Promise<void> {
	const apiKey = await getSecret(LINEAR_API_KEY_SECRET)
	const globalConfig = readGlobalConfig()
	const teams = globalConfig.linearTeams || []
	const defaultTeam = globalConfig.linearDefaultTeam

	logger.log('\n── Linear Configuration (User) ──\n')

	if (!apiKey) {
		logger.log('  Status: Not configured')
		logger.log("\n  Run 'gssh user config linear setup' to configure")
	} else {
		logger.log(`  API key: ${maskApiKey(apiKey)}`)

		if (teams.length > 0) {
			logger.log('  Teams:')
			for (const team of teams) {
				const isDefault = team.key === defaultTeam ? ' (default)' : ''
				logger.log(`    - ${team.key} - ${team.name}${isDefault}`)
			}
		} else {
			logger.log('  Teams: None configured')
		}
	}

	logger.log('')
}

/**
 * Show project-level config with resolution
 */
async function showProjectConfig(projectName: string): Promise<void> {
	if (!projectExists(projectName)) {
		throw new SpacesError(`Project '${projectName}' not found`, 'USER_ERROR', 1)
	}

	const config = await getLinearConfig(projectName)
	const projectConfig = readProjectConfig(projectName)

	logger.log(`\n── Linear Configuration (Project: ${projectName}) ──\n`)

	if (!config.apiKey) {
		logger.log('  Status: Not configured')
		logger.log("\n  Run 'gssh user config linear setup' to configure")
		logger.log('')
		return
	}

	const apiKeySource = config.hasProjectApiKey ? '(project-specific)' : '(from user config)'
	logger.log(`  API key: ${maskApiKey(config.apiKey)} ${apiKeySource}`)

	if (config.scope === 'project') {
		const teams = projectConfig.linearTeams || []
		if (teams.length > 0) {
			logger.log(`  Teams: ${teams.join(', ')}`)
		}
	} else {
		logger.log(`  Teams: ${config.teamKeys.join(', ')} (inherited from user config)`)
	}

	logger.log('')
}

// ============================================================================
// Clear Command
// ============================================================================

/**
 * Clear Linear configuration
 */
export async function linearClear(options: LinearClearOptions = {}): Promise<void> {
	const { global: clearGlobal, project } = options

	if (project) {
		await clearProjectConfig(project)
	} else if (clearGlobal) {
		await clearUserConfig()
	} else {
		// Default to user config
		await clearUserConfig()
	}
}

/**
 * Clear user-level config
 */
async function clearUserConfig(): Promise<void> {
	const confirmed = await promptConfirm(
		'Clear user-level Linear configuration (API key and teams)?',
		false
	)

	if (!confirmed) {
		logger.info('Cancelled')
		return
	}

	await deleteSecret(LINEAR_API_KEY_SECRET)
	resetLinearClient()
	updateGlobalConfig({
		linearTeams: undefined,
		linearDefaultTeam: undefined,
	})

	logger.success('Linear configuration cleared')
}

/**
 * Clear project-level config
 */
async function clearProjectConfig(projectName: string): Promise<void> {
	if (!projectExists(projectName)) {
		throw new SpacesError(`Project '${projectName}' not found`, 'USER_ERROR', 1)
	}

	// Check if project has its own API key
	const projectSecretKey = getProjectLinearSecretKey(projectName)
	const hasProjectApiKey = await getSecret(projectSecretKey)

	const message = hasProjectApiKey
		? `Clear Linear configuration for project '${projectName}' (including project-specific API key)?`
		: `Clear Linear configuration for project '${projectName}'?`

	const confirmed = await promptConfirm(message, false)

	if (!confirmed) {
		logger.info('Cancelled')
		return
	}

	// Clear project-specific API key if present
	if (hasProjectApiKey) {
		await deleteSecret(projectSecretKey)
		resetLinearClient()
	}

	updateProjectConfig(projectName, {
		linearTeams: undefined,
	})

	logger.success(`Linear configuration cleared for project '${projectName}'`)
	logger.log('Project will now use user-level defaults')
}
