// The You pages' mock state that their dialogs change: profile and commit author edits, the GitHub account and SSH key
// each person set up for their own machines, signing, voice and defaults, passkeys added or renamed, MCP grants, the
// values projects ask each person for, and machines added at either scope with their notes, attach switch and projects.
// Each store starts from the shared seed in settings/data.ts; the pages read these stores.
import { TEAM, USERS } from '../data.js';
import { createStore } from '../store.js';
import { GITHUB_ACCOUNTS, MCP_GRANTS, PERSONAL_SSH_KEYS, PERSONAL_VALUES, TEAM_SSH_KEY, type Capability, type Machine, type McpGrant } from '../settings/data.js';

/** A deterministic fake SSH fingerprint for `seed` ("SHA256:" and 43 base64 characters). */
export function fakeFingerprint(seed: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let index = 0; index < 43; index += 1) {
    state = Math.imul(state ^ (state >>> 13), 1103515245) + 12345 >>> 0;
    out += alphabet[state % 64];
  }
  return `SHA256:${out}`;
}

/** A pairing or device code: four characters, a dash, four characters. */
export function fakeCode(seed: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let index = 0; index < 8; index += 1) {
    state = Math.imul(state ^ (state >>> 11), 1664525) + 1013904223 >>> 0;
    out += alphabet[state % alphabet.length];
    if (index === 3) out += '-';
  }
  return out;
}

/** Profile: the name and avatar colour a person set (falls back to the seed user). */
export const profiles = createStore<Readonly<Record<string, { name: string; color: string }>>>(
  Object.fromEntries(USERS.map((user) => [user.id, { name: user.name, color: user.color }])));
export const AVATAR_COLORS: readonly string[] = ['#e8590c', '#1c7ed6', '#0ca678', '#ae3ec9', '#868e96', '#d6336c', '#f59f00', '#364fc7'];

/** Commit author: name and email on commits from turns the person starts. */
export const authors = createStore<Readonly<Record<string, { name: string; email: string }>>>(
  Object.fromEntries(USERS.map((user) => [user.id, { name: user.name, email: user.email }])));

/** The accounts a person's GitHub sign-in can use (GitHub's account switcher), each with its emails. */
export interface GitHubIdentity { login: string; name: string; emails: ReadonlyArray<{ address: string; verified: boolean; primary?: boolean }> }
export const GITHUB_IDENTITIES: Readonly<Record<string, readonly GitHubIdentity[]>> = {
  maya: [
    { login: 'maya-okafor', name: 'Maya Okafor', emails: [{ address: 'maya@crumbco.example', verified: true, primary: true }, { address: 'maya.okafor@mail.example', verified: true }, { address: '4120931+maya-okafor@users.noreply.github.com', verified: true }] },
    { login: 'crumb-maya', name: 'Maya (Crumb ops)', emails: [{ address: 'ops@crumbco.example', verified: true, primary: true }] },
  ],
  theo: [{ login: 'theopark', name: 'Theo Park', emails: [{ address: 'theo@crumbco.example', verified: true, primary: true }] }],
  rina: [{ login: 'rina-o', name: 'Rina Ortiz', emails: [{ address: 'rina@crumbco.example', verified: true, primary: true }, { address: 'rina.ortiz@mail.example', verified: true }] }],
  sam: [{ login: 'samlee-design', name: 'Sam Lee', emails: [{ address: 'sam@crumbco.example', verified: true, primary: true }] }],
  jules: [
    { login: 'jmoreau', name: 'Jules Moreau', emails: [{ address: 'jules.moreau@mail.example', verified: true, primary: true }, { address: 'jules@crumbco.example', verified: false }, { address: '88213+jmoreau@users.noreply.github.com', verified: true }] },
  ],
};

/** A person's connected GitHub account: its login, the commit email confirmed on it, and whether their SSH key was added. */
export interface GitHubLink { login: string; email: string; keyAdded: boolean }
export const githubLinks = createStore<Readonly<Record<string, GitHubLink | null>>>(Object.fromEntries(USERS.map((user) => {
  const login = GITHUB_ACCOUNTS[user.id];
  return [user.id, login ? { login, email: user.email, keyAdded: true } : null];
})));

/** A person's SSH key for origins the GitHub App doesn't cover, on their own machines. */
export interface PersonalKey { name: string; fingerprint: string; algorithm: string; created: string; source: 'generated' | 'pasted' }
export const sshKeys = createStore<Readonly<Record<string, PersonalKey | null>>>(Object.fromEntries(USERS.map((user) => {
  const key = PERSONAL_SSH_KEYS[user.id];
  return [user.id, key ? { name: `${user.id}-gitspace`, fingerprint: key.fingerprint, algorithm: 'ed25519', created: key.created, source: 'generated' } : null];
})));
/** The public half shown by Copy public key. */
export function publicKeyOf(userId: string, key: PersonalKey): string {
  return `ssh-${key.algorithm === 'rsa' ? 'rsa' : 'ed25519'} AAAAC3NzaC1lZDI1NTE5AAAAI${key.fingerprint.slice(7, 39)} ${key.name}@${TEAM.host.split('.')[0]}`;
}

/** How commits are signed: with the SSH key above, or not at all. */
export const signing = createStore<Readonly<Record<string, 'ssh' | 'off'>>>({});
/** Whether a person's physical computers use their own ~/.ssh keys instead of the GitSpace key. */
export const ownKeys = createStore<Readonly<Record<string, boolean>>>({});

export interface VoicePrefs { dictation: string; push: boolean; spoken: string }
export const voicePrefs = createStore<Readonly<Record<string, VoicePrefs>>>({});
export const DEFAULT_VOICE: VoicePrefs = { dictation: 'en-US', push: true, spoken: 'off' };
export const DICTATION_LANGUAGES: ReadonlyArray<readonly [string, string]> = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['fr-FR', 'French'], ['es-ES', 'Spanish'], ['de-DE', 'German'], ['ja-JP', 'Japanese']];
export const SPOKEN_REPLIES: ReadonlyArray<readonly [string, string]> = [['off', 'Off'], ['short', 'Short summaries'], ['full', 'Full replies']];

export interface DefaultPrefs { role: string; mode: string; notify: boolean }
export const defaultPrefs = createStore<Readonly<Record<string, DefaultPrefs>>>({});
export const DEFAULT_DEFAULTS: DefaultPrefs = { role: 'default', mode: 'plan', notify: true };
export const MODEL_ROLES: ReadonlyArray<readonly [string, string, string]> = [['default', 'Default', 'The project profile’s main model'], ['small', 'Small', 'Faster and cheaper; the profile’s small model'], ['slow', 'Thorough', 'The profile’s strongest model; slower']];
export const WORKSPACE_MODES: ReadonlyArray<readonly [string, string, string]> = [['plan', 'Plan', 'Talks it through and writes a plan before touching code'], ['code', 'Code', 'Starts changing code right away']];

/** Passkeys added and renamed while the mock is open (removed ones go to the shared `revoked` store). */
export interface Device { id: string; label: string; kind: string; added: string; lastUsed: string; current?: boolean }
export const addedDevices = createStore<Readonly<Record<string, readonly Device[]>>>({});
export const deviceNames = createStore<Readonly<Record<string, string>>>({});

/** MCP grants, live: connected, edited and revoked here. */
export const mcpGrants = createStore<readonly McpGrant[]>(MCP_GRANTS);
export const MCP_CLIENTS: ReadonlyArray<{ id: string; name: string; host: string; detail: string }> = [
  { id: 'claude-code', name: 'Claude Code', host: 'claude.ai', detail: 'Anthropic’s CLI: add the server with one command, then enter the code when it asks' },
  { id: 'cursor', name: 'Cursor', host: 'cursor.com', detail: 'Settings › MCP › Add server: paste the URL, then the code' },
  { id: 'codex', name: 'Codex', host: 'chatgpt.com', detail: 'OpenAI’s CLI: add the server with one command, then enter the code' },
  { id: 'other', name: 'Another client', host: '', detail: 'Any MCP client that does OAuth: name it and give its redirect URL' },
];
export const EXPIRIES: readonly string[] = ['1 day', '7 days', '30 days', '90 days'];
/** The project permission each MCP capability needs; `read` needs none beyond membership. */
export const CAPABILITY_ACTION: Readonly<Record<Capability, 'chatter.post' | 'workspace.claim' | 'workspace.takeover' | 'phase.code' | 'environment.approve' | null>> = {
  read: null, comment: 'chatter.post', prompt: 'workspace.claim', 'take the handle': 'workspace.takeover', 'move phases': 'phase.code', 'approve environment': 'environment.approve',
};

/** What each value a project asks for is, so its input can be checked. */
export const VALUE_KINDS: Readonly<Record<string, { kind: 'login' | 'token'; service: string; prefix?: string; how: string }>> = {
  STAGING_LOGIN: { kind: 'login', service: 'staging.crumb.example', how: 'Your own staging account; ask a Crumb Lead if you don’t have one' },
  FIGMA_TOKEN: { kind: 'token', service: 'Figma', prefix: 'figd_', how: 'figma.com › Settings › Security › Personal access tokens · read-only file content is enough' },
  SENTRY_AUTH_TOKEN: { kind: 'token', service: 'Sentry', prefix: 'sntryu_', how: 'crumbco.sentry.io › User settings › Personal tokens · project:releases is enough' },
};
/** Values set, replaced or removed here, by `${userId}:${projectId}:${name}`: when it was last set, or null once removed. */
export const valueStates = createStore<Readonly<Record<string, { set: boolean; updated: string }>>>(Object.fromEntries(
  Object.entries(PERSONAL_VALUES).flatMap(([userId, values]) => values.map((value) => [`${userId}:${value.projectId}:${value.name}`, { set: value.set, updated: value.updated }]))));

/** Machines added here, and changes to any machine: notes, whether agents may attach, and (team machines) which projects
 * may use it. */
export const addedMachines = createStore<readonly Machine[]>([]);
export interface MachineEdit { notes?: string; attach?: boolean; projects?: readonly string[]; os?: string }
export const machineEdits = createStore<Readonly<Record<string, MachineEdit>>>({});

/** The team SSH key, live: rotating it makes a new one and keeps the old until it is retired. */
export interface TeamKey { name: string; fingerprint: string; created: string; registered: readonly string[]; previous: string | null }
export const teamKey = createStore<TeamKey>({ name: 'crumb-team', fingerprint: TEAM_SSH_KEY.fingerprint, created: TEAM_SSH_KEY.created, registered: TEAM_SSH_KEY.registered, previous: null });
