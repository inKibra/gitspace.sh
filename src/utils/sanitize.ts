/**
 * Name sanitization utilities for filesystem safety
 */

/**
 * Sanitize a string for filesystem use
 * - Converts to lowercase
 * - Replaces invalid characters with hyphens
 * - Collapses multiple hyphens
 * - Removes leading/trailing hyphens
 * - Limits length to 100 characters
 *
 * @param name String to sanitize
 * @returns Sanitized string safe for filesystem
 *
 * @example
 * sanitizeForFileSystem("Fix Login Bug!") // "fix-login-bug"
 * sanitizeForFileSystem("Feature / User Settings") // "feature-user-settings"
 */
export function sanitizeForFileSystem(name: string): string {
  return (
    name
      .toLowerCase()
      // Replace any non-alphanumeric characters (except hyphens and underscores) with hyphen
      .replace(/[^a-z0-9-_]/g, '-')
      // Collapse multiple hyphens into one
      .replace(/-+/g, '-')
      // Remove leading and trailing hyphens
      .replace(/^-|-$/g, '')
      // Limit length to 100 characters
      .slice(0, 100)
  );
}

/**
 * Generate a workspace name from a Linear issue identifier and title
 *
 * @param identifier Issue identifier (e.g., "ENG-123")
 * @param title Issue title
 * @returns Workspace name in format "{identifier}-{sanitized-title}"
 *
 * @example
 * generateWorkspaceName("ENG-123", "Fix Login Bug!") // "eng-123-fix-login-bug"
 * generateWorkspaceName("FEAT-456", "Add Dark Mode") // "feat-456-add-dark-mode"
 */
export function generateWorkspaceName(identifier: string, title: string): string {
  const sanitizedTitle = sanitizeForFileSystem(title);
  const sanitizedIdentifier = identifier.toLowerCase();

  return `${sanitizedIdentifier}-${sanitizedTitle}`;
}

/**
 * Validate a workspace name
 * - Must contain only alphanumeric characters, hyphens, and underscores
 * - Must not contain spaces
 * - Must not be empty
 * - Must not start or end with a hyphen
 *
 * @param name Workspace name to validate
 * @returns true if valid, false otherwise
 */
export function isValidWorkspaceName(name: string): boolean {
  if (!name || name.length === 0) {
    return false;
  }

  // Check for spaces (explicitly rejected)
  if (name.includes(' ')) {
    return false;
  }

  // Check for valid characters
  if (!/^[a-z0-9-_]+$/i.test(name)) {
    return false;
  }

  // Check for leading/trailing hyphens
  if (name.startsWith('-') || name.endsWith('-')) {
    return false;
  }

  return true;
}

/**
 * Extract repository name from owner/repo format
 *
 * @param repository Repository in "owner/repo" format
 * @returns Repository name
 *
 * @example
 * extractRepoName("myorg/my-app") // "my-app"
 */
export function extractRepoName(repository: string): string {
  const parts = repository.split('/');
  return parts[parts.length - 1];
}
