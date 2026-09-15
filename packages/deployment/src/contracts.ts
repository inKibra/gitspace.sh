import { ed25519 } from '@noble/curves/ed25519.js';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { z } from 'zod';

export const entrypointIdSchema = z.enum([
  'frontend',
  'machine-daemon',
  'omp-worker',
  'omp-broker',
  'offload-worker',
  'relay-worker',
  'relay-do',
  'platform-dispatch',
]);
export type EntrypointId = z.infer<typeof entrypointIdSchema>;

export const artifactSchema = z.object({
  entrypoint: entrypointIdSchema,
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  path: z.string().min(1),
  dependsOn: z.array(entrypointIdSchema).default([]),
});
export type DeploymentArtifact = z.infer<typeof artifactSchema>;

const targetSchema = z.object({
  environmentId: z.string().min(1),
  kind: z.enum(['sandbox', 'current']),
  expectedGeneration: z.string().min(1),
});
export type DeploymentTarget = z.infer<typeof targetSchema>;

const sourceSchema = z.object({
  projectId: z.string().min(1),
  revision: z.string().min(1),
  dirty: z.boolean(),
});
export type DeploymentSource = z.infer<typeof sourceSchema>;

const sandboxAuthoritySchema = z.object({
  kind: z.literal('sandbox'),
  environmentId: z.string().min(1),
});
const promotionAuthoritySchema = z.object({
  kind: z.literal('promotion'),
  rootPublicKey: z.string().min(1),
  signature: z.string().min(1),
});
const authoritySchema = z.discriminatedUnion('kind', [sandboxAuthoritySchema, promotionAuthoritySchema]);
export type DeploymentAuthority = z.infer<typeof authoritySchema>;

export const deploymentPlanSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^dep_[a-f0-9]{24}$/u),
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  source: sourceSchema,
  target: targetSchema,
  artifacts: z.array(artifactSchema).min(1),
  authority: authoritySchema,
  createdAt: z.string().datetime(),
});
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;

export interface DeploymentPlanInput {
  source: DeploymentSource;
  target: DeploymentTarget;
  candidateArtifacts: DeploymentArtifact[];
  currentHashes: Partial<Record<EntrypointId, string>>;
  authority:
    | { kind: 'sandbox'; environmentId: string }
    | { kind: 'promotion'; rootPublicKey: string; signingPrivateKey: Uint8Array };
  createdAt?: string;
}

export class InvalidDeploymentPlan extends TaggedError('InvalidDeploymentPlan')<{
  message: string;
}> {}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function sha256(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function affectedArtifacts(input: DeploymentPlanInput): ResultType<DeploymentArtifact[], InvalidDeploymentPlan> {
  const byEntrypoint = new Map(input.candidateArtifacts.map((artifact) => [artifact.entrypoint, artifact]));
  if (byEntrypoint.size !== input.candidateArtifacts.length) {
    return Result.err(new InvalidDeploymentPlan({ message: 'Candidate artifacts contain duplicate entrypoints' }));
  }
  for (const artifact of input.candidateArtifacts) {
    for (const dependency of artifact.dependsOn) {
      if (!byEntrypoint.has(dependency) && input.currentHashes[dependency] === undefined) {
        return Result.err(new InvalidDeploymentPlan({ message: `${artifact.entrypoint} depends on unknown ${dependency}` }));
      }
    }
  }

  const affected = new Set<EntrypointId>();
  for (const artifact of input.candidateArtifacts) {
    if (input.currentHashes[artifact.entrypoint] !== artifact.hash) affected.add(artifact.entrypoint);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const artifact of input.candidateArtifacts) {
      if (!affected.has(artifact.entrypoint) && artifact.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(artifact.entrypoint);
        expanded = true;
      }
    }
  }
  if (affected.size === 0) return Result.err(new InvalidDeploymentPlan({ message: 'Candidate does not change any entrypoint' }));

  const ordered: DeploymentArtifact[] = [];
  const visiting = new Set<EntrypointId>();
  const visited = new Set<EntrypointId>();
  const visit = (entrypoint: EntrypointId): boolean => {
    if (visited.has(entrypoint) || !affected.has(entrypoint)) return true;
    if (visiting.has(entrypoint)) return false;
    visiting.add(entrypoint);
    const artifact = byEntrypoint.get(entrypoint)!;
    for (const dependency of artifact.dependsOn) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(entrypoint);
    visited.add(entrypoint);
    ordered.push(artifact);
    return true;
  };
  for (const entrypoint of [...affected].sort()) {
    if (!visit(entrypoint)) return Result.err(new InvalidDeploymentPlan({ message: 'Entrypoint dependency graph contains a cycle' }));
  }
  return Result.ok(ordered);
}

function unsignedPlanPayload(input: {
  source: DeploymentSource;
  target: DeploymentTarget;
  artifacts: DeploymentArtifact[];
  authority: { kind: 'sandbox'; environmentId: string } | { kind: 'promotion'; rootPublicKey: string };
  createdAt: string;
}) {
  return {
    version: 1 as const,
    source: input.source,
    target: input.target,
    artifacts: input.artifacts,
    authority: input.authority,
    createdAt: input.createdAt,
  };
}

export async function createDeploymentPlan(
  input: DeploymentPlanInput,
): Promise<ResultType<DeploymentPlan, InvalidDeploymentPlan>> {
  const source = sourceSchema.safeParse(input.source);
  const target = targetSchema.safeParse(input.target);
  const candidates = z.array(artifactSchema).safeParse(input.candidateArtifacts);
  if (!source.success || !target.success || !candidates.success) {
    return Result.err(new InvalidDeploymentPlan({ message: 'Deployment source, target, or artifacts are invalid' }));
  }
  if (input.authority.kind === 'sandbox' && input.authority.environmentId !== target.data.environmentId) {
    return Result.err(new InvalidDeploymentPlan({ message: 'Sandbox authority does not match target environment' }));
  }
  if (target.data.kind === 'current' && input.authority.kind !== 'promotion') {
    return Result.err(new InvalidDeploymentPlan({ message: 'Current environment replacement requires promotion authority' }));
  }
  if (target.data.kind === 'sandbox' && input.authority.kind !== 'sandbox') {
    return Result.err(new InvalidDeploymentPlan({ message: 'Sandbox replacement requires sandbox authority' }));
  }

  const ordered = affectedArtifacts({ ...input, source: source.data, target: target.data, candidateArtifacts: candidates.data });
  if (ordered.status === 'error') return ordered;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const unsignedAuthority = input.authority.kind === 'sandbox'
    ? { kind: 'sandbox' as const, environmentId: input.authority.environmentId }
    : { kind: 'promotion' as const, rootPublicKey: input.authority.rootPublicKey };
  const unsigned = unsignedPlanPayload({
    source: source.data,
    target: target.data,
    artifacts: ordered.value,
    authority: unsignedAuthority,
    createdAt,
  });
  const planHash = await sha256(unsigned);
  const authority: DeploymentAuthority = input.authority.kind === 'sandbox'
    ? { kind: 'sandbox', environmentId: input.authority.environmentId }
    : {
        kind: 'promotion',
        rootPublicKey: input.authority.rootPublicKey,
        signature: bytesToBase64(ed25519.sign(new TextEncoder().encode(planHash), input.authority.signingPrivateKey)),
      };
  const plan: DeploymentPlan = {
    ...unsigned,
    id: `dep_${planHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    planHash,
    authority,
  };
  const parsed = deploymentPlanSchema.safeParse(plan);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(new InvalidDeploymentPlan({ message: z.prettifyError(parsed.error) }));
}

export async function verifyDeploymentPlan(plan: DeploymentPlan): Promise<ResultType<DeploymentPlan, InvalidDeploymentPlan>> {
  const parsed = deploymentPlanSchema.safeParse(plan);
  if (!parsed.success) return Result.err(new InvalidDeploymentPlan({ message: z.prettifyError(parsed.error) }));
  const unsignedAuthority = plan.authority.kind === 'sandbox'
    ? plan.authority
    : { kind: 'promotion' as const, rootPublicKey: plan.authority.rootPublicKey };
  const expectedHash = await sha256(unsignedPlanPayload({
    source: plan.source,
    target: plan.target,
    artifacts: plan.artifacts,
    authority: unsignedAuthority,
    createdAt: plan.createdAt,
  }));
  if (expectedHash !== plan.planHash || plan.id !== `dep_${expectedHash.slice('sha256:'.length, 'sha256:'.length + 24)}`) {
    return Result.err(new InvalidDeploymentPlan({ message: 'Deployment plan hash does not match immutable contents' }));
  }
  if (plan.authority.kind === 'sandbox') {
    return plan.target.kind === 'sandbox' && plan.authority.environmentId === plan.target.environmentId
      ? Result.ok(plan)
      : Result.err(new InvalidDeploymentPlan({ message: 'Sandbox authority does not match target' }));
  }
  try {
    const valid = ed25519.verify(
      base64ToBytes(plan.authority.signature),
      new TextEncoder().encode(plan.planHash),
      base64ToBytes(plan.authority.rootPublicKey),
    );
    return valid
      ? Result.ok(plan)
      : Result.err(new InvalidDeploymentPlan({ message: 'Promotion signature is invalid' }));
  } catch {
    return Result.err(new InvalidDeploymentPlan({ message: 'Promotion signature or root key is malformed' }));
  }
}
