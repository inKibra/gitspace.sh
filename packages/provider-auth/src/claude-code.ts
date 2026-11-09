/** The Claude Code release GitSpace's Claude subscription requests present: inference's billing header and user agent,
 * the usage read's and the sign-in bootstrap's user agents. Anthropic refuses models newer than a release supports
 * (`claude_code_version_too_old`: Mythos 5.2 needs 2.1.290). pi-ai may present an older release, never a newer one
 * (`runtime-core/src/inference/claude-code-request.ts`). */
export const CLAUDE_CODE_VERSION = '2.1.321';
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
