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
