/**
 * Shell escaping utilities for safe command execution
 * Prevents command injection vulnerabilities when passing user input to shell commands
 */

/**
 * Escape a string argument for safe use in shell commands
 *
 * This function wraps the argument in single quotes and escapes any single quotes
 * within the string by replacing them with '\''
 *
 * @param arg The string to escape
 * @returns Safely escaped string for shell use
 *
 * @example
 * escapeShellArg("my-branch") // "'my-branch'"
 * escapeShellArg("branch'name") // "'branch'\''name'"
 * escapeShellArg("feature/test") // "'feature/test'"
 * escapeShellArg('"; rm -rf / #') // "'\"rm -rf / #'"
 */
export function escapeShellArg(arg: string): string {
  // Single quotes protect against all shell metacharacters except single quote itself
  // To include a single quote, we end the single-quoted string, add an escaped single quote,
  // and start a new single-quoted string: 'don'\''t' -> "don't"
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape multiple arguments and join them with spaces
 *
 * @param args Array of arguments to escape
 * @returns Space-separated string of escaped arguments
 *
 * @example
 * escapeShellArgs(["git", "commit", "-m", "my message"])
 * // "'git' 'commit' '-m' 'my message'"
 */
export function escapeShellArgs(...args: string[]): string {
  return args.map(escapeShellArg).join(' ');
}
