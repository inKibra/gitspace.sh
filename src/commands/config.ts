/**
 * Configuration CLI commands
 *
 * Commands:
 *   gssh config notifications         - Configure notification settings
 *   gssh config notifications --show  - Show current settings
 *   gssh config notifications --reset - Reset to defaults
 *
 *   gssh config linear                - Configure Linear integration
 *   gssh config linear --show         - Show Linear config
 *   gssh config linear --clear        - Clear Linear config
 */

import { logger } from '../utils/logger.js'
import {
	promptConfirm,
	promptInput,
	selectOne,
	selectMultiple,
} from '../utils/prompts.js'
import {
	getNotificationConfig,
	updateNotificationConfig,
} from '../core/config.js'
import { DEFAULT_NOTIFICATION_CONFIG } from '../types/config.js'
import type { NotificationConfig, NotificationTypeConfig } from '../types/config.js'

// Re-export linear functions for use in config command
export { linearSetup, linearShow, linearClear } from './linear.js'

// ============================================================================
// Types
// ============================================================================

export interface ConfigNotificationsOptions {
	show?: boolean
	reset?: boolean
}

// ============================================================================
// Notification Config Command
// ============================================================================

/**
 * Configure notification settings
 *
 * - Default: Interactive setup wizard
 * - --show: Display current settings
 * - --reset: Reset to defaults
 */
export async function configNotifications(options: ConfigNotificationsOptions = {}): Promise<void> {
	if (options.show) {
		await showNotificationConfig()
		return
	}

	if (options.reset) {
		await resetNotificationConfig()
		return
	}

	await interactiveNotificationSetup()
}

/**
 * Show current notification configuration
 */
async function showNotificationConfig(): Promise<void> {
	const config = getNotificationConfig()

	logger.log('\n── Notification Settings ──\n')

	// Global toggles
	logger.log(`  Notifications: ${config.enabled ? '✓ Enabled' : '✗ Disabled'}`)
	logger.log(`  Toast alerts:  ${config.toast.enabled ? '✓ Enabled' : '✗ Disabled'}`)

	// Durations
	const durationSec = Math.round(config.minCommandDurationMs / 1000)
	const holdSec = Math.round(config.toast.holdWhenIdleMs / 1000)
	logger.log(`  Min command duration: ${durationSec}s`)
	logger.log(`  Toast hold when idle: ${holdSec > 0 ? `${holdSec}s` : 'disabled'}`)

	// Type toggles
	logger.log('\n  Notification types:')
	const typeLabels: Record<keyof NotificationTypeConfig, string> = {
		exit: 'Exit (process completion)',
		idle: 'Idle (terminal idle)',
		bell: 'Bell (terminal bell)',
		title: 'Title (title change)',
		osc: 'OSC (escape sequences)',
	}

	for (const [key, label] of Object.entries(typeLabels)) {
		const enabled = config.types[key as keyof NotificationTypeConfig]
		logger.log(`    ${enabled ? '✓' : '✗'} ${label}`)
	}

	logger.log('')
}

/**
 * Reset notification config to defaults
 */
async function resetNotificationConfig(): Promise<void> {
	const confirmed = await promptConfirm(
		'Reset notification settings to defaults?',
		false
	)

	if (!confirmed) {
		logger.info('Cancelled')
		return
	}

	updateNotificationConfig({
		...DEFAULT_NOTIFICATION_CONFIG,
	})

	logger.success('Notification settings reset to defaults')
}

/**
 * Interactive notification setup wizard
 */
async function interactiveNotificationSetup(): Promise<void> {
	const current = getNotificationConfig()

	logger.log('\n── Configure Notifications ──\n')

	// Step 1: Global toggle
	const enabled = await promptConfirm(
		'Enable notifications?',
		current.enabled
	)

	if (!enabled) {
		updateNotificationConfig({ enabled: false })
		logger.success('\nNotifications disabled')
		return
	}

	// Step 2: Min command duration
	const durationInput = await promptInput(
		'Min command duration before exit notification (seconds)',
		{
			default: String(Math.round(current.minCommandDurationMs / 1000)),
			validate: (val) => {
				const num = parseInt(val, 10)
				if (isNaN(num) || num < 0) return 'Enter a positive number'
				return true
			},
		}
	)

	if (durationInput === null) {
		logger.info('Cancelled')
		return
	}

	const minCommandDurationMs = parseInt(durationInput, 10) * 1000

	// Step 3: Notification types
	const typeOptions: Array<{ label: string; value: keyof NotificationTypeConfig; checked: boolean }> = [
		{ label: 'Exit - process completion', value: 'exit', checked: current.types.exit },
		{ label: 'Idle - terminal idle', value: 'idle', checked: current.types.idle },
		{ label: 'Bell - terminal bell (Ctrl+G)', value: 'bell', checked: current.types.bell },
		{ label: 'Title - title change', value: 'title', checked: current.types.title },
		{ label: 'OSC - escape sequences', value: 'osc', checked: current.types.osc },
	]

	const selectedTypes = await selectMultiple(typeOptions, 'Which notification types to enable?')

	if (selectedTypes === null) {
		logger.info('Cancelled')
		return
	}

	const types: NotificationTypeConfig = {
		exit: selectedTypes.includes('exit'),
		idle: selectedTypes.includes('idle'),
		bell: selectedTypes.includes('bell'),
		title: selectedTypes.includes('title'),
		osc: selectedTypes.includes('osc'),
	}

	// Step 4: Toast toggle
	const toastEnabled = await promptConfirm(
		'Enable toast notifications?',
		current.toast.enabled
	)

	// Step 5: Toast hold duration (only if toasts enabled)
	let holdWhenIdleMs = current.toast.holdWhenIdleMs

	if (toastEnabled) {
		const holdInput = await promptInput(
			'Hold toasts when idle (seconds, 0 to disable)',
			{
				default: String(Math.round(current.toast.holdWhenIdleMs / 1000)),
				validate: (val) => {
					const num = parseInt(val, 10)
					if (isNaN(num) || num < 0) return 'Enter a positive number or 0'
					return true
				},
			}
		)

		if (holdInput === null) {
			logger.info('Cancelled')
			return
		}

		holdWhenIdleMs = parseInt(holdInput, 10) * 1000
	}

	// Save configuration
	updateNotificationConfig({
		enabled: true,
		minCommandDurationMs,
		types,
		toast: {
			enabled: toastEnabled,
			holdWhenIdleMs,
		},
	})

	logger.success('\nNotification settings saved')

	// Show summary
	const enabledTypes = Object.entries(types)
		.filter(([_, v]) => v)
		.map(([k]) => k)
		.join(', ')

	logger.log(`  Types: ${enabledTypes || 'none'}`)
	logger.log(`  Min duration: ${Math.round(minCommandDurationMs / 1000)}s`)
	logger.log(`  Toasts: ${toastEnabled ? 'enabled' : 'disabled'}`)
	if (toastEnabled && holdWhenIdleMs > 0) {
		logger.log(`  Hold when idle: ${Math.round(holdWhenIdleMs / 1000)}s`)
	}
}
