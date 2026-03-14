/**
 * Custom error types for GitSpace CLI
 */

export type ErrorCode = 'USER_ERROR' | 'SYSTEM_ERROR' | 'SERVICE_ERROR';

/**
 * Base error class for GitSpace CLI
 */
export class SpacesError extends Error {
  public readonly code: ErrorCode;
  public readonly exitCode: number;

  constructor(message: string, code: ErrorCode = 'USER_ERROR', exitCode?: number) {
    super(message);
    this.name = 'SpacesError';
    this.code = code;

    // Set exit code based on error type if not provided
    if (exitCode !== undefined) {
      this.exitCode = exitCode;
    } else {
      switch (code) {
        case 'USER_ERROR':
          this.exitCode = 1;
          break;
        case 'SYSTEM_ERROR':
          this.exitCode = 2;
          break;
        case 'SERVICE_ERROR':
          this.exitCode = 3;
          break;
      }
    }

    // Maintains proper stack trace for where error was thrown (Node/V8).
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export function toSpacesError(error: unknown, fallbackMessage: string): SpacesError {
  if (error instanceof SpacesError) {
    return error;
  }
  if (error instanceof Error) {
    return new SpacesError(error.message, 'SYSTEM_ERROR', 2);
  }
  return new SpacesError(fallbackMessage, 'SYSTEM_ERROR', 2);
}

/**
 * Error thrown when a dependency is missing
 */
export class DependencyError extends SpacesError {
  constructor(message: string) {
    super(message, 'SYSTEM_ERROR', 2);
    this.name = 'DependencyError';
  }
}

/**
 * Error thrown when GitHub CLI is not authenticated
 */
export class GitHubAuthError extends SpacesError {
  constructor() {
    super(
      '✗ Error: GitHub CLI is not authenticated\n\nPlease run: gh auth login\n\nThen try again.',
      'SYSTEM_ERROR',
      2
    );
    this.name = 'GitHubAuthError';
  }
}

/**
 * Error thrown when a project already exists
 */
export class ProjectExistsError extends SpacesError {
  constructor(projectName: string, projectPath: string) {
    super(
      `✗ Error: Project "${projectName}" already exists\n\nThe directory ${projectPath} already contains a project.\n\nTo use this project:\n  gssh workspace list --project ${projectName}\n\nTo remove and recreate:\n  gssh project remove ${projectName}\n  gssh project add`,
      'USER_ERROR',
      1
    );
    this.name = 'ProjectExistsError';
  }
}

/**
 * Error thrown when a workspace already exists
 */
export class WorkspaceExistsError extends SpacesError {
  constructor(workspaceName: string) {
    super(
      `✗ Error: Workspace "${workspaceName}" already exists\n\nUse it with workspace commands:\n  gssh workspace context --project <project-name> --workspace ${workspaceName}`,
      'USER_ERROR',
      1
    );
    this.name = 'WorkspaceExistsError';
  }
}

/**
 * Error thrown when no project is selected
 */
export class NoProjectError extends SpacesError {
  constructor() {
    super(
      '✗ Error: No project selected\n\nCreate a project first:\n  gssh project add\n\nThen pass --project on workspace commands, for example:\n  gssh workspace list --project <project-name>',
      'USER_ERROR',
      1
    );
    this.name = 'NoProjectError';
  }
}

// ============================================================================
// Identity & Access Control Errors
// ============================================================================

/**
 * Error thrown when identity is not initialized
 */
export class NoIdentityError extends SpacesError {
  constructor() {
    super(
      '✗ Error: No identity found\n\nInitialize your identity first:\n  gssh user identity init',
      'USER_ERROR',
      1
    );
    this.name = 'NoIdentityError';
  }
}

/**
 * Error thrown when password is incorrect for keypair decryption
 */
export class InvalidPasswordError extends SpacesError {
  constructor() {
    super(
      '✗ Error: Invalid password\n\nThe password you entered is incorrect.',
      'USER_ERROR',
      1
    );
    this.name = 'InvalidPasswordError';
  }
}

/**
 * Error thrown when client is not in access list
 */
export class AccessDeniedError extends SpacesError {
  constructor(identityId?: string) {
    const msg = identityId
      ? `✗ Error: Access denied for identity ${identityId}\n\nThis identity is not in the access list.`
      : '✗ Error: Access denied\n\nYou are not authorized to connect to this machine.';
    super(msg, 'USER_ERROR', 1);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Error thrown when invite token is invalid or expired
 */
export class InvalidInviteError extends SpacesError {
  constructor(reason: string = 'Invalid or expired invite') {
    super(
      `✗ Error: ${reason}\n\nThe invite link may have expired or been revoked.`,
      'USER_ERROR',
      1
    );
    this.name = 'InvalidInviteError';
  }
}

/**
 * Error thrown when handshake protocol fails
 */
export class HandshakeFailedError extends SpacesError {
  constructor(reason: string = 'Handshake failed') {
    super(
      `✗ Error: ${reason}\n\nCould not establish secure connection.`,
      'SERVICE_ERROR',
      3
    );
    this.name = 'HandshakeFailedError';
  }
}

/**
 * Error thrown when identity already exists
 */
export class IdentityExistsError extends SpacesError {
  constructor() {
    super(
      '✗ Error: Identity already exists\n\nTo overwrite, use:\n  gssh user identity init --force',
      'USER_ERROR',
      1
    );
    this.name = 'IdentityExistsError';
  }
}

/**
 * Error thrown when public key format is invalid
 */
export class InvalidPublicKeyError extends SpacesError {
  constructor(reason: string = 'Invalid public key format') {
    super(
      `✗ Error: ${reason}\n\nPublic keys should be base64-encoded Ed25519 or X25519 keys.`,
      'USER_ERROR',
      1
    );
    this.name = 'InvalidPublicKeyError';
  }
}

export type WorkspaceDeleteErrorCode =
  | 'REMOVE_SCRIPT_FAILED'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKTREE_REMOVE_FAILED'
  | 'DELETE_FAILED'
  | 'NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'DELETE_TIMEOUT';

/**
 * Error thrown when workspace deletion fails in session backends.
 * Keeps machine-parseable delete codes for retry/UX handling.
 */
export class WorkspaceDeleteError extends Error {
  public readonly code: WorkspaceDeleteErrorCode;

  constructor(message: string, code: WorkspaceDeleteErrorCode) {
    super(message);
    this.name = 'WorkspaceDeleteError';
    this.code = code;

    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export type ReviewRequestErrorCode =
  | 'REVIEW_TIMEOUT'
  | 'REVIEW_FAILED'
  | 'REVIEW_MISSING_RESULT'
  | (string & {});

/**
 * Error thrown when remote review requests fail or time out.
 */
export class ReviewRequestError extends Error {
  public readonly code: ReviewRequestErrorCode;
  public readonly metadata?: { op?: string; requestId?: string };

  constructor(
    message: string,
    code: ReviewRequestErrorCode,
    metadata?: { op?: string; requestId?: string }
  ) {
    super(message);
    this.name = 'ReviewRequestError';
    this.code = code;
    this.metadata = metadata;

    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when a requested session name already exists.
 */
export class SessionNameExistsError extends Error {
  public readonly code: 'SESSION_ALREADY_EXISTS';

  constructor(message: string) {
    super(message);
    this.name = 'SessionNameExistsError';
    this.code = 'SESSION_ALREADY_EXISTS';

    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ReplayScreenshotError extends SpacesError {
  constructor(message: string) {
    super(message, 'SYSTEM_ERROR', 2);
    this.name = 'ReplayScreenshotError';
  }
}
