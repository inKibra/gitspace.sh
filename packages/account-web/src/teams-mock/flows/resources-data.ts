// What the resource pages' dialogs change while the mock is open: providers (the team's and each person's), local models
// on machines, inference profiles, budget policies, plugins and the team's Composio account, the Slack app's channels,
// browsers and skills. Each starts from the settings data and the pages read these stores,
// so a finished dialog shows up in its list. Also the catalogs the add dialogs pick from.
import { MACHINES, BROWSERS, MODEL_CREDENTIALS, PLUGINS, PROFILES, SKILLS, SLACK_APP, type Browser, type InferenceProfileMock, type ModelCredential, type Owner, type Plugin, type ProviderId, type Skill } from '../settings/data.js';
import { GITHUB_CLASSIC_TOKEN } from './token-shapes.js';
import { createStore } from '../store.js';

export const providers = createStore<readonly ModelCredential[]>(MODEL_CREDENTIALS);
export const profiles = createStore<readonly InferenceProfileMock[]>(PROFILES);
export const plugins = createStore<readonly Plugin[]>(PLUGINS);
export const browsers = createStore<readonly Browser[]>(BROWSERS);
export const skills = createStore<readonly Skill[]>(SKILLS);
/** Whether the team's Composio account is on. */
export const teamComposio = createStore(false);
export const slackChannels = createStore<ReadonlyArray<{ name: string; projects: readonly string[]; posts: string }>>(SLACK_APP.channels);

/** A model served by Ollama or LM Studio on a machine: no spend, used for the roles a profile maps to it. */
export interface LocalModel { id: string; label: string; owner: Owner; runtime: LocalRuntime; machineId: string; url: string; models: readonly string[]; profiles: readonly string[] }
export type LocalRuntime = 'Ollama' | 'LM Studio';
export const LOCAL_PORT: Readonly<Record<LocalRuntime, number>> = { Ollama: 11434, 'LM Studio': 1234 };
export const LOCAL_MODELS_FOUND: Readonly<Record<LocalRuntime, readonly string[]>> = {
  Ollama: ['qwen3-coder:32b', 'gpt-oss:20b', 'llama4-scout:17b', 'nomic-embed-text'],
  'LM Studio': ['qwen3-coder-30b-a3b-instruct', 'devstral-small-2507', 'gemma-3-27b-it'],
};
export const localModels = createStore<readonly LocalModel[]>([]);

/** What happens when a budget is reached, and who's told: set by the budget dialog, keyed by budget id. */
export interface BudgetPolicy { period: 'month' | 'week'; atLimit: 'warn' | 'stop'; notify: readonly string[] }
export const budgetPolicies = createStore<Readonly<Record<string, BudgetPolicy>>>({});
export const NOTIFY_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'owners', label: 'Owners' }, { id: 'admins', label: 'Admins' }, { id: 'leads', label: 'The project’s Leads' }, { id: 'person', label: 'The person or bot’s sponsor' }, { id: 'slack', label: 'Slack #releases' },
];

/** The models each provider offers in a profile (the real app's model picker lists these). */
export const MODELS_BY_PROVIDER: Readonly<Record<ProviderId | 'bedrock', readonly string[]>> = {
  anthropic: ['anthropic/claude-opus-5:max', 'anthropic/claude-opus-5:high', 'anthropic/claude-sonnet-5:medium', 'anthropic/claude-haiku-5'],
  bedrock: ['bedrock/claude-opus-5:high', 'bedrock/claude-sonnet-5:high', 'bedrock/claude-sonnet-5:medium', 'bedrock/claude-haiku-5'],
  openai: ['openai/gpt-6:high', 'openai/gpt-6:medium', 'openai/gpt-6-mini'],
  google: ['google/gemini-3-pro', 'google/gemini-3-flash'],
};
export const ROLES: ReadonlyArray<{ role: string; note: string }> = [
  { role: 'default', note: 'Every turn unless another role applies' }, { role: 'smol', note: 'Quick, cheap steps' }, { role: 'slow', note: 'Hard problems, on request' },
  { role: 'plan', note: 'Plan phase' }, { role: 'commit', note: 'Commit messages' }, { role: 'vision', note: 'Screenshots and images' }, { role: 'review', note: 'Review phase and Change Guides' },
];
/** The models a provider record offers. */
export function modelsOf(credential: ModelCredential): readonly string[] {
  return credential.via === 'Bedrock' ? MODELS_BY_PROVIDER.bedrock : MODELS_BY_PROVIDER[credential.provider];
}

/** The machines a person (or the team) can run a local model on. */
export function machinesOf(owner: Owner): typeof MACHINES {
  return MACHINES.filter((machine) => owner.scope === 'account' ? machine.owner.scope === 'account' : machine.owner.scope === 'user' && machine.owner.userId === owner.userId);
}

/** A plugin in the add dialogs' catalogs: how it can sign in, and what a token for it looks like. */
export interface CatalogEntry {
  id: string; name: string; detail: string; tab: 'composio' | 'mcp';
  /** Ways the team can sign it in; a person's always signs in as them. */
  auth: readonly TeamAuth[];
  site: string;
  tokenPrefix?: readonly string[];
  /** Scopes a team token must carry. */
  scopes?: readonly string[];
}
export type TeamAuth = 'oauth' | 'token' | 'none';
export const TEAM_AUTH_LABEL: Readonly<Record<TeamAuth, string>> = { oauth: 'Sign in as the team (OAuth app)', token: 'API token', none: 'No sign-in' };
export const TEAM_CATALOG: readonly CatalogEntry[] = [
  { id: 'github', name: 'GitHub', detail: 'Issues, pull requests and Actions across crumb-co', tab: 'mcp', auth: ['oauth', 'token'], site: 'github.com', tokenPrefix: ['github_pat_', GITHUB_CLASSIC_TOKEN], scopes: ['repo', 'read:org'] },
  { id: 'linear', name: 'Linear', detail: 'The team’s issues and cycles', tab: 'mcp', auth: ['oauth', 'token'], site: 'linear.app', tokenPrefix: ['lin_api_'] },
  { id: 'sentry', name: 'Sentry', detail: 'Errors and releases for crumb-co projects', tab: 'mcp', auth: ['token'], site: 'sentry.io', tokenPrefix: ['sntrys_'], scopes: ['project:read', 'event:read', 'org:read'] },
  { id: 'slack-app', name: 'Slack app', detail: 'GitSpace for Slack: posts to channels, answers @GitSpace', tab: 'mcp', auth: ['oauth'], site: 'slack.com' },
  { id: 'custom', name: 'Custom MCP server', detail: 'Any MCP server by its URL (Streamable HTTP)', tab: 'mcp', auth: ['oauth', 'token', 'none'], site: '' },
];
export const COMPOSIO_CATALOG: readonly CatalogEntry[] = [
  { id: 'gdrive', name: 'Google Drive', detail: 'Shared drives: invoices, menus, supplier sheets', tab: 'composio', auth: ['oauth'], site: 'accounts.google.com' },
  { id: 'hubspot', name: 'HubSpot', detail: 'Wholesale customers and deals', tab: 'composio', auth: ['oauth'], site: 'app.hubspot.com' },
  { id: 'gmail', name: 'Gmail', detail: 'orders@crumbco.example inbox, read only', tab: 'composio', auth: ['oauth'], site: 'accounts.google.com' },
];
export const PERSONAL_CATALOG: readonly CatalogEntry[] = [
  { id: 'slack', name: 'Slack', detail: 'Your channels and DMs; posts as you', tab: 'mcp', auth: ['oauth'], site: 'crumbco.slack.com' },
  { id: 'linear', name: 'Linear', detail: 'Issues assigned to you', tab: 'mcp', auth: ['oauth'], site: 'linear.app' },
  { id: 'figma', name: 'Figma', detail: 'Files you can open', tab: 'mcp', auth: ['oauth'], site: 'figma.com' },
  { id: 'github', name: 'GitHub', detail: 'As your GitHub account', tab: 'mcp', auth: ['oauth'], site: 'github.com' },
  { id: 'custom', name: 'Custom MCP server', detail: 'Any MCP server that signs you in with OAuth', tab: 'mcp', auth: ['oauth'], site: '' },
  { id: 'gdrive', name: 'Google Drive', detail: 'Your Drive, through Composio', tab: 'composio', auth: ['oauth'], site: 'accounts.google.com' },
  { id: 'gcal', name: 'Google Calendar', detail: 'Free/busy or full, through Composio', tab: 'composio', auth: ['oauth'], site: 'accounts.google.com' },
  { id: 'notion', name: 'Notion', detail: 'Pages you share with it, through Composio', tab: 'composio', auth: ['oauth'], site: 'notion.so' },
];

/** Kinds of a person's own secret the add dialog offers (each checked against its service before saving). */
export interface OwnSecretKind { id: 'db' | 'stripe' | 'appstore' | 'aws'; name: string; target: string; detail: string; scope: string; env: string }
export const OWN_SECRET_KINDS: readonly OwnSecretKind[] = [
  { id: 'db', name: 'Production database (read only)', target: 'crumb-prod read replica', detail: 'A Postgres connection string for a read-only role', scope: 'crumb-prod replica · read only', env: 'PROD_DATABASE_URL' },
  { id: 'stripe', name: 'Stripe live (restricted key)', target: 'api.stripe.com · live mode', detail: 'A restricted live key: refunds and charges read, nothing else', scope: 'Stripe live · charges and refunds read', env: 'STRIPE_LIVE_KEY' },
  { id: 'appstore', name: 'App Store Connect', target: 'appstoreconnect.apple.com', detail: 'An App Store Connect API key (.p8) to upload builds', scope: 'Crumb iOS · upload builds to TestFlight', env: 'ASC_KEY' },
  { id: 'aws', name: 'AWS SSO (production)', target: 'AWS SSO · crumb-prod', detail: 'Sign in through AWS IAM Identity Center; the session refreshes itself', scope: 'crumb-prod · ReadOnlyAccess', env: 'AWS_PROD_READONLY' },
];
