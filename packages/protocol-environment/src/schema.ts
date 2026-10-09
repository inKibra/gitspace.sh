import { z } from 'zod';
import { EnvironmentError, EnvironmentFailureSchema } from './errors.js';

const identifierSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u);
const environmentNameSchema = z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u);

export const BrowserOriginPatternSchema = z.string().refine((pattern) => {
  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  return pattern === '*' || browserOriginMatches(host, host);
}, { message: 'Use a lowercase hostname, *.hostname, or *; URLs, paths, and ports are not allowed' });

export function browserOriginMatches(pattern: string, hostname: string): boolean {
  const validHost = (value: string): boolean => value.length > 0 && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(value);
  if (pattern !== '*' && !validHost(pattern.startsWith('*.') ? pattern.slice(2) : pattern)) return false;
  const host = hostname.toLowerCase();
  if (!validHost(host)) return false;
  if (pattern === '*') return true;
  return pattern.startsWith('*.') ? host.endsWith(`.${pattern.slice(2)}`) : host === pattern;
}

export async function browserOriginHash(pattern: string): Promise<string> {
  const canonical = BrowserOriginPatternSchema.parse(pattern);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`gitspace:browser-origin:v1\n${canonical}`)));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const BuiltInCheckDefinitionSchema = z.object({
  kind: z.literal('built-in'),
  check: identifierSchema,
  label: z.string().min(1).max(120).optional(),
  requirement: z.string().min(1).max(120).optional(),
}).strict();

export const CommandCheckDefinitionSchema = z.object({
  kind: z.literal('command'),
  command: z.string().min(1).max(4_096),
  label: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  installUrl: z.string().max(2_048).optional(),
  confirmPrompt: z.string().max(500).optional(),
}).strict();

export const EnvironmentCheckDefinitionSchema = z.discriminatedUnion('kind', [
  BuiltInCheckDefinitionSchema,
  CommandCheckDefinitionSchema,
]);

export const EnvironmentValueDefinitionSchema = z.object({
  default: z.string().max(16_384).optional(),
  description: z.string().max(500).optional(),
  required: z.boolean().optional(),
}).strict();

export const EnvironmentProfileSchema = z.object({
  checks: z.array(identifierSchema).max(128).default([]),
  secrets: z.array(environmentNameSchema).max(128).default([]),
  values: z.array(environmentNameSchema).max(128).default([]),
  notes: z.string().max(2_000).optional(),
}).strict();

const secretLikeName = /secret|password|token|credential|private.?key|api.?key/iu;
const credentialMaterial = /-----BEGIN .*PRIVATE KEY-----|:\/\/[^/\s:@]+:[^/\s@]+@|[?&](?:token|password|secret|api[_-]?key)=|\b(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/iu;

/** Checkout-relative (`node_modules/.bin`) or home-relative (`~/.cargo/bin`) directory; never absolute or escaping. */
export const BundleTerminalPathSchema = z.string().min(1).max(1_024).refine((entry) => {
  if (/[:\0\\]/u.test(entry)) return false;
  const relativePath = entry.startsWith('~/') ? entry.slice(2) : entry;
  return relativePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('~'));
}, { message: 'Use a checkout-relative path or ~/path without empty, ., .., or absolute segments' });

export const BundleTerminalSectionSchema = z.object({
  path: z.array(BundleTerminalPathSchema).max(64).optional(),
  env: z.record(z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string().max(16_384)).superRefine((env, context) => {
    for (const [name, value] of Object.entries(env)) {
      if (name === 'PATH') context.addIssue({ code: 'custom', path: [name], message: 'Set PATH entries with terminal.path' });
      else if (name.startsWith('GITSPACE_')) context.addIssue({ code: 'custom', path: [name], message: 'GITSPACE_ environment names are reserved' });
      else if (secretLikeName.test(name) || credentialMaterial.test(value)) context.addIssue({ code: 'custom', path: [name], message: 'Terminal env holds plain values; declare secrets in profiles' });
    }
  }).optional(),
}).strict();

export type BundleTerminalSection = z.infer<typeof BundleTerminalSectionSchema>;

export const EnvironmentBundleSchema = z.object({
  version: z.literal(1),
  defaultProfile: identifierSchema.default('base'),
  profiles: z.record(identifierSchema, EnvironmentProfileSchema),
  checks: z.record(identifierSchema, EnvironmentCheckDefinitionSchema).default({}),
  values: z.record(environmentNameSchema, EnvironmentValueDefinitionSchema).default({}),
  browser: z.object({ origins: z.array(BrowserOriginPatternSchema).max(256).default([]) }).strict().default({ origins: [] }),
  terminal: BundleTerminalSectionSchema.optional(),
}).strict().superRefine((bundle, context) => {
  if (!bundle.profiles.base) context.addIssue({ code: 'custom', path: ['profiles', 'base'], message: 'A reserved base profile is required' });
  if (!bundle.profiles[bundle.defaultProfile]) context.addIssue({ code: 'custom', path: ['defaultProfile'], message: 'Default profile must exist' });
  for (const [profileName, profile] of Object.entries(bundle.profiles)) {
    for (const check of profile.checks) {
      if (!bundle.checks[check]) context.addIssue({ code: 'custom', path: ['profiles', profileName, 'checks'], message: `Unknown check: ${check}` });
    }
    for (const value of profile.values) {
      if (!bundle.values[value]) context.addIssue({ code: 'custom', path: ['profiles', profileName, 'values'], message: `Unknown value: ${value}` });
    }
  }
  for (const name of Object.keys(bundle.terminal?.env ?? {})) {
    if (bundle.values[name] || Object.values(bundle.profiles).some((profile) => profile.secrets.includes(name))) {
      context.addIssue({ code: 'custom', path: ['terminal', 'env', name], message: `Terminal env cannot redefine declared value or secret: ${name}` });
    }
  }
});

export type EnvironmentBundle = z.infer<typeof EnvironmentBundleSchema>;
export type EnvironmentCheckDefinition = z.infer<typeof EnvironmentCheckDefinitionSchema>;
export type EnvironmentProfile = z.infer<typeof EnvironmentProfileSchema>;
export type EnvironmentValueDefinition = z.infer<typeof EnvironmentValueDefinitionSchema>;

/** The message names each schema problem by its bundle path, so an editor can point at what to fix. */
export function loadEnvironmentBundle(source: unknown): EnvironmentBundle {
  const parsed = EnvironmentBundleSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.reduce<string>((text, segment) => typeof segment === 'number' ? `${text}[${segment}]` : text ? `${text}.${String(segment)}` : String(segment), '');
    return `${path || 'bundle'}: ${issue.message}`;
  });
  const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : '';
  throw new EnvironmentError('InvalidBundle', `Environment bundle is invalid: ${problems.slice(0, 3).join('; ')}${more}`, { detail: parsed.error.message });
}

export function parseEnvironmentBundleJson(json: string): EnvironmentBundle {
  let source: unknown;
  try { source = JSON.parse(json); } catch { throw new EnvironmentError('InvalidBundle', 'Environment bundle is not valid JSON'); }
  return loadEnvironmentBundle(source);
}

/** Lenient read for command environments: a missing, malformed, or invalid bundle contributes nothing. */
export function bundleTerminalSection(json: string | null): BundleTerminalSection | null {
  if (json === null) return null;
  let source: unknown;
  try { source = JSON.parse(json); } catch { return null; }
  const parsed = EnvironmentBundleSchema.safeParse(source);
  return parsed.success ? parsed.data.terminal ?? null : null;
}

/** Full environment for a checkout command: bundle `terminal.path` (absolute, in order) prepended to inherited PATH, plus `terminal.env`. */
export function terminalEnvironment(input: { checkoutRoot: string; home: string; inherited: Record<string, string>; bundle: BundleTerminalSection | null }): Record<string, string> {
  const environment = { ...input.inherited, ...input.bundle?.env };
  const entries = (input.bundle?.path ?? []).map((entry) => entry.startsWith('~/')
    ? `${input.home.replace(/\/+$/u, '')}/${entry.slice(2)}`
    : `${input.checkoutRoot.replace(/\/+$/u, '')}/${entry}`);
  if (entries.length > 0) environment.PATH = [...new Set([...entries, ...(input.inherited.PATH ?? '').split(':').filter(Boolean)])].join(':');
  return environment;
}

export interface EffectiveEnvironmentProfile {
  name: string;
  checks: readonly string[];
  secrets: readonly string[];
  values: readonly string[];
  notes: readonly string[];
}


export function resolveEnvironmentProfile(bundle: EnvironmentBundle, selectedProfile: string): EffectiveEnvironmentProfile {
  const base = bundle.profiles.base;
  const selected = bundle.profiles[selectedProfile];
  if (!base) throw new EnvironmentError('InvalidConfiguration', 'Environment bundle has no base profile');
  if (!selected) throw new EnvironmentError('InvalidConfiguration', `Unknown environment profile: ${selectedProfile}`);
  if (selectedProfile === 'base') {
    return { name: 'base', checks: base.checks, secrets: base.secrets, values: base.values, notes: base.notes ? [base.notes] : [] };
  }
  return {
    name: selectedProfile,
    checks: [...new Set([...base.checks, ...selected.checks])],
    secrets: [...new Set([...base.secrets, ...selected.secrets])],
    values: [...new Set([...base.values, ...selected.values])],
    notes: [base.notes, selected.notes].filter((note): note is string => !!note),
  };
}

export interface LifecycleScriptSelection {
  fileName: string;
  profile: 'base' | string;
}

const lifecycleScriptSchema = /^(?<order>\d+)-(?<name>[a-z0-9][a-z0-9-]*)(?:\.(?<profile>[a-z][a-z0-9-]*))?\.sh$/u;

export function classifyLifecycleScript(fileName: string, profileNames: ReadonlySet<string>): LifecycleScriptSelection {
  const match = lifecycleScriptSchema.exec(fileName);
  if (!match?.groups) throw new EnvironmentError('InvalidConfiguration', `Invalid lifecycle script name: ${fileName}`);
  const profile = match.groups.profile;
  if (profile && !profileNames.has(profile)) throw new EnvironmentError('InvalidConfiguration', `Unknown lifecycle script profile "${profile}" in ${fileName}`);
  return { fileName, profile: profile ?? 'base' };
}

export function selectLifecycleScripts(fileNames: readonly string[], selectedProfile: string, profileNames: ReadonlySet<string>): readonly LifecycleScriptSelection[] {
  if (!profileNames.has(selectedProfile)) throw new EnvironmentError('InvalidConfiguration', `Unknown environment profile: ${selectedProfile}`);
  return fileNames
    .map((fileName) => classifyLifecycleScript(fileName, profileNames))
    .filter((script) => script.profile === 'base' || script.profile === selectedProfile)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export type ApprovalSource = 'project' | 'workspace';

export function resolveExecutionApproval(input: {
  executionHash: string;
  projectApprovals: ReadonlySet<string>;
  workspaceApprovals: ReadonlySet<string>;
}): ApprovalSource | null {
  if (input.projectApprovals.has(input.executionHash)) return 'project';
  if (input.workspaceApprovals.has(input.executionHash)) return 'workspace';
  return null;
}

export function resolveEnvironmentValues(input: {
  global: Readonly<Record<string, string>>;
  project: Readonly<Record<string, string>>;
  workspace: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  return { ...input.global, ...input.project, ...input.workspace };
}

export async function executionHash(payload: { kind: 'check' | 'script'; command: string }): Promise<string> {
  const encoded = new TextEncoder().encode(`${payload.kind}\n${payload.command}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const LifecyclePhaseSchema = z.enum([
  'cloud/provision', 'machine/prepare', 'workspace/materialize', 'workspace/dematerialize', 'cloud/destroy',
]);
export const LifecycleRunPhaseSchema = z.enum(['checks', ...LifecyclePhaseSchema.options]);
export type LifecyclePhase = z.infer<typeof LifecyclePhaseSchema>;
export type LifecycleRunPhase = z.infer<typeof LifecycleRunPhaseSchema>;
const lifecycleIdSchema = z.string().min(1).max(160);
export const LifecycleRunRequestSchema = z.object({
  runId: z.string().min(1).max(128), phase: LifecycleRunPhaseSchema, rerun: z.boolean().optional(), deadlineAt: z.string().datetime().optional(),
  interactive: z.boolean().optional(),
}).strict();
export type LifecycleRunRequest = z.infer<typeof LifecycleRunRequestSchema>;
export function parseLifecycleRunRequest(source: unknown): LifecycleRunRequest {
  const parsed = LifecycleRunRequestSchema.safeParse(source);
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'Invalid lifecycle run request', { detail: parsed.error.message });
  if (parsed.data.phase === 'checks' && parsed.data.interactive) throw new EnvironmentError('InvalidConfiguration', 'Environment checks cannot run interactively');
  return parsed.data;
}
const executionHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const lifecycleValuesSchema = z.record(environmentNameSchema, z.string().max(16_384));
const lifecycleResultsSchema = z.array(z.object({
  id: lifecycleIdSchema, exitCode: z.number().int().nullable(), output: z.string().max(524_288),
  startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().nullable().optional(),
}).strict()).max(128);
export const LifecycleExecutionSchema = z.object({
  id: lifecycleIdSchema, kind: z.enum(['check', 'script']), label: z.string().max(256),
  command: z.string().max(65_536), hash: executionHashSchema, phase: LifecyclePhaseSchema.nullable(),
  fileName: z.string().max(512).nullable(), content: z.string().max(131_072),
}).strict();
export type LifecycleExecution = z.infer<typeof LifecycleExecutionSchema>;

/** Bindings are resource identifiers or secret references, never credential material. */
export const LifecycleBindingsSchema = z.record(
  z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
  z.string().max(4_096),
).superRefine((bindings, context) => {
  for (const [name, value] of Object.entries(bindings)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)
      || (secretLikeName.test(name) && !/^secret:[A-Z][A-Z0-9_]*$/u.test(value))
      || credentialMaterial.test(value)) {
      context.addIssue({ code: 'custom', path: [name], message: 'Bindings must contain non-secret resource identifiers or secret:NAME references' });
    }
  }
});

export function parseLifecycleBindingsJson(source: string, secrets: readonly string[]): Record<string, string> {
  if (source.length > 65_536) throw new EnvironmentError('InvalidConfiguration', 'Lifecycle output exceeds 64 KiB');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new EnvironmentError('InvalidConfiguration', 'Lifecycle output is not valid JSON'); }
  if (!value || typeof value !== 'object' || !('bindings' in value)) throw new EnvironmentError('InvalidConfiguration', 'Lifecycle output must be JSON {bindings:Record<string,string>}');
  const parsed = LifecycleBindingsSchema.safeParse(value.bindings);
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'Lifecycle bindings must be non-secret resource identifiers', { detail: parsed.error.message });
  for (const [name, binding] of Object.entries(parsed.data)) {
    if (!/^secret:[A-Z][A-Z0-9_]*$/u.test(binding) && secrets.some((secret) => secret && binding.includes(secret))) throw new EnvironmentError('InvalidConfiguration', `Lifecycle binding ${name} must use a secret:NAME reference, not a credential`, { name });
  }
  return parsed.data;
}
export const LifecycleApprovalSchema = z.object({
  scope: z.enum(['project', 'workspace']), executionHash: executionHashSchema,
  approvedBy: lifecycleIdSchema, approvedAt: z.string(),
}).strict();
export const LifecycleIncidentSchema = z.object({
  id: lifecycleIdSchema, kind: z.enum(['domain', 'transport']), message: z.string(), occurredAt: z.string().datetime(),
  failure: EnvironmentFailureSchema.nullable(),
}).strict();
export type LifecycleIncident = z.infer<typeof LifecycleIncidentSchema>;
export const LifecycleAttachmentSchema = z.object({ attachmentId: lifecycleIdSchema, generation: z.number().int().nonnegative() }).strict();
export const LifecycleRunSchema = z.object({
  id: lifecycleIdSchema, projectId: lifecycleIdSchema, spaceId: lifecycleIdSchema,
  phase: LifecycleRunPhaseSchema, status: z.enum(['accepted', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted']),
  interactive: z.boolean().optional(),
  profile: identifierSchema, machineId: lifecycleIdSchema, generation: z.number().int().nonnegative().nullable(),
  attachment: LifecycleAttachmentSchema.optional(),
  bindings: LifecycleBindingsSchema.optional(),
  executionHashes: z.array(executionHashSchema).max(128), terminalName: z.string().nullable(),
  results: lifecycleResultsSchema, output: z.string(), exitCode: z.number().int().nullable(),
  startedAt: z.string(), finishedAt: z.string().nullable(),
  deadlineAt: z.string().datetime(), cancelRequestedAt: z.string().nullable(), failure: EnvironmentFailureSchema.nullable(),
  incidents: z.array(LifecycleIncidentSchema),
}).strict();
export const LifecycleStateSchema = z.object({
  revision: z.number().int().nonnegative(), projectId: lifecycleIdSchema, spaceId: lifecycleIdSchema,
  bundleJson: z.string().nullable(), selectedProfile: identifierSchema.nullable(),
  executions: z.array(LifecycleExecutionSchema).max(256),
  browserOrigins: z.array(z.object({ pattern: BrowserOriginPatternSchema, hash: executionHashSchema }).strict()).max(256).default([]),
  values: z.object({ global: lifecycleValuesSchema, project: lifecycleValuesSchema, workspace: lifecycleValuesSchema }).strict(),
  approvals: z.array(LifecycleApprovalSchema), policy: z.object({ automatic: z.boolean() }).strict(),
  bindings: LifecycleBindingsSchema,
  provisioned: z.object({
    runId: lifecycleIdSchema, profile: identifierSchema, executionHashes: z.array(executionHashSchema),
    machineId: lifecycleIdSchema, completedAt: z.string(),
  }).strict().nullable(),
  destroyedAt: z.string().nullable(), runs: z.array(LifecycleRunSchema),
  claim: z.object({
    runId: lifecycleIdSchema, status: z.enum(['claimed', 'existing', 'skipped', 'blocked']),
    reason: z.string().nullable(), token: z.string().nullable(),
  }).strict().nullable(),
}).strict();
export const LifecycleMutationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('configure'), bundleJson: z.string().max(262_144), executions: z.array(LifecycleExecutionSchema).max(256).optional() }).strict(),
  z.object({ op: z.literal('profile'), profile: identifierSchema }).strict(),
  z.object({ op: z.literal('value'), scope: z.enum(['global', 'project', 'workspace']), name: environmentNameSchema, value: z.string().max(16_384).nullable() }).strict(),
  z.object({ op: z.literal('approval'), scope: z.enum(['project', 'workspace']), executionHash: executionHashSchema, approved: z.boolean() }).strict(),
  z.object({ op: z.literal('policy'), automatic: z.boolean() }).strict(),
  z.object({
    op: z.literal('claim'), runId: lifecycleIdSchema, phase: LifecycleRunPhaseSchema, profile: identifierSchema,
    executionHashes: z.array(executionHashSchema).max(128), generation: z.number().int().nonnegative().nullable(),
    attachment: LifecycleAttachmentSchema.optional(),
    rerun: z.boolean(), deadlineAt: z.string().datetime().optional(), terminalName: z.string().max(256).nullable().optional(),
    interactive: z.boolean().optional(),
    ownershipToken: lifecycleIdSchema.optional(),
  }).strict(),
  z.object({ op: z.literal('append'), runId: lifecycleIdSchema, token: lifecycleIdSchema, output: z.string().max(524_288), results: lifecycleResultsSchema.optional(), bindings: LifecycleBindingsSchema.optional(), incidents: z.array(LifecycleIncidentSchema).optional() }).strict(),
  z.object({
    op: z.literal('finish'), runId: lifecycleIdSchema, token: lifecycleIdSchema, status: z.enum(['succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted']),
    incidents: z.array(LifecycleIncidentSchema).optional(),
    failure: EnvironmentFailureSchema.optional(), exitCode: z.number().int(), results: lifecycleResultsSchema, output: z.string().max(524_288), bindings: LifecycleBindingsSchema,
  }).strict(),
  z.object({ op: z.literal('start'), runId: lifecycleIdSchema, token: lifecycleIdSchema }).strict(),
  z.object({ op: z.literal('incidents'), runId: lifecycleIdSchema, incidents: z.array(LifecycleIncidentSchema) }).strict(),
  z.object({ op: z.literal('cancel'), runId: lifecycleIdSchema }).strict(),
  z.object({ op: z.literal('abandon'), runId: lifecycleIdSchema }).strict(),
]);
export type LifecycleMutation = z.infer<typeof LifecycleMutationSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type EnvironmentValueScope = Extract<LifecycleMutation, { op: 'value' }>['scope'];
export type EnvironmentApprovalScope = Extract<LifecycleMutation, { op: 'approval' }>['scope'];
export type LifecycleRun = z.infer<typeof LifecycleRunSchema>;
export interface LifecycleRunLog { output: string; nextOffset: number | null; cursor: number }
export interface EnvironmentLifecycleAuthority {
  getLifecycleState(projectId: string, spaceId: string): Promise<LifecycleState>;
  mutateLifecycleState(projectId: string, spaceId: string, input: LifecycleMutation): Promise<LifecycleState>;
  getLifecycleRunLog(projectId: string, spaceId: string, runId: string, offset?: number): Promise<LifecycleRunLog>;
  watchLifecycleState(projectId: string, spaceId: string, onState: (state: LifecycleState) => void, signal: AbortSignal, onFailure?: (error: unknown) => Promise<void>): Promise<void>;
}
