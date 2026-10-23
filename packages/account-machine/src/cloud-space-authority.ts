import { machineExecutionAdmissionSchema, type LaunchProgress, type LauncherStartedInput, type machineProtocolInputSchema, type MachineExecutionAdmission } from '@gitspace/protocol/deployment';
import { z } from 'zod';
import { collectBytes, streamBytes, WorkspaceDomainError, WorkspaceFailureSchema } from '@gitspace/protocol-workspace';
import {
  createServerClock,
  createSignedControlRequest,
  DATA_PUT_MAX_BYTES,
  type HostedRouteLease,
  type HostedRoutes,
  type HostedServiceRoute,
  type CloudProjectSummary,
  type CloudWorkspaceDefinition,
  type ControlOperation,
  type DeploymentStatus,
  type ReleaseRecord,
  type ReleaseTarget,
  type StageReleaseInput,
  type TenantDesired,
  type GitIdentityDocument,
  type GitIdentityUpdate,
  type McpAuditEvent,
  type McpConnection,
  type McpConnectionStatus,
  type DeviceGrantRecord,
  type ProjectEvent,
  type ProjectMcpGrant,
  type ServerClock,
  type SignedControlRequest,
  type UserSettings,
} from '@gitspace/protocol';
import { hashBytes, verifiedBytes, type BlobHash, type DataWorkspace, type StreamingBlobStore } from './checkpoint-blobs.js';
import type { EffectiveSecretMetadata } from '@gitspace/protocol/rpc-contract';
import { cloudResponseRay, withCloudRequestDiagnostics, type UploadDiagnostics } from './cloud-request-diagnostics.js';
import { EnvironmentError, EnvironmentFailureSchema, type EnvironmentLifecycleAuthority, type HostedIngressRegistration, type LifecycleMutation, type LifecycleState, type LifecycleRunLog } from '@gitspace/protocol-environment';

export class CloudSpaceAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CloudSpaceAuthorityError';
  }
}

export interface SignedCloudRequestOptions {
  baseUrl: string;
  userId: string;
  machineId: string;
  signingPrivateKey: Uint8Array;
  fetcher?: typeof fetch;
  /** One per machine process, shared by its clients; each client otherwise keeps its own. */
  clock?: ServerClock;
}

/** A client's options with the clock all of its requests sign with and learn from. */
export type CloudControlOptions = Omit<SignedCloudRequestOptions, 'clock'> & { clock: ServerClock };

export function cloudControlOptions(options: SignedCloudRequestOptions): CloudControlOptions {
  return { ...options, clock: options.clock ?? createServerClock() };
}

function signedRequest(options: CloudControlOptions, operation: ControlOperation, payload: Record<string, unknown>): SignedControlRequest {
  return createSignedControlRequest({
    userId: options.userId,
    machineId: options.machineId,
    operation,
    payload,
    signingPrivateKey: options.signingPrivateKey,
    timestamp: options.clock.now(),
  });
}

/** Every account response corrects the clock, so a re-signed expired request carries the account's time. */
async function cloudFetch(options: CloudControlOptions, input: URL, init: RequestInit): Promise<Response> {
  const response = await (options.fetcher ?? fetch)(input, init);
  options.clock.observe(response);
  return response;
}

function encodedRequest(request: SignedControlRequest): string {
  return Buffer.from(JSON.stringify(request)).toString('base64url');
}

function objectUrl(baseUrl: string, key: string): URL {
  if (!key || key.startsWith('/') || key.includes('..')) throw new Error(`Invalid application object key ${key}`);
  return new URL(`/v1/data/${key.split('/').map(encodeURIComponent).join('/')}`, baseUrl);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

const DATA_SHA256_HEADER = 'x-gitspace-sha256';
const DATA_SIZE_HEADER = 'content-length';
const dataFailureCodes: Record<string, string> = {
  'data.put': 'DATA_PUT_FAILED',
  'data.multipart.create': 'DATA_MULTIPART_FAILED',
  'data.multipart.part': 'DATA_PART_FAILED',
  'data.multipart.complete': 'DATA_MULTIPART_FAILED',
  'data.multipart.abort': 'DATA_MULTIPART_FAILED',
};

const uploadMaxAttempts = 10;

const uploadRetryCodes: Record<string, true> = {
  ECONNRESET: true, ECONNREFUSED: true, ECONNABORTED: true, EPIPE: true,
  ETIMEDOUT: true, EAI_AGAIN: true, ENETDOWN: true, ENETUNREACH: true,
  EHOSTUNREACH: true, ERR_NETWORK: true, ERR_SOCKET_CLOSED: true,
  UND_ERR_CONNECT_TIMEOUT: true, UND_ERR_SOCKET: true,
  ConnectionClosed: true, ConnectionRefused: true, Timeout: true, FailedToOpenSocket: true,
};

function retryableUploadError(error: unknown): boolean {
  if (error instanceof CloudSpaceAuthorityError) {
    const status = error.details.status;
    return typeof status === 'number' && (status === 408 || status === 429 || (status >= 500 && status <= 599));
  }
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; cause = cause.cause, depth += 1) {
    if (cause.name === 'AbortError') return false;
    if ('code' in cause && typeof cause.code === 'string' && Object.hasOwn(uploadRetryCodes, cause.code)) return true;
  }
  return false;
}

/** The Worker checks signature age before acting, so an expired request changed nothing and may be re-signed. */
function requestExpired(error: unknown): boolean {
  return error instanceof CloudSpaceAuthorityError && error.details.code === 'REQUEST_EXPIRED';
}

const controlErrorMaxBytes = 8 * 1024;
const controlErrorResponseSchema = z.object({
  status: z.literal('error'),
  error: z.union([EnvironmentFailureSchema, z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    declaredSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })]),
});

async function readControlError(response: Response): Promise<z.infer<typeof controlErrorResponseSchema>['error'] | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  // A server that sends headers but stalls its body must not block the failure or retry.
  const deadline = setTimeout(() => { void reader.cancel().catch(() => undefined); }, 1_000);
  try {
    if (Number(response.headers.get('content-length')) > controlErrorMaxBytes) return null;
    const bytes = new Uint8Array(controlErrorMaxBytes);
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > controlErrorMaxBytes - length) return null;
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    const parsed = controlErrorResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))));
    return parsed.success ? parsed.data.error : null;
  } catch {
    // A broken error body must not replace the HTTP status or change its retry policy.
    return null;
  } finally {
    clearTimeout(deadline);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Plaintext tenant objects through the signed data endpoint; the account encrypts them at rest under their scope. */
export class CloudDataCheckpointBlobStore implements StreamingBlobStore {
  private readonly options: CloudControlOptions;

  constructor(options: SignedCloudRequestOptions) {
    this.options = cloudControlOptions(options);
  }

  async put(key: string, bytes: Uint8Array, workspace?: DataWorkspace): Promise<BlobHash> {
    const hash = hashBytes(bytes);
    if (bytes.byteLength > DATA_PUT_MAX_BYTES) {
      return this.putStream(key, (async function* () { yield bytes; })(), { size: bytes.byteLength, hash }, workspace);
    }
    const url = objectUrl(this.options.baseUrl, key);
    const scoped = { ...workspace };
    // Snapshot once so every attempt verifies and uploads the same immutable content.
    const body = ownedBuffer(bytes);
    return this.withUploadRetries(key, body.byteLength, url, async (uploadDiagnostics) => {
      // A prior PUT may have committed even when its response was lost.
      const head = signedRequest(this.options, 'data.head', { key, hash, ...scoped });
      const exists = await withCloudRequestDiagnostics(head, async (diagnostics) => {
        const fetchStarted = performance.now();
        const response = await cloudFetch(this.options, url, {
          method: 'HEAD',
          headers: { 'x-gitspace-control': encodedRequest(head), ...diagnostics.headers },
        });
        diagnostics.responseHeadersMs = performance.now() - fetchStarted;
        diagnostics.response = response;
        diagnostics.stage = 'http';
        if (response.status === 404) {
          void response.body?.cancel().catch(() => undefined);
          return false;
        }
        if (response.status !== 200) {
          const serverError = await readControlError(response);
          throw new CloudSpaceAuthorityError(
            'DATA_HEAD_FAILED',
            `Application object metadata ${key} failed with ${response.status}${serverError ? `: ${serverError.code}: ${serverError.message}` : ''}`,
            { ...serverError, key, status: response.status },
          );
        }
        void response.body?.cancel().catch(() => undefined);
        diagnostics.stage = 'integrity';
        if (response.headers.get(DATA_SHA256_HEADER) !== hash || response.headers.get(DATA_SIZE_HEADER) !== String(body.byteLength)) {
          throw new CloudSpaceAuthorityError('DATA_INTEGRITY_FAILED', `Application object ${key} metadata does not match the upload`, { key, status: response.status });
        }
        return true;
      }, uploadDiagnostics);
      if (exists) return hash;
      // PUT signs its own operation, plaintext hash and size; the account refuses a body that does not match them.
      const request = signedRequest(this.options, 'data.put', { key, hash, size: body.byteLength, ...scoped });
      const response = await this.send(request, url, 'PUT', body, uploadDiagnostics);
      await response.body?.cancel().catch(() => undefined);
      return hash;
    });
  }

  async putStream(key: string, source: AsyncIterable<Uint8Array>, expected: { size: number; hash: string }, workspace?: DataWorkspace): Promise<BlobHash> {
    const { size } = expected;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Application object size is invalid');
    if (size <= DATA_PUT_MAX_BYTES) {
      const bytes = await collectBytes(source, size);
      if (bytes.byteLength !== size) throw new Error(`Application object ${key} source has an unexpected size`);
      if (hashBytes(bytes) !== expected.hash) throw new Error(`Application object ${key} source failed integrity verification`);
      return this.put(key, bytes, workspace);
    }
    const scoped = { ...workspace };
    // The account records the declared hash and size at creation; complete refuses an object that does not match them.
    const created = z.object({ uploadId: z.string().min(1), partBytes: z.number().int().positive() })
      .parse(await this.dataCall('data.multipart.create', 'POST', key, { hash: expected.hash, size, ...scoped }));
    try {
      const hasher = new Bun.CryptoHasher('sha256');
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let buffer = new Uint8Array(Math.min(created.partBytes, size));
      let filled = 0;
      let total = 0;
      for await (const input of source) {
        if (input.byteLength > size - total) throw new Error(`Application object ${key} source exceeds its size`);
        total += input.byteLength;
        hasher.update(input);
        for (let offset = 0; offset < input.byteLength;) {
          const count = Math.min(buffer.byteLength - filled, input.byteLength - offset);
          buffer.set(input.subarray(offset, offset + count), filled);
          filled += count;
          offset += count;
          if (filled === buffer.byteLength) {
            // Every part but the last has exactly partBytes; the source's own chunking does not matter.
            parts.push(await this.uploadPart(key, created.uploadId, parts.length + 1, buffer, scoped));
            buffer = new Uint8Array(Math.min(created.partBytes, size - total + (input.byteLength - offset)));
            filled = 0;
          }
        }
      }
      const hash: BlobHash = `sha256:${hasher.digest('hex')}`;
      if (total !== size) throw new Error(`Application object ${key} source has an unexpected size`);
      if (hash !== expected.hash) throw new Error(`Application object ${key} source failed integrity verification`);
      const completed = z.object({ hash: z.string(), size: z.number() })
        .parse(await this.dataCall('data.multipart.complete', 'POST', key, { uploadId: created.uploadId, parts, ...scoped }));
      if (completed.hash !== hash || completed.size !== size) throw new CloudSpaceAuthorityError('DATA_INTEGRITY_FAILED', `Application object ${key} completed with different content`, { key });
      return hash;
    } catch (error) {
      // An unfinished upload never becomes an object; aborting only frees its parts sooner.
      await this.dataCall('data.multipart.abort', 'DELETE', key, { uploadId: created.uploadId, ...scoped }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string, expectedHash?: string, maxBytes = 64 * 1024 * 1024, workspace?: DataWorkspace): Promise<Uint8Array | null> {
    const source = await this.download(key, { maxBytes, ...(expectedHash === undefined ? {} : { hash: expectedHash }), ...(workspace === undefined ? {} : { workspace }) });
    return source === null ? null : collectBytes(source, maxBytes);
  }

  getStream(key: string, expected: { hash: string; size: number }): Promise<AsyncIterable<Uint8Array> | null> {
    return this.download(key, { ...expected, maxBytes: expected.size });
  }

  /**
   * Plaintext whose recorded hash and size match the expected ones; the last pull fails unless the bytes match too.
   * Drive objects name the workspace whose attachment authorizes the read.
   */
  private async download(key: string, expected: { hash?: string; size?: number; maxBytes: number; workspace?: DataWorkspace }): Promise<AsyncIterable<Uint8Array> | null> {
    const { maxBytes, workspace } = expected;
    for (let resigned = false; ; resigned = true) {
      const request = signedRequest(this.options, 'data.get', {
        key, ...(expected.hash === undefined ? {} : { hash: expected.hash }),
        ...(workspace === undefined ? {} : { projectId: workspace.projectId, workspaceId: workspace.workspaceId }),
      });
      try {
        return await withCloudRequestDiagnostics(request, async (diagnostics) => {
          const response = await cloudFetch(this.options, objectUrl(this.options.baseUrl, key), {
            headers: { 'x-gitspace-control': encodedRequest(request), ...diagnostics.headers },
          });
          diagnostics.response = response;
          diagnostics.stage = 'http';
          if (response.status === 404) {
            void response.body?.cancel().catch(() => undefined);
            return null;
          }
          if (!response.ok) {
            const serverError = await readControlError(response);
            const cfRay = cloudResponseRay(response);
            // Carry safe correlation in the Error message too: release reports retain only that string.
            throw new CloudSpaceAuthorityError(
              'DATA_GET_FAILED',
              `Application object download ${key} failed with ${response.status}${serverError ? `: ${serverError.code}: ${serverError.message}` : ''}`
                + ` (machine=${request.machineId} operation=${request.operation} request=${request.nonce}${cfRay ? ` cf-ray=${cfRay}` : ''})`,
              { ...serverError, key, status: response.status, machineId: request.machineId, operation: request.operation, requestId: request.nonce, ...(cfRay ? { cfRay } : {}) },
            );
          }
          diagnostics.stage = 'integrity';
          const recorded = { hash: response.headers.get(DATA_SHA256_HEADER) ?? '', size: Number(response.headers.get(DATA_SIZE_HEADER) ?? Number.NaN) };
          const mismatch = !/^sha256:[a-f0-9]{64}$/u.test(recorded.hash) || !Number.isSafeInteger(recorded.size) || recorded.size < 0
            || (expected.hash !== undefined && recorded.hash !== expected.hash) || (expected.size !== undefined && recorded.size !== expected.size);
          if (mismatch || recorded.size > maxBytes) {
            void response.body?.cancel().catch(() => undefined);
            if (mismatch) throw new CloudSpaceAuthorityError('DATA_INTEGRITY_FAILED', `Application object ${key} does not carry the expected hash and size`, { key, status: response.status });
            throw new CloudSpaceAuthorityError('DATA_OBJECT_TOO_LARGE', `Application object ${key} exceeds ${maxBytes} bytes`, { key, size: recorded.size, maxBytes });
          }
          diagnostics.stage = 'response-body';
          return verifiedBytes(response.body ? streamBytes(response.body) : (async function* () { /* Empty object. */ })(), recorded, `Application object ${key}`);
        });
      } catch (error) {
        if (resigned || !requestExpired(error)) throw error;
      }
    }
  }

  private async uploadPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array, scoped: Partial<DataWorkspace>): Promise<{ partNumber: number; etag: string }> {
    const url = objectUrl(this.options.baseUrl, key);
    const body = ownedBuffer(bytes);
    const hash = hashBytes(bytes);
    return this.withUploadRetries(key, body.byteLength, url, async (uploadDiagnostics) => {
      const request = signedRequest(this.options, 'data.multipart.part', { key, uploadId, partNumber, hash, size: body.byteLength, ...scoped });
      const response = await this.send(request, url, 'PUT', body, uploadDiagnostics);
      const part = z.object({ status: z.literal('ok'), value: z.object({ partNumber: z.literal(partNumber), etag: z.string().min(1) }) }).parse(await response.json());
      return part.value;
    });
  }

  /** Sends one signed data request and fails on a non-success status; the caller owns the successful response. */
  private send(request: SignedControlRequest, url: URL, method: 'PUT' | 'POST' | 'DELETE', body: ArrayBuffer | null, uploadDiagnostics?: UploadDiagnostics): Promise<Response> {
    return withCloudRequestDiagnostics(request, async (diagnostics) => {
      const fetchStarted = performance.now();
      const response = await cloudFetch(this.options, url, {
        method,
        headers: {
          ...(body === null ? {} : { 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' }),
          'x-gitspace-control': encodedRequest(request),
          ...diagnostics.headers,
        },
        ...(body === null ? {} : { body }),
      });
      diagnostics.responseHeadersMs = performance.now() - fetchStarted;
      diagnostics.response = response;
      diagnostics.stage = 'http';
      if (!response.ok) {
        const serverError = await readControlError(response);
        throw new CloudSpaceAuthorityError(
          dataFailureCodes[request.operation] ?? 'DATA_REQUEST_FAILED',
          `Application object ${request.operation} ${String(request.payload.key)} failed with ${response.status}${serverError ? `: ${serverError.code}: ${serverError.message}` : ''}`,
          { ...serverError, key: request.payload.key, status: response.status },
        );
      }
      return response;
    }, uploadDiagnostics);
  }

  /** Bounded retries of one immutable upload: transient failures back off, one expired signature is re-signed. */
  private async withUploadRetries<T>(key: string, byteCount: number, url: URL, attempt: (diagnostics: UploadDiagnostics) => Promise<T>): Promise<T> {
    const uploadId = crypto.randomUUID();
    let resigned = false;
    for (let index = 0; ; index += 1) {
      try {
        return await attempt({ uploadId, objectKey: key, byteCount, attempt: index + 1, maxAttempts: uploadMaxAttempts, targetOrigin: url.origin });
      } catch (error) {
        // A slow upload can outlive its signature; one fresh signature is enough, a second expiry is not transient.
        const expired = !resigned && requestExpired(error);
        if (index + 1 >= uploadMaxAttempts || !(expired || retryableUploadError(error))) throw error;
        if (expired) {
          resigned = true;
          continue;
        }
        // Bound retries and preserve the last transport or HTTP error.
        await Bun.sleep(Math.min(250 * 2 ** index, 5_000));
      }
    }
  }

  /** A bodiless multipart request; its JSON value, or null for 204. */
  private async dataCall(operation: 'data.multipart.create' | 'data.multipart.complete' | 'data.multipart.abort', method: 'POST' | 'DELETE', key: string, payload: Record<string, unknown>): Promise<unknown> {
    for (let resigned = false; ; resigned = true) {
      const request = signedRequest(this.options, operation, { key, ...payload });
      try {
        const response = await this.send(request, objectUrl(this.options.baseUrl, key), method, null);
        if (response.status === 204) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        return z.object({ status: z.literal('ok'), value: z.unknown() }).parse(await response.json()).value;
      } catch (error) {
        // Rejected before the operation ran, so a freshly signed repeat cannot apply it twice.
        if (resigned || !requestExpired(error)) throw error;
      }
    }
  }
}

export interface FleetMachineDefinition {
  id: string;
  label: string;
  state: 'provisioning' | 'online' | 'sleeping' | 'offline' | 'resuming' | 'deleting' | 'error';
  rpcEndpoint: string | null;
  kind: 'physical' | 'sandbox';
  notes: string;
  provider: 'physical' | 'cloudflare-sandbox';
  desiredState: 'online' | 'offline' | 'removed';
  lifecycleRevision: number;
  operationId: string | null;
  error: string | null;
}


export class CloudSpaceCheckpointAuthority implements EnvironmentLifecycleAuthority {
  private readonly options: CloudControlOptions;

  constructor(options: SignedCloudRequestOptions) {
    this.options = cloudControlOptions(options);
  }

  getProject(projectId: string): Promise<CloudProjectSummary | null> {
    return this.call('project.get', { projectId });
  }


  getLifecycleState(projectId: string, spaceId: string): Promise<LifecycleState> {
    return this.call('project.environment.get', { projectId, spaceId });
  }

  mutateLifecycleState(projectId: string, spaceId: string, input: LifecycleMutation): Promise<LifecycleState> {
    return this.call('project.environment.mutate', { projectId, spaceId, input });
  }

  getLifecycleRunLog(projectId: string, spaceId: string, runId: string, offset = 0): Promise<LifecycleRunLog> {
    return this.call('project.environment.runLog', { projectId, spaceId, runId, offset });
  }

  listProjectWorkspaces(projectId: string): Promise<CloudWorkspaceDefinition[]> {
    return this.call('project.workspaces.list', { projectId });
  }

  appendProjectEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }): Promise<ProjectEvent> {
    const { projectId, ...event } = input;
    return this.call('project.events.append', { projectId, event });
  }

  listDeviceGrants(): Promise<DeviceGrantRecord[]> {
    return this.call('devices.list', {});
  }

  listHostedRoutes(projectId: string): Promise<HostedRoutes> {
    return this.call('project.routes.list', { projectId });
  }

  leaseHostedRoute(projectId: string, route: Omit<HostedServiceRoute, 'updatedAt'>): Promise<HostedRouteLease> {
    return this.call('project.routes.lease', { projectId, route });
  }

  /** Points the route's workspace URL at this machine's service and port, and leases it. */
  pinHostedRoute(projectId: string, route: Omit<HostedServiceRoute, 'updatedAt'>): Promise<HostedRouteLease> {
    return this.call('project.routes.pin', { projectId, route });
  }

  releaseHostedRoute(projectId: string, hostname: string, generation: number): Promise<boolean> {
    return this.call('project.routes.release', { projectId, hostname, generation });
  }

  /** Replaces the workspace's signed-caller registrations, from its running `cloud/provision` or `workspace/materialize` run. */
  registerHostedIngress(input: HostedIngressRegistration): Promise<{ hostnames: string[] }> {
    return this.call('project.routes.ingress', input);
  }

  listMachineDefinitions(): Promise<FleetMachineDefinition[]> {
    return this.call('catalog.machine.list', {});
  }

  getUserSettings(): Promise<UserSettings> {
    return this.call('settings.get', {});
  }

  getGitIdentity(): Promise<GitIdentityDocument | null> {
    return this.call('settings.git.get', {});
  }

  updateGitIdentity(input: GitIdentityUpdate): Promise<GitIdentityDocument> {
    return this.call('settings.git.update', { ...input });
  }

  materializeProjectSecrets(projectId: string, names: string[], workspaceId: string | null): Promise<Record<string, string>> {
    return this.call('secrets.materialize', { projectId, names, workspaceId });
  }

  listEffectiveSecrets(projectId: string, workspaceId: string | null): Promise<EffectiveSecretMetadata[]> {
    return this.call('secrets.effective.list', { projectId, workspaceId });
  }

  getMcpConnectionStatus(connectionId: string): Promise<McpConnection | null> {
    return this.call('mcp.connections.status', { connectionId });
  }

  recordMcpConnectionStatus(input: {
    connectionId: string;
    observedRevision: number;
    status: McpConnectionStatus;
    message?: string | null;
    serverFingerprint?: string | null;
    serverVersion?: string | null;
  }): Promise<McpConnection> {
    return this.call('mcp.connections.status', input);
  }

  listProjectMcpGrants(projectId: string): Promise<ProjectMcpGrant[]> {
    return this.call('project.mcp.grants.list', { projectId });
  }

  appendMcpAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<McpAuditEvent> {
    return this.call('mcp.audit.append', event);
  }

  stageRelease(input: StageReleaseInput): Promise<ReleaseRecord> {
    return this.call<ReleaseRecord>('deploy.stage', input);
  }

  async launchRelease(sha: string, targets: ReleaseTarget[]): Promise<{ record: ReleaseRecord; desired: TenantDesired }> {
    try {
      return await this.call('deploy.launch', { sha, targets });
    } catch (error) {
      // Updating the Worker can reset its own response after selecting the release.
      // Read the outcome instead of repeating a deployment with external effects.
      const status = await this.deploymentStatus().catch(() => null);
      const record = status?.releases.find((release) => release.sha === sha);
      if (!status || !record || record.error !== null || targets.length === 0
        || !targets.every((target) => status.desired[target] === sha)
        || (targets.includes('worker') && (status.current.worker.sha !== sha || record.status.worker === 'failed'))) {
        throw error;
      }
      return { record, desired: status.desired };
    }
  }

  deploymentStatus(): Promise<DeploymentStatus> {
    return this.call<DeploymentStatus>('deploy.status', {});
  }

  async reportLaunchProgress(progress: LaunchProgress): Promise<void> {
    await this.call('deploy.launchProgress', progress);
  }

  /** This process builds nothing yet: a launch it left running before `startedAt` is finished or interrupted. */
  async launcherStarted(input: LauncherStartedInput): Promise<void> {
    await this.call('deploy.launcherStarted', input);
  }

  async machineProtocol(input: z.input<typeof machineProtocolInputSchema>): Promise<MachineExecutionAdmission> {
    return machineExecutionAdmissionSchema.parse(await this.call('deploy.machineProtocol', input));
  }

  reportMachineApplied(input: { sha: string; target: 'machine'; generation: string; status: 'applied' | 'failed'; error?: string }): Promise<ReleaseRecord> {
    return this.call<ReleaseRecord>('deploy.machineApplied', input);
  }

  /** Clear only the target that this healthy machine confirmed running from its channel artifact. */
  async reportMachineChannelApplied(input: { target: 'machine'; generation: string }): Promise<void> {
    await this.call('deploy.machineChannelApplied', input);
  }

  private async call<T = unknown>(operation: ControlOperation, payload: Record<string, unknown>): Promise<T> {
    for (let resigned = false; ; resigned = true) {
      const request = signedRequest(this.options, operation, payload);
      try {
        return await withCloudRequestDiagnostics(request, async (diagnostics) => {
          const response = await cloudFetch(this.options, new URL('/v1/control', this.options.baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...diagnostics.headers },
            body: JSON.stringify(request),
          });
          diagnostics.response = response;
          diagnostics.stage = 'response-body';
          const body = await response.json() as { status?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown; [key: string]: unknown } };
          diagnostics.stage = response.ok ? 'application' : 'http';
          if (!response.ok || body.status !== 'ok') {
            const environment = EnvironmentFailureSchema.safeParse(body.error);
            if (environment.success) throw new EnvironmentError(environment.data.code, environment.data.message, environment.data.context);
            const domainFailure = WorkspaceFailureSchema.safeParse(body.error);
            if (domainFailure.success) throw new WorkspaceDomainError(domainFailure.data);
            throw new CloudSpaceAuthorityError(
              typeof body.error?.code === 'string' ? body.error.code : 'CONTROL_FAILED',
              typeof body.error?.message === 'string' ? body.error.message : `Control operation failed with ${response.status}`,
              body.error ?? {},
            );
          }
          return body.value as T;
        });
      } catch (error) {
        // Rejected before the operation ran, so a freshly signed repeat cannot apply it twice.
        if (resigned || !requestExpired(error)) throw error;
      }
    }
  }
}
