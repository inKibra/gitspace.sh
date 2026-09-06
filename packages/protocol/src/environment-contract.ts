import { z } from 'zod';

const identifierSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u);
const environmentNameSchema = z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u);

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
}).strict();

export const EnvironmentCheckDefinitionSchema = z.discriminatedUnion('kind', [
  BuiltInCheckDefinitionSchema,
  CommandCheckDefinitionSchema,
]);

export const EnvironmentValueDefinitionSchema = z.object({
  default: z.string().max(16_384).optional(),
  description: z.string().max(500).optional(),
}).strict();

export const EnvironmentProfileSchema = z.object({
  checks: z.array(identifierSchema).max(128).default([]),
  secrets: z.array(environmentNameSchema).max(128).default([]),
  values: z.array(environmentNameSchema).max(128).default([]),
  notes: z.string().max(2_000).optional(),
}).strict();

export const EnvironmentBundleSchema = z.object({
  version: z.literal(1),
  defaultProfile: identifierSchema.default('base'),
  profiles: z.record(identifierSchema, EnvironmentProfileSchema),
  checks: z.record(identifierSchema, EnvironmentCheckDefinitionSchema).default({}),
  values: z.record(environmentNameSchema, EnvironmentValueDefinitionSchema).default({}),
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
});

export type EnvironmentBundle = z.infer<typeof EnvironmentBundleSchema>;
export type EnvironmentCheckDefinition = z.infer<typeof EnvironmentCheckDefinitionSchema>;
export type EnvironmentProfile = z.infer<typeof EnvironmentProfileSchema>;
export type EnvironmentValueDefinition = z.infer<typeof EnvironmentValueDefinitionSchema>;

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
  if (!base) throw new Error('Environment bundle has no base profile');
  if (!selected) throw new Error(`Unknown environment profile: ${selectedProfile}`);
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
  if (!match?.groups) throw new Error(`Invalid lifecycle script name: ${fileName}`);
  const profile = match.groups.profile;
  if (profile && !profileNames.has(profile)) throw new Error(`Unknown lifecycle script profile "${profile}" in ${fileName}`);
  return { fileName, profile: profile ?? 'base' };
}

export function selectLifecycleScripts(fileNames: readonly string[], selectedProfile: string, profileNames: ReadonlySet<string>): readonly LifecycleScriptSelection[] {
  if (!profileNames.has(selectedProfile)) throw new Error(`Unknown environment profile: ${selectedProfile}`);
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
const executionHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const lifecycleValuesSchema = z.record(environmentNameSchema, z.string().max(16_384));
const lifecycleResultsSchema = z.array(z.object({ id: lifecycleIdSchema, exitCode: z.number().int(), output: z.string().max(524_288) }).strict()).max(128);
export const LifecycleExecutionSchema = z.object({
  id: lifecycleIdSchema, kind: z.enum(['check', 'script']), label: z.string().max(256),
  command: z.string().max(65_536), hash: executionHashSchema, phase: LifecyclePhaseSchema.nullable(),
  fileName: z.string().max(512).nullable(), content: z.string().max(131_072),
}).strict();

/** Bindings are resource identifiers or secret references, never credential material. */
export const LifecycleBindingsSchema = z.record(
  z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
  z.string().max(4_096),
).superRefine((bindings, context) => {
  for (const [name, value] of Object.entries(bindings)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)
      || (/secret|password|token|credential|private.?key|api.?key/iu.test(name) && !/^secret:[A-Z][A-Z0-9_]*$/u.test(value))
      || /-----BEGIN .*PRIVATE KEY-----|:\/\/[^/\s:@]+:[^/\s@]+@|[?&](?:token|password|secret|api[_-]?key)=|\b(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/iu.test(value)) {
      context.addIssue({ code: 'custom', path: [name], message: 'Bindings must contain non-secret resource identifiers or secret:NAME references' });
    }
  }
});
export const LifecycleApprovalSchema = z.object({
  scope: z.enum(['project', 'workspace']), executionHash: executionHashSchema,
  approvedBy: lifecycleIdSchema, approvedAt: z.string(),
}).strict();
export const LifecycleRunSchema = z.object({
  id: lifecycleIdSchema, projectId: lifecycleIdSchema, spaceId: lifecycleIdSchema,
  phase: LifecycleRunPhaseSchema, status: z.enum(['running', 'succeeded', 'failed', 'abandoned']),
  profile: identifierSchema, machineId: lifecycleIdSchema, generation: z.number().int().nonnegative().nullable(),
  executionHashes: z.array(executionHashSchema).max(128), terminalName: z.string().nullable(),
  results: lifecycleResultsSchema, output: z.string(), exitCode: z.number().int().nullable(),
  startedAt: z.string(), finishedAt: z.string().nullable(),
}).strict();
export const LifecycleStateSchema = z.object({
  revision: z.number().int().nonnegative(), projectId: lifecycleIdSchema, spaceId: lifecycleIdSchema,
  bundleJson: z.string().nullable(), selectedProfile: identifierSchema.nullable(),
  executions: z.array(LifecycleExecutionSchema).max(256),
  values: z.object({ global: lifecycleValuesSchema, project: lifecycleValuesSchema, workspace: lifecycleValuesSchema }).strict(),
  approvals: z.array(LifecycleApprovalSchema), policy: z.object({ automatic: z.boolean() }).strict(),
  bindings: LifecycleBindingsSchema,
  provisioned: z.object({
    runId: lifecycleIdSchema, profile: identifierSchema, executionHashes: z.array(executionHashSchema),
    machineId: lifecycleIdSchema, completedAt: z.string(),
  }).strict().nullable(),
  destroyedAt: z.string().nullable(), runs: z.array(LifecycleRunSchema),
  claim: z.object({
    runId: lifecycleIdSchema, status: z.enum(['claimed', 'skipped', 'blocked']),
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
    rerun: z.boolean(), terminalName: z.string().max(256).nullable().optional(),
  }).strict(),
  z.object({ op: z.literal('append'), runId: lifecycleIdSchema, token: lifecycleIdSchema, output: z.string().max(524_288), bindings: LifecycleBindingsSchema.optional() }).strict(),
  z.object({
    op: z.literal('finish'), runId: lifecycleIdSchema, token: lifecycleIdSchema, status: z.enum(['succeeded', 'failed']),
    exitCode: z.number().int(), results: lifecycleResultsSchema, output: z.string().max(524_288), bindings: LifecycleBindingsSchema,
  }).strict(),
  z.object({ op: z.literal('abandon'), runId: lifecycleIdSchema }).strict(),
]);
export type LifecycleMutation = z.infer<typeof LifecycleMutationSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type LifecycleRun = z.infer<typeof LifecycleRunSchema>;
export interface LifecycleRunLog { output: string; nextOffset: number | null }
export interface EnvironmentLifecycleAuthority {
  getLifecycleState(projectId: string, spaceId: string): Promise<LifecycleState>;
  mutateLifecycleState(projectId: string, spaceId: string, input: LifecycleMutation): Promise<LifecycleState>;
  getLifecycleRunLog(projectId: string, spaceId: string, runId: string, offset?: number): Promise<LifecycleRunLog>;
}
