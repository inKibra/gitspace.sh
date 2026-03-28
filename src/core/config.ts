/**
 * Configuration management for global and project configs
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	statSync,
	chmodSync,
} from 'fs'
import { join, dirname } from 'path'
import type { GlobalConfig, ProjectConfig, NotificationConfig, EventsConfig } from '../types/config.js'
import { getWorkspaceRoot, getConfigRoot, getWorkspaceProjectDir } from './paths.js'
import {
	DEFAULT_GLOBAL_CONFIG,
	DEFAULT_NOTIFICATION_CONFIG,
	DEFAULT_EVENTS_CONFIG,
	createDefaultProjectConfig,
} from '../types/config.js'
import { SpacesError } from '../types/errors.js'
import { notifyOwnerSyncCategoryDirty } from './owner-sync-events.js'

/**
 * Get the global GitSpace workspace root.
 *
 * @deprecated Callers should prefer getWorkspaceRoot() from core/paths.
 */
export function getGitspaceDir(): string {
	return getWorkspaceRoot()
}

/**
 * @deprecated Use getWorkspaceRoot() instead.
 */
export function getSpacesDir(): string {
	return getWorkspaceRoot()
}

/**
 * Get the global config file path
 */
export function getGlobalConfigPath(): string {
	return join(getConfigRoot(), '.config.json')
}

/**
 * Get a project directory path
 */
export function getProjectDir(projectName: string): string {
	return getWorkspaceProjectDir(projectName)
}

/**
 * Get a project config file path
 */
export function getProjectConfigPath(projectName: string): string {
	return join(getProjectDir(projectName), '.config.json')
}

/**
 * Get the base repository directory for a project
 */
export function getProjectBaseDir(projectName: string): string {
	return join(getProjectDir(projectName), 'base')
}

/**
 * Get the workspaces directory for a project
 */
export function getProjectWorkspacesDir(projectName: string): string {
	return join(getProjectDir(projectName), 'workspaces')
}

/**
 * Initialize global config with defaults
 */
function initializeGlobalConfig(): GlobalConfig {
	return {
		...DEFAULT_GLOBAL_CONFIG,
		projectsDir: getSpacesDir(),
	}
}

/**
 * Read global configuration
 */
export function readGlobalConfig(): GlobalConfig {
	const configPath = getGlobalConfigPath()

	if (!existsSync(configPath)) {
		// Return default config if file doesn't exist
		return initializeGlobalConfig()
	}

	try {
		const content = readFileSync(configPath, 'utf-8')
		const config = JSON.parse(content) as GlobalConfig

		// Merge with defaults to ensure all fields exist
		return {
			...initializeGlobalConfig(),
			...config,
		}
	} catch (error) {
		throw new SpacesError(
			`Failed to read global config: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		)
	}
}

/**
 * Write global configuration
 */
export function writeGlobalConfig(
	config: GlobalConfig,
	options: { notifySync?: boolean } = {}
): void {
	const configPath = getGlobalConfigPath()
	const spacesDir = dirname(configPath)
	const shouldNotify = options.notifySync !== false

	// Ensure spaces directory exists
	if (!existsSync(spacesDir)) {
		mkdirSync(spacesDir, { recursive: true })
	}

	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
		chmodSync(configPath, 0o600)
		if (shouldNotify) {
			notifyOwnerSyncCategoryDirty('preferences')
			notifyOwnerSyncCategoryDirty('integrations')
			notifyOwnerSyncCategoryDirty('project/workspace')
		}
	} catch (error) {
		throw new SpacesError(
			`Failed to write global config: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		)
	}
}

/**
 * Update global configuration
 */
export function updateGlobalConfig(
	updates: Partial<GlobalConfig>
): GlobalConfig {
	const config = readGlobalConfig()
	const updated = { ...config, ...updates }
	writeGlobalConfig(updated)
	return updated
}

/**
 * Read project configuration
 */
export function readProjectConfig(projectName: string): ProjectConfig {
	const configPath = getProjectConfigPath(projectName)

	if (!existsSync(configPath)) {
		throw new SpacesError(`Project "${projectName}" not found`, 'USER_ERROR', 1)
	}

	try {
		const content = readFileSync(configPath, 'utf-8')
		return JSON.parse(content) as ProjectConfig
	} catch (error) {
		throw new SpacesError(
			`Failed to read project config for "${projectName}": ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		)
	}
}

/**
 * Write project configuration
 */
export function writeProjectConfig(
	projectName: string,
	config: ProjectConfig,
	options: { notifySync?: boolean } = {}
): void {
	const configPath = getProjectConfigPath(projectName)
	const projectDir = dirname(configPath)
	const shouldNotify = options.notifySync !== false

	// Ensure project directory exists
	if (!existsSync(projectDir)) {
		mkdirSync(projectDir, { recursive: true })
	}

	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
		chmodSync(configPath, 0o600)
		if (shouldNotify) {
			notifyOwnerSyncCategoryDirty('integrations')
			notifyOwnerSyncCategoryDirty('project/workspace')
		}
	} catch (error) {
		throw new SpacesError(
			`Failed to write project config for "${projectName}": ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		)
	}
}

/**
 * Update project configuration
 */
export function updateProjectConfig(
	projectName: string,
	updates: Partial<ProjectConfig>
): ProjectConfig {
	const config = readProjectConfig(projectName)
	const updated = { ...config, ...updates }
	writeProjectConfig(projectName, updated)
	return updated
}

/**
 * Get current project name from global config.
 */
export function getCurrentProject(): string | null {
	const globalConfig = readGlobalConfig()
	return globalConfig.currentProject
}

/**
 * Set current project in global config
 */
export function setCurrentProject(projectName: string): void {
	updateGlobalConfig({ currentProject: projectName })
}

/**
 * Check if the global config exists (first-time setup check)
 */
export function isFirstTimeSetup(): boolean {
	return !existsSync(getGlobalConfigPath())
}

/**
 * Initialize spaces directory and config for first-time setup
 */
export function initializeSpaces(): void {
	const spacesDir = getSpacesDir()

	// Create spaces directory if it doesn't exist
	if (!existsSync(spacesDir)) {
		mkdirSync(spacesDir, { recursive: true })
	}

	// Create global config if it doesn't exist
	if (!existsSync(getGlobalConfigPath())) {
		writeGlobalConfig(initializeGlobalConfig())
	}
}

/**
 * Get all project names
 */
export function getAllProjectNames(): string[] {
	const spacesDir = getSpacesDir()

	if (!existsSync(spacesDir)) {
		return []
	}

	try {
		const entries = readdirSync(spacesDir) as string[]

		// Filter to only directories that have a .config.json file
		return entries.filter((entry: string) => {
			const projectDir = join(spacesDir, entry)
			const configPath = join(projectDir, '.config.json')
			return (
				statSync(projectDir).isDirectory() &&
				existsSync(configPath) &&
				entry !== 'app' // Exclude the app directory
			)
		})
	} catch (error) {
		throw new SpacesError(
			`Failed to list projects: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		)
	}
}

/**
 * Check if a project exists
 */
export function projectExists(projectName: string): boolean {
	const configPath = getProjectConfigPath(projectName)
	return existsSync(configPath)
}

/**
 * Create a new project configuration
 */
export function createProject(
	projectName: string,
	repository: string,
	baseBranch: string
): ProjectConfig {
	const config = createDefaultProjectConfig(
		projectName,
		repository,
		baseBranch
	)

	// Create project directories
	const projectDir = getProjectDir(projectName)
	const baseDir = getProjectBaseDir(projectName)
	const workspacesDir = getProjectWorkspacesDir(projectName)

	mkdirSync(projectDir, { recursive: true })
	mkdirSync(baseDir, { recursive: true })
	mkdirSync(workspacesDir, { recursive: true })

	// Write project config
	writeProjectConfig(projectName, config)

	return config
}

// ============================================================================
// Notification Config Helpers
// ============================================================================

/**
 * Get notification configuration (with defaults for missing fields)
 */
export function getNotificationConfig(): NotificationConfig {
	const globalConfig = readGlobalConfig()
	const userConfig = globalConfig.notifications

	if (!userConfig) {
		return { ...DEFAULT_NOTIFICATION_CONFIG }
	}

	// Merge with defaults to ensure all fields exist
	return {
		enabled: userConfig.enabled ?? DEFAULT_NOTIFICATION_CONFIG.enabled,
		minCommandDurationMs:
			userConfig.minCommandDurationMs ??
			DEFAULT_NOTIFICATION_CONFIG.minCommandDurationMs,
		types: {
			...DEFAULT_NOTIFICATION_CONFIG.types,
			...userConfig.types,
		},
		toast: {
			...DEFAULT_NOTIFICATION_CONFIG.toast,
			...userConfig.toast,
		},
	}
}

/**
 * Update notification configuration
 */
export function updateNotificationConfig(
	updates: Partial<NotificationConfig>
): NotificationConfig {
	const current = getNotificationConfig()
	const updated: NotificationConfig = {
		...current,
		...updates,
		types: {
			...current.types,
			...(updates.types || {}),
		},
		toast: {
			...current.toast,
			...(updates.toast || {}),
		},
	}
	updateGlobalConfig({ notifications: updated })
	return updated
}

/**
 * Get events config for a project, falling back to defaults
 */
export function getProjectEventsConfig(projectName: string): EventsConfig {
	try {
		const config = readProjectConfig(projectName)
		return config.events ?? { ...DEFAULT_EVENTS_CONFIG }
	} catch {
		return { ...DEFAULT_EVENTS_CONFIG }
	}
}

export interface OwnerSyncConfigSnapshot {
	globalConfig: GlobalConfig
	projectConfigs: Record<string, ProjectConfig>
}

export function exportConfigForOwnerSyncSnapshot(): OwnerSyncConfigSnapshot {
	const globalConfig = readGlobalConfig()
	const projectConfigs: Record<string, ProjectConfig> = {}
	for (const projectName of getAllProjectNames()) {
		try {
			projectConfigs[projectName] = readProjectConfig(projectName)
		} catch {
			// ignore unreadable project config
		}
	}

	return {
		globalConfig,
		projectConfigs,
	}
}

export function importConfigFromOwnerSyncSnapshot(snapshot: OwnerSyncConfigSnapshot): void {
	writeGlobalConfig(snapshot.globalConfig, { notifySync: false })
	for (const [projectName, config] of Object.entries(snapshot.projectConfigs)) {
		writeProjectConfig(projectName, config, { notifySync: false })
	}
}
