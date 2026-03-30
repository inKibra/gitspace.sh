import { SpacesError } from '../types/errors.js';

export const GITSPACE_API_BASE = process.env.GITSPACE_API_URL || 'https://api.gitspace.sh';
export const EXPECTED_WORKER_API_VERSION = 3;
export const EXPECTED_SUBDOMAINS_SCHEMA_VERSION = 4;

export interface WorkerPublicConfig {
  github_client_id?: string;
  version?: string;
  apiVersion?: number;
  subdomainsSchemaVersion?: number;
}

export type ServeTunnelConfigSource = 'local';

export interface ServeTunnelCredentialsFile {
  AccountTag: string;
  TunnelID: string;
  TunnelName: string;
  TunnelSecret: string;
}

export interface ServeTunnelDetails {
  serveDomain: string;
  serveTunnelId: string;
  serveTunnelName: string;
  serveTunnelConfigSource: ServeTunnelConfigSource;
  serveTunnelCredentialsFile: ServeTunnelCredentialsFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseServeTunnelDetails(payload: unknown): ServeTunnelDetails | null {
  if (!isRecord(payload)) {
    return null;
  }

  const serveDomain = readTrimmedString(payload.serveDomain)?.toLowerCase();
  const serveTunnelId = readTrimmedString(payload.serveTunnelId);
  const serveTunnelName = readTrimmedString(payload.serveTunnelName);
  const serveTunnelConfigSource = payload.serveTunnelConfigSource;
  const credentials = payload.serveTunnelCredentialsFile;

  if (
    !serveDomain
    || !serveTunnelId
    || !serveTunnelName
    || serveTunnelConfigSource !== 'local'
    || !isRecord(credentials)
  ) {
    return null;
  }

  const accountTag = readTrimmedString(credentials.AccountTag);
  const tunnelId = readTrimmedString(credentials.TunnelID);
  const tunnelName = readTrimmedString(credentials.TunnelName);
  const tunnelSecret = readTrimmedString(credentials.TunnelSecret);
  if (!accountTag || !tunnelId || !tunnelName || !tunnelSecret) {
    return null;
  }

  if (tunnelId !== serveTunnelId || tunnelName !== serveTunnelName) {
    return null;
  }

  return {
    serveDomain,
    serveTunnelId,
    serveTunnelName,
    serveTunnelConfigSource,
    serveTunnelCredentialsFile: {
      AccountTag: accountTag,
      TunnelID: tunnelId,
      TunnelName: tunnelName,
      TunnelSecret: tunnelSecret,
    },
  };
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
