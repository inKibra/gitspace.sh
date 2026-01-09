/**
 * Type definitions for workspace management
 */

/**
 * Information about a git worktree workspace
 */
export interface WorktreeInfo {
	/** Workspace name (directory name) */
	name: string
	/** Absolute path to the workspace directory */
	path: string
	/** Current git branch */
	branch: string
	/** Number of commits ahead of base branch */
	ahead: number
	/** Number of commits behind base branch */
	behind: number
	/** Number of uncommitted changes */
	uncommittedChanges: number
	/** Last commit message */
	lastCommit: string
	/** Last commit date */
	lastCommitDate: Date
}

/**
 * Project information for listing
 */
export interface ProjectInfo {
	/** Project name */
	name: string
	/** GitHub repository (owner/repo) */
	repository: string
	/** Absolute path to project directory */
	path: string
	/** Number of workspaces in this project */
	workspaceCount: number
	/** Whether this is the current project */
	isCurrent: boolean
}

/**
 * Dependency information
 */
export interface Dependency {
	/** Display name of the dependency */
	name: string
	/** Command to check (e.g., "gh", "git") */
	command: string
	/** Arguments to run for version check */
	checkArgs: string[]
	/** URL for installation instructions */
	installUrl: string
	/** Optional custom auth check function */
	authCheck?: () => Promise<boolean>
}

/**
 * Options for creating a workspace
 */
export interface CreateWorkspaceOptions {
	/** Workspace name */
	name: string
	/** Branch name (defaults to workspace name) */
	branchName?: string
	/** Base branch to create from (defaults to project base branch) */
	fromBranch?: string
	/** Whether to skip opening interactive shell */
	noShell?: boolean
	/** Whether to skip running setup commands */
	noSetup?: boolean
}

/**
 * Label attached to an issue
 */
export interface Label {
	/** Unique identifier for the label */
	id: string
	/** Display name of the label */
	name: string
	/** Hex color code for the label */
	color: string
}

/**
 * User assigned to an issue
 */
export interface User {
	/** Unique identifier for the user */
	id: string
	/** Display name of the user */
	name: string
	/** Email address of the user */
	email: string
}

/**
 * Issue state information
 */
export interface IssueState {
	/** Unique identifier for the state */
	id: string
	/** Display name of the state (e.g., "In Progress", "Done") */
	name: string
	/** State type (e.g., "started", "completed", "canceled") */
	type: string
}

/**
 * Linear issue attachment
 */
export interface LinearAttachment {
	/** Unique identifier for the attachment */
	id: string
	/** URL to the attachment */
	url: string
	/** Title of the attachment */
	title: string | null
	/** Source type (e.g., "upload", "url") */
	sourceType: string | null
	/** Creation timestamp */
	createdAt: Date
}

/**
 * Linear issue for workspace creation
 */
export interface LinearIssue {
	/** Issue ID */
	id: string
	/** Issue identifier (e.g., "ENG-123") */
	identifier: string
	/** Issue title */
	title: string
	/** Issue state */
	state: Promise<IssueState> | undefined
	/** Issue description/body (can be null) */
	description: string | null
	/** Web URL to view the issue */
	url: string
	/** User assigned to the issue (null if unassigned) */
	assignee: Promise<User> | undefined
	/** Timestamp when issue was created */
	createdAt: Date
	/** Timestamp when issue was last updated */
	updatedAt: Date
	/** Issue attachments (images, files, etc.) - lazy-loaded function */
	attachments: () => Promise<LinearAttachment[]>
}
