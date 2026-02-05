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
import { homedir } from 'os'
import type { GlobalConfig, ProjectConfig, NotificationConfig } from '../types/config.js'
import {
	DEFAULT_GLOBAL_CONFIG,
	DEFAULT_NOTIFICATION_CONFIG,
	DEFAULT_EVENTS_CONFIG,
	createDefaultProjectConfig,
} from '../types/config.js'
import { SpacesError } from '../types/errors.js'

/**
 * Get the global gitspace directory path
 */
export function getGitspaceDir(): string {
	return join(homedir(), 'gitspace')
}

/**
 * @deprecated Use getGitspaceDir() instead
 */
export function getSpacesDir(): string {
	return getGitspaceDir()
}

/**
 * Get the global config file path
 */
export function getGlobalConfigPath(): string {
	return join(getSpacesDir(), '.config.json')
}

/**
 * Get a project directory path
 */
export function getProjectDir(projectName: string): string {
	return join(getSpacesDir(), projectName)
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
 * Get the scripts directory for a project
 */
export function getProjectScriptsDir(projectName: string): string {
	return join(getProjectDir(projectName), 'scripts')
}

/**
 * Get a specific scripts phase directory (pre, setup, select)
 */
export function getScriptsPhaseDir(
	projectName: string,
	phase: 'pre' | 'setup' | 'select' | 'remove'
): string {
	return join(getProjectScriptsDir(projectName), phase)
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
export function writeGlobalConfig(config: GlobalConfig): void {
	const configPath = getGlobalConfigPath()
	const spacesDir = dirname(configPath)

	// Ensure spaces directory exists
	if (!existsSync(spacesDir)) {
		mkdirSync(spacesDir, { recursive: true })
	}

	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
		chmodSync(configPath, 0o600)
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
		const parsed = JSON.parse(content) as ProjectConfig
		return {
			...parsed,
			events: {
				...DEFAULT_EVENTS_CONFIG,
				...(parsed.events || {}),
				fields: {
					...DEFAULT_EVENTS_CONFIG.fields,
					...(parsed.events?.fields || {}),
				},
				rotation: {
					...DEFAULT_EVENTS_CONFIG.rotation,
					...(parsed.events?.rotation || {}),
				},
			},
		}
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
	config: ProjectConfig
): void {
	const configPath = getProjectConfigPath(projectName)
	const projectDir = dirname(configPath)

	// Ensure project directory exists
	if (!existsSync(projectDir)) {
		mkdirSync(projectDir, { recursive: true })
	}

	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
		chmodSync(configPath, 0o600)
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
 * Get current project name from env var or global config
 * Resolution order:
 * 1. SPACES_CURRENT_PROJECT environment variable
 * 2. currentProject field in global config
 * 3. null if neither is set
 */
export function getCurrentProject(): string | null {
	// Check environment variable first
	const envProject = process.env.SPACES_CURRENT_PROJECT
	if (envProject) {
		return envProject
	}

	// Fall back to global config
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

	// Create scripts directories
	mkdirSync(getScriptsPhaseDir(projectName, 'pre'), { recursive: true })
	mkdirSync(getScriptsPhaseDir(projectName, 'setup'), { recursive: true })
	mkdirSync(getScriptsPhaseDir(projectName, 'select'), { recursive: true })
	mkdirSync(getScriptsPhaseDir(projectName, 'remove'), { recursive: true })

	// Create example template scripts in each phase directory
	const preExampleScript = `#!/bin/bash
# Pre-phase script - runs BEFORE workspace shell opens
#
# Current working directory: ~/gitspace/<project>/workspaces/<workspace>/
# (Scripts run from the workspace directory, so you can use relative paths)
#
# This script runs in your terminal immediately after the worktree is created.
# Perfect for preparation tasks like:
#   - Copying environment files (cp .env.example .env)
#   - Creating directories (mkdir -p tmp/uploads)
#   - Any setup that other scripts might need
#
# Arguments:
#   $1 - Workspace name (e.g., "my-feature")
#   $2 - Repository name (e.g., "myorg/my-app")
#
# To use this script:
#   1. Rename it (e.g., 01-copy-env.sh)
#   2. Add your commands
#   3. Make it executable: chmod +x scripts/pre/01-copy-env.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

echo "Running Spaces pre-install on: $WORKSPACE_NAME from $REPOSITORY"
`

	const setupExampleScript = `#!/bin/bash
# Setup-phase script - runs ONCE when workspace is first created
#
# Current working directory: ~/gitspace/<project>/workspaces/<workspace>/
# (Scripts run from the workspace directory, so you can use relative paths)
#
# This script runs the first time a workspace is created.
# Perfect for one-time setup tasks like:
#   - Installing dependencies (npm install, bundle install)
#   - Initial builds (npm run build)
#   - Database setup
#   - Any expensive setup that should only run once
#
# After all setup scripts run, GitSpace creates a gitspace.lock marker file
# to prevent them from running again.
#
# Arguments:
#   $1 - Workspace name (e.g., "my-feature")
#   $2 - Repository name (e.g., "myorg/my-app")
#
# To use this script:
#   1. Rename it (e.g., 01-install.sh)
#   2. Add your commands
#   3. Make it executable: chmod +x scripts/setup/01-install.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

echo "Setting up Spaces workspace on: $WORKSPACE_NAME from $REPOSITORY"
`

	const selectExampleScript = `#!/bin/bash
# Select-phase script - runs EVERY TIME you switch to a workspace
#
# Current working directory: ~/gitspace/<project>/workspaces/<workspace>/
# (Scripts run from the workspace directory, so you can use relative paths)
#
# This script runs every time you switch to an existing workspace
# (where setup already completed).
# Perfect for quick status updates like:
#   - Fetching latest changes (git fetch --all)
#   - Checking workspace state (git status)
#   - Environment checks
#   - Quick status updates
#
# Arguments:
#   $1 - Workspace name (e.g., "my-feature")
#   $2 - Repository name (e.g., "myorg/my-app")
#
# To use this script:
#   1. Rename it (e.g., 01-fetch.sh)
#   2. Add your commands
#   3. Make it executable: chmod +x scripts/select/01-fetch.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

echo "Running Spaces script on: $WORKSPACE_NAME from $REPOSITORY"
`

	const removeExampleScript = `#!/bin/bash
# Remove-phase script - runs when workspace is REMOVED
#
# Current working directory: ~/gitspace/<project>/workspaces/<workspace>/
# (Scripts run from the workspace directory, so you can use relative paths)
#
# This script runs in your terminal when you remove a workspace,
# BEFORE the worktree is deleted. Perfect for cleanup tasks like:
#   - Tearing down test databases
#   - Removing cloud resources (S3 buckets, EC2 instances)
#   - Cleaning up external services
#   - Removing temporary Docker containers/volumes
#   - Cleaning up API keys or tokens
#
# Arguments:
#   $1 - Workspace name (e.g., "my-feature")
#   $2 - Repository name (e.g., "myorg/my-app")
#
# To use this script:
#   1. Rename it (e.g., 01-cleanup-db.sh)
#   2. Add your commands
#   3. Make it executable: chmod +x scripts/remove/01-cleanup-db.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

echo "Running Spaces cleanup on: $WORKSPACE_NAME from $REPOSITORY"
`

	// Write and make executable
	const preExamplePath = join(
		getScriptsPhaseDir(projectName, 'pre'),
		'00-example.sh'
	)
	const setupExamplePath = join(
		getScriptsPhaseDir(projectName, 'setup'),
		'00-example.sh'
	)
	const selectExamplePath = join(
		getScriptsPhaseDir(projectName, 'select'),
		'00-example.sh'
	)
	const removeExamplePath = join(
		getScriptsPhaseDir(projectName, 'remove'),
		'00-example.sh'
	)

	writeFileSync(preExamplePath, preExampleScript, 'utf-8')
	chmodSync(preExamplePath, 0o755)

	writeFileSync(setupExamplePath, setupExampleScript, 'utf-8')
	chmodSync(setupExamplePath, 0o755)

	writeFileSync(selectExamplePath, selectExampleScript, 'utf-8')
	chmodSync(selectExamplePath, 0o755)

	writeFileSync(removeExamplePath, removeExampleScript, 'utf-8')
	chmodSync(removeExamplePath, 0o755)

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

// ============================================================================
// Wide Events Config Helpers
// ============================================================================

/**
 * Get wide events configuration for a project
 */
export function getProjectEventsConfig(projectName: string) {
	const config = readProjectConfig(projectName)
	return {
		...DEFAULT_EVENTS_CONFIG,
		...(config.events || {}),
		fields: {
			...DEFAULT_EVENTS_CONFIG.fields,
			...(config.events?.fields || {}),
		},
		rotation: {
			...DEFAULT_EVENTS_CONFIG.rotation,
			...(config.events?.rotation || {}),
		},
	}
}
