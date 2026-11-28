// A bot's own things beyond its sign-ins: the requests waiting for its sponsor to approve one use of the bot's own
// secret (its secrets live with everyone's in team-data's `secrets`, scoped to the bot's id) and its Git identity
// (commit author, and how it reaches GitHub: through the team's GitHub App or its own machine-user account with a
// fine-grained token).
import type { Bot } from '../data.js';
import { createStore } from '../store.js';

/** A turn's request to use a bot's own secret whose rule delivers it only after its sponsor approves each use, waiting
 * in the sponsor's Needs you; keyed by the secret's rule key (`release-bot:NPM_PUBLISH_TOKEN`). */
export interface SponsorRequest { workspace: string; why: string }
export const sponsorRequests = createStore<Readonly<Record<string, SponsorRequest>>>({
  'release-bot:NPM_PUBLISH_TOKEN': { workspace: 'release-2026-11', why: 'npm publish for @crumbco/menu 4.2.0' },
});

/** How the bot's commits and pull requests reach GitHub. */
export interface MachineUser { login: string; scopes: readonly string[]; expires: string }
export interface BotGit { author: string; email: string; route: 'app' | 'machine'; machine: MachineUser | null }
export const botGit = createStore<Readonly<Record<string, BotGit>>>({
  'deps-bot': { author: 'Deps bot', email: 'deps-bot@bots.crumbco.gitspace.sh', route: 'machine', machine: { login: 'crumbco-deps', scopes: ['contents:write', 'pull_requests:write', 'metadata:read'], expires: 'Feb 28' } },
});

export function defaultEmail(handle: string): string {
  return `${handle}@bots.crumbco.gitspace.sh`;
}

/** The bot's Git identity: its own, or the default (its name, `<handle>@bots.crumbco.gitspace.sh`, the team's App). */
export function gitOf(bot: Bot, all: Readonly<Record<string, BotGit>>): BotGit {
  return all[bot.id] ?? { author: bot.name, email: defaultEmail(bot.id), route: 'app', machine: null };
}

/** The permissions a machine user's fine-grained token must grant on the team's repositories. */
export const NEEDED_SCOPES: readonly string[] = ['contents:write', 'pull_requests:write'];

/** What the mock's GitHub answers when a fine-grained token is checked: sample tokens that are expired or miss a
 * permission; any other well-formed one grants everything needed. */
export type TokenCheck = { kind: 'ok'; scopes: readonly string[]; expires: string } | { kind: 'missing'; scopes: readonly string[]; missing: readonly string[] } | { kind: 'expired'; on: string };
const SAMPLE_TOKENS: Readonly<Record<string, TokenCheck>> = {
  github_pat_11BREL0readonly: { kind: 'missing', scopes: ['contents:write', 'metadata:read'], missing: ['pull_requests:write'] },
  github_pat_11BREL0expired: { kind: 'expired', on: 'Nov 1' },
};
export function checkToken(token: string): TokenCheck {
  return SAMPLE_TOKENS[token.trim()] ?? { kind: 'ok', scopes: ['contents:write', 'pull_requests:write', 'metadata:read'], expires: 'in 90 days' };
}

/** Why a bot handle can't be used, or null: lowercase letters, digits and hyphens, ending in `-bot`, unique. */
export function handleError(handle: string, taken: readonly string[]): string | null {
  if (!handle) return 'Give it a handle';
  if (!/^[a-z0-9-]+$/.test(handle)) return 'Lowercase letters, digits and hyphens only';
  if (!/^[a-z][a-z0-9-]*-bot$/.test(handle)) return 'Start with a letter and end in “-bot”, like release-bot';
  if (handle.length > 32) return 'At most 32 characters';
  if (taken.includes(handle)) return `${handle} is taken: pick another`;
  return null;
}

/** "Release bot" → "release-bot". */
export function handleFor(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return '';
  return base.endsWith('-bot') ? base : `${base}-bot`;
}

export function emailError(email: string): string | null {
  if (!email.trim()) return 'Give it an email';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'That isn’t an email address: name@domain';
}

/** Avatar colours a bot may take. */
export const BOT_COLORS: readonly string[] = ['#495057', '#5f3dc4', '#364fc7', '#0b7285', '#2b8a3e', '#c2255c', '#e8590c', '#adb5bd'];
