import { SpacesError } from '../types/errors.js';

export const GITSPACE_API_BASE = process.env.GITSPACE_API_URL || 'https://api.gitspace.sh';
export const EXPECTED_WORKER_API_VERSION = 1;
export const EXPECTED_SUBDOMAINS_SCHEMA_VERSION = 2;

export interface WorkerPublicConfig {
  github_client_id?: string;
  version?: string;
  apiVersion?: number;
  subdomainsSchemaVersion?: number;
}

export async function fetchWorkerPublicConfig(): Promise<WorkerPublicConfig> {
  const res = await fetch(`${GITSPACE_API_BASE}/config`);
  if (!res.ok) {
    throw new SpacesError('Failed to fetch config from API', 'SYSTEM_ERROR');
  }

  return await res.json() as WorkerPublicConfig;
}

export function getWorkerCompatibilityWarnings(config: WorkerPublicConfig): string[] {
  const workerVersion = config.version ? ` worker ${config.version}` : ' worker';
  const warnings: string[] = [];

  if (config.apiVersion !== EXPECTED_WORKER_API_VERSION) {
    warnings.push(
      config.apiVersion == null
        ? `gitspace.sh API compatibility metadata missing from${workerVersion}. Hosted status may be incomplete until the worker is updated.`
        : `gitspace.sh API version mismatch: CLI expects ${EXPECTED_WORKER_API_VERSION}, but${workerVersion} reports ${config.apiVersion}. Hosted status may be incomplete until CLI and worker versions match.`,
    );
  }

  if (config.subdomainsSchemaVersion !== EXPECTED_SUBDOMAINS_SCHEMA_VERSION) {
    warnings.push(
      config.subdomainsSchemaVersion == null
        ? `gitspace.sh subdomain schema metadata missing from${workerVersion}. Serve readiness cannot be verified safely.`
        : `gitspace.sh subdomain schema mismatch: CLI expects ${EXPECTED_SUBDOMAINS_SCHEMA_VERSION}, but${workerVersion} reports ${config.subdomainsSchemaVersion}. Serve readiness cannot be verified safely.`,
    );
  }

  return warnings;
}

export function supportsServeCompanionMetadata(config: WorkerPublicConfig): boolean {
  return config.apiVersion === EXPECTED_WORKER_API_VERSION
    && config.subdomainsSchemaVersion === EXPECTED_SUBDOMAINS_SCHEMA_VERSION;
}
