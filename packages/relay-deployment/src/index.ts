import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { z } from 'zod';

const migrationSchema = z.object({
  tag: z.string().min(1).max(64),
  newSqliteClasses: z.array(z.string().min(1).max(128)).default([]),
  deletedClasses: z.array(z.string().min(1).max(128)).default([]),
  renamedClasses: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default([]),
});

export const relayDeploymentManifestSchema = z.object({
  version: z.literal(1),
  workerName: z.string().min(1).max(63),
  mainModule: z.string().min(1),
  bundleHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  compatibilityDate: z.iso.date(),
  compatibilityFlags: z.array(z.string()).default(['nodejs_compat']),
  relayBinding: z.string().min(1).default('RELAY'),
  relayClass: z.string().min(1).default('UserRelayDO'),
  relayName: z.string().min(1).default('default'),
  authPublicKey: z.string().min(1),
  authMaxSkewMs: z.number().int().positive(),
  tunnelHeaderTimeoutMs: z.number().int().positive(),
  tunnelIdleTimeoutMs: z.number().int().positive(),
  cpuMs: z.number().int().positive(),
  subRequests: z.number().int().positive(),
  migrations: z.array(migrationSchema).min(1),
});
export type RelayDeploymentManifest = z.infer<typeof relayDeploymentManifestSchema>;

export class InvalidRelayDeployment extends TaggedError('InvalidRelayDeployment')<{
  message: string;
}> {}

export class UnknownMigrationTag extends TaggedError('UnknownMigrationTag')<{
  tag: string;
  message: string;
}> {}

export interface StandaloneWranglerConfig {
  $schema: string;
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{
    tag: string;
    new_sqlite_classes?: string[];
    deleted_classes?: string[];
    renamed_classes?: Array<{ from: string; to: string }>;
  }>;
  vars: Record<string, string | number>;
  limits: { cpu_ms: number; subrequests: number };
  observability: { enabled: true; head_sampling_rate: 1 };
}

export interface WfpUploadMetadata {
  main_module: string;
  bindings: Array<
    | { name: string; type: 'durable_object_namespace'; class_name: string }
    | { name: string; type: 'plain_text'; text: string }
  >;
  migrations?: {
    old_tag?: string;
    new_tag: string;
    steps: Array<{
      new_sqlite_classes?: string[];
      deleted_classes?: string[];
      renamed_classes?: Array<{ from: string; to: string }>;
    }>;
  };
  limits: { cpu_ms: number; subrequests: number };
  observability: { enabled: true; head_sampling_rate: 1 };
}

export function validateRelayDeployment(input: unknown): ResultType<RelayDeploymentManifest, InvalidRelayDeployment> {
  const parsed = relayDeploymentManifestSchema.safeParse(input);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(new InvalidRelayDeployment({ message: z.prettifyError(parsed.error) }));
}

export function renderStandaloneWrangler(manifest: RelayDeploymentManifest): StandaloneWranglerConfig {
  return {
    $schema: '../../node_modules/wrangler/config-schema.json',
    name: manifest.workerName,
    main: manifest.mainModule,
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: manifest.compatibilityFlags,
    durable_objects: {
      bindings: [{ name: manifest.relayBinding, class_name: manifest.relayClass }],
    },
    migrations: manifest.migrations.map((migration) => ({
      tag: migration.tag,
      ...(migration.newSqliteClasses.length > 0 ? { new_sqlite_classes: migration.newSqliteClasses } : {}),
      ...(migration.deletedClasses.length > 0 ? { deleted_classes: migration.deletedClasses } : {}),
      ...(migration.renamedClasses.length > 0 ? { renamed_classes: migration.renamedClasses } : {}),
    })),
    vars: {
      AUTH_PUBLIC_KEY: manifest.authPublicKey,
      RELAY_NAME: manifest.relayName,
      AUTH_MAX_SKEW_MS: manifest.authMaxSkewMs,
      TUNNEL_HEADER_TIMEOUT_MS: manifest.tunnelHeaderTimeoutMs,
      TUNNEL_IDLE_TIMEOUT_MS: manifest.tunnelIdleTimeoutMs,
    },
    limits: { cpu_ms: manifest.cpuMs, subrequests: manifest.subRequests },
    observability: { enabled: true, head_sampling_rate: 1 },
  };
}

export function renderWfpUploadMetadata(
  manifest: RelayDeploymentManifest,
  oldTag?: string,
): ResultType<WfpUploadMetadata, UnknownMigrationTag> {
  const oldIndex = oldTag === undefined ? -1 : manifest.migrations.findIndex((migration) => migration.tag === oldTag);
  if (oldTag !== undefined && oldIndex === -1) {
    return Result.err(new UnknownMigrationTag({ tag: oldTag, message: `Unknown previous migration tag ${oldTag}` }));
  }
  const pending = manifest.migrations.slice(oldIndex + 1);
  const migrationMetadata = pending.length === 0 ? undefined : {
    ...(oldTag === undefined ? {} : { old_tag: oldTag }),
    new_tag: pending.at(-1)!.tag,
    steps: pending.map((migration) => ({
      ...(migration.newSqliteClasses.length > 0 ? { new_sqlite_classes: migration.newSqliteClasses } : {}),
      ...(migration.deletedClasses.length > 0 ? { deleted_classes: migration.deletedClasses } : {}),
      ...(migration.renamedClasses.length > 0 ? { renamed_classes: migration.renamedClasses } : {}),
    })),
  };
  return Result.ok({
    main_module: manifest.mainModule.split('/').at(-1)!,
    bindings: [
      { name: manifest.relayBinding, type: 'durable_object_namespace', class_name: manifest.relayClass },
      { name: 'AUTH_PUBLIC_KEY', type: 'plain_text', text: manifest.authPublicKey },
      { name: 'RELAY_NAME', type: 'plain_text', text: manifest.relayName },
      { name: 'AUTH_MAX_SKEW_MS', type: 'plain_text', text: String(manifest.authMaxSkewMs) },
      { name: 'TUNNEL_HEADER_TIMEOUT_MS', type: 'plain_text', text: String(manifest.tunnelHeaderTimeoutMs) },
      { name: 'TUNNEL_IDLE_TIMEOUT_MS', type: 'plain_text', text: String(manifest.tunnelIdleTimeoutMs) },
    ],
    ...(migrationMetadata ? { migrations: migrationMetadata } : {}),
    limits: { cpu_ms: manifest.cpuMs, subrequests: manifest.subRequests },
    observability: { enabled: true, head_sampling_rate: 1 },
  });
}

export async function hashRelayBundle(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
