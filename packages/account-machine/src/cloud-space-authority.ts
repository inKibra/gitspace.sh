import { machineExecutionAdmissionSchema, type LaunchProgress, type machineProtocolInputSchema, type MachineExecutionAdmission } from '@gitspace/protocol/deployment';
import { z } from 'zod';
import { collectBytes, streamBytes, WorkspaceDomainError, WorkspaceFailureSchema } from '@gitspace/protocol-workspace';
import {
  CONTROL_SOCKET_PROTOCOL,
  createServerClock,
  createSignedControlRequest,
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
import type { CheckpointBlobStore } from './checkpoint-blobs.js';
import type { EffectiveSecretMetadata } from '@gitspace/protocol/rpc-contract';
import { cloudResponseRay, withCloudRequestDiagnostics } from './cloud-request-diagnostics.js';
import { EnvironmentError, EnvironmentFailureSchema, LifecycleStateSchema, type EnvironmentLifecycleAuthority, type LifecycleMutation, type LifecycleState, type LifecycleRunLog } from '@gitspace/protocol-environment';
import { applyStreamEvent, initialStreamState } from '@gitspace/protocol-sync';
import { decodeSseChanges } from '@gitspace/protocol-sync/sse';

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

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

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

export class CloudDataCheckpointBlobStore implements CheckpointBlobStore {
  private readonly options: CloudControlOptions;

  constructor(options: SignedCloudRequestOptions) {
    this.options = cloudControlOptions(options);
  }

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    const hash = hashBytes(bytes);
    const url = objectUrl(this.options.baseUrl, key);
    // Snapshot once so every attempt verifies and uploads the same immutable content.
    const body = ownedBuffer(bytes);
    const uploadId = crypto.randomUUID();
    let resigned = false;
    for (let attempt = 0; ; attempt += 1) {
      const uploadDiagnostics = {
        uploadId,
        objectKey: key,
        byteCount: body.byteLength,
        attempt: attempt + 1,
        maxAttempts: uploadMaxAttempts,
        targetOrigin: url.origin,
      };
      try {
        // A prior PUT may have committed even when its response was lost.
        const head = signedRequest(this.options, 'data.head', { key, hash });
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
          if (response.headers.get('x-gitspace-sha256') !== hash
            || response.headers.get('content-length') !== String(body.byteLength)) {
            throw new CloudSpaceAuthorityError(
              'DATA_INTEGRITY_FAILED',
              `Application object ${key} metadata does not match the upload`,
              { key, status: response.status },
            );
          }
          return true;
        }, uploadDiagnostics);
        if (exists) return hash;
        // PUT signs its own operation, hash and size.
        const request = signedRequest(this.options, 'data.put', { key, hash, size: body.byteLength });
        return await withCloudRequestDiagnostics(request, async (diagnostics) => {
          const fetchStarted = performance.now();
          const response = await cloudFetch(this.options, url, {
            method: 'PUT',
            headers: {
              'content-length': String(body.byteLength),
              'content-type': 'application/octet-stream',
              'x-gitspace-control': encodedRequest(request),
              ...diagnostics.headers,
            },
            body,
          });
          diagnostics.responseHeadersMs = performance.now() - fetchStarted;
          diagnostics.response = response;
          diagnostics.stage = 'http';
          if (!response.ok) {
            const serverError = await readControlError(response);
            throw new CloudSpaceAuthorityError(
              'DATA_PUT_FAILED',
              `Application object upload ${key} failed with ${response.status}${serverError ? `: ${serverError.code}: ${serverError.message}` : ''}`,
              { ...serverError, key, status: response.status },
            );
          }
          await response.body?.cancel().catch(() => undefined);
          return hash;
        }, uploadDiagnostics);
      } catch (error) {
        // A slow upload can outlive its signature; one fresh signature is enough, a second expiry is not transient.
        const expired = !resigned && requestExpired(error);
        if (attempt + 1 >= uploadMaxAttempts || !(expired || retryableUploadError(error))) throw error;
        if (expired) {
          resigned = true;
          continue;
        }
        // Bound retries and preserve the last transport or HTTP error.
        await Bun.sleep(Math.min(250 * 2 ** attempt, 5_000));
      }
    }
  }

  async get(key: string, expectedHash?: string, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    for (let resigned = false; ; resigned = true) {
      const request = signedRequest(this.options, 'data.get', { key, ...(expectedHash ? { hash: expectedHash } : {}) });
      try {
        return await withCloudRequestDiagnostics(request, async (diagnostics) => {
          const response = await cloudFetch(this.options, objectUrl(this.options.baseUrl, key), {
            headers: { 'x-gitspace-control': encodedRequest(request), ...diagnostics.headers },
          });
          diagnostics.response = response;
          diagnostics.stage = 'http';
          if (response.status === 404) return null;
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
          diagnostics.stage = 'response-body';
          const declaredSize = response.headers.get('content-length');
          if (declaredSize !== null && Number(declaredSize) > maxBytes) {
            await response.body?.cancel();
            throw new Error('Checkpoint ciphertext exceeds byte limit');
          }
          const bytes = response.body ? await collectBytes(streamBytes(response.body), maxBytes) : new Uint8Array();
          diagnostics.stage = 'integrity';
          if (expectedHash && hashBytes(bytes) !== expectedHash) throw new CloudSpaceAuthorityError('DATA_INTEGRITY_FAILED', `Application object ${key} failed integrity verification`);
          return bytes;
        });
      } catch (error) {
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

  async watchLifecycleState(
    projectId: string,
    spaceId: string,
    onState: (state: LifecycleState) => void,
    signal: AbortSignal,
    onFailure?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    let state = initialStreamState<LifecycleState>(`environment:${spaceId}`);
    let retryDelay = 250;
    let resigned = false;
    while (!signal.aborted) {
      const connection = new AbortController();
      const abort = () => connection.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      let response: Response | undefined;
      try {
        const request = signedRequest(this.options, 'project.environment.watch', { projectId, spaceId, after: state.resync ? null : state.cursor });
        const headerDeadline = setTimeout(() => connection.abort(new Error('Environment stream connection timed out')), 30_000);
        try {
          response = await withCloudRequestDiagnostics(request, async (diagnostics) => {
            const value = await cloudFetch(this.options, new URL('/v1/control', this.options.baseUrl), {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...diagnostics.headers },
              body: JSON.stringify(request),
              signal: connection.signal,
            });
            diagnostics.response = value;
            return value;
          });
        } finally {
          clearTimeout(headerDeadline);
        }
        if (!response.ok) {
          const error = await readControlError(response);
          const failure = EnvironmentFailureSchema.safeParse(error);
          if (failure.success) throw new EnvironmentError(failure.data.code, failure.data.message, failure.data.context);
          throw new CloudSpaceAuthorityError(error?.code ?? 'STREAM_FAILED', error?.message ?? `Environment stream failed with ${response.status}`, { code: error?.code, status: response.status });
        }
        resigned = false;
        if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
          throw new CloudSpaceAuthorityError('STREAM_PROTOCOL_INVALID', 'Environment authority did not return an SSE stream', { status: response.status });
        }
        for await (const event of decodeSseChanges(response.body, LifecycleStateSchema, signal)) {
          const previous = state;
          state = applyStreamEvent(state, event);
          if (event.type === 'resync') continue;
          if (state.resync) break;
          if (state !== previous && state.value) onState(state.value);
          retryDelay = 250;
        }
        if (!signal.aborted) throw new Error('Environment synchronization connection closed');
      } catch (error) {
        if (signal.aborted) return;
        if (!resigned && requestExpired(error)) {
          resigned = true;
          continue;
        }
        if (error instanceof EnvironmentError
          || error instanceof CloudSpaceAuthorityError && typeof error.details.status === 'number'
          && error.details.status < 500 && error.details.status !== 408 && error.details.status !== 429) throw error;
        await onFailure?.(error);
      } finally {
        signal.removeEventListener('abort', abort);
        connection.abort();
        await response?.body?.cancel().catch(() => undefined);
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, retryDelay);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
      retryDelay = Math.min(10_000, retryDelay * 2);
    }
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

  listHostedRoutes(projectId: string): Promise<HostedServiceRoute[]> {
    return this.call('project.routes.list', { projectId });
  }

  leaseHostedRoute(
    projectId: string,
    route: Omit<HostedServiceRoute, 'updatedAt'>,
  ): Promise<HostedServiceRoute> {
    return this.call('project.routes.lease', { projectId, route });
  }

  releaseHostedRoute(projectId: string, hostname: string, generation: number): Promise<boolean> {
    return this.call('project.routes.release', { projectId, hostname, generation });
  }

  putMachineDefinition(definition: FleetMachineDefinition): Promise<FleetMachineDefinition> {
    return this.call('catalog.machine.put', { ...definition });
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

  subscribeSettings(
    onChange: (event: { userRevision: number; runtimeGeneration: number }) => void,
    onState: (state: 'connecting' | 'open' | 'offline') => void,
  ): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 500;
    const connect = (): void => {
      if (stopped) return;
      onState('connecting');
      const request = signedRequest(this.options, 'settings.subscribe', {});
      const url = new URL('/v1/settings/events', this.options.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      // The signed request rides in `Sec-WebSocket-Protocol`; URLs reach logs.
      socket = new WebSocket(url, [`${CONTROL_SOCKET_PROTOCOL}${encodedRequest(request)}`]);
      socket.addEventListener('open', () => { retryMs = 500; onState('open'); });
      socket.addEventListener('message', (message) => {
        try {
          const event = JSON.parse(String(message.data)) as { type?: unknown; userRevision?: unknown; runtimeGeneration?: unknown };
          if (event.type === 'settings.changed' && typeof event.userRevision === 'number' && typeof event.runtimeGeneration === 'number') {
            onChange({ userRevision: event.userRevision, runtimeGeneration: event.runtimeGeneration });
          }
        } catch {
          // Ignore malformed control-plane events; the next valid event remains usable.
        }
      });
      socket.addEventListener('close', () => {
        socket = null;
        if (stopped) return;
        onState('offline');
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      });
      socket.addEventListener('error', () => socket?.close());
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, 'Settings subscription stopped');
    };
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
