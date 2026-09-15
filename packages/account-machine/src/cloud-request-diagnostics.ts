import { AsyncLocalStorage } from 'node:async_hooks';
import type { SignedControlRequest } from '@gitspace/protocol';

interface ArtifactSyncContext {
  sessionId: string;
  attemptId: string;
}

interface CloudRequestDiagnostics {
  headers: Record<string, string>;
  stage: 'before-headers' | 'response-body' | 'http' | 'application' | 'integrity' | 'complete';
  response?: Response;
}

const artifactSyncContext = new AsyncLocalStorage<ArtifactSyncContext>();
const errorNames: Record<string, true> = {
  Error: true,
  TypeError: true,
  SyntaxError: true,
  RangeError: true,
  AggregateError: true,
  DOMException: true,
  AbortError: true,
  TimeoutError: true,
  SystemError: true,
  FetchError: true,
  SocketError: true,
  CloudSpaceAuthorityError: true,
};
const errorCodes: Record<string, true> = {
  ECONNRESET: true,
  ECONNREFUSED: true,
  ECONNABORTED: true,
  EPIPE: true,
  ETIMEDOUT: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EAI_FAIL: true,
  ENETDOWN: true,
  ENETUNREACH: true,
  EHOSTUNREACH: true,
  EHOSTDOWN: true,
  EADDRNOTAVAIL: true,
  EPROTO: true,
  ERR_NETWORK: true,
  ERR_SOCKET_CLOSED: true,
  ERR_STREAM_PREMATURE_CLOSE: true,
  ERR_STREAM_DESTROYED: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
  CERT_HAS_EXPIRED: true,
  CERT_NOT_YET_VALID: true,
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  ABORT_ERR: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_SOCKET: true,
  UND_ERR_ABORTED: true,
  UND_ERR_DESTROYED: true,
  UND_ERR_CLOSED: true,
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: true,
  UND_ERR_REQ_CONTENT_LENGTH_MISMATCH: true,
  ConnectionClosed: true,
  ConnectionRefused: true,
  Timeout: true,
  FailedToOpenSocket: true,
  CONTROL_FAILED: true,
  DATA_PUT_FAILED: true,
  DATA_GET_FAILED: true,
  DATA_INTEGRITY_FAILED: true,
};

function errorProperty(error: unknown, key: string): unknown {
  try {
    return typeof error === 'object' && error !== null ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorToken(value: unknown, kind: 'name' | 'code'): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  // Error properties may be supplied by a remote application; syntax alone cannot redact secrets.
  return Object.hasOwn(kind === 'name' ? errorNames : errorCodes, value) ? value : undefined;
}

function errorFields(error: unknown): Record<string, unknown> {
  const causeCodes: string[] = [];
  let cause = errorProperty(error, 'cause');
  for (let depth = 0; cause !== undefined && depth < 4; depth += 1) {
    const code = safeErrorToken(errorProperty(cause, 'code'), 'code');
    if (code !== undefined) causeCodes.push(code);
    cause = errorProperty(cause, 'cause');
  }
  return {
    errorName: safeErrorToken(errorProperty(error, 'name'), 'name'),
    errorCode: safeErrorToken(errorProperty(error, 'code'), 'code'),
    causeCodes,
  };
}

function emit(record: Record<string, unknown>, error?: unknown): void {
  // Diagnostics must never replace a request result or the original thrown value.
  try {
    const line = JSON.stringify(error === undefined ? record : { ...record, ...errorFields(error) });
    if (record.outcome === 'failure') console.error(line);
    else console.info(line);
  } catch {
    // Logging is best-effort, including when a console sink is unavailable.
  }
}

export async function withArtifactSyncDiagnostics<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const context = { sessionId, attemptId: crypto.randomUUID() };
  return artifactSyncContext.run(context, async () => {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const record = { event: 'artifact_sync_attempt', ...context, startedAt, stage: 'attempt' };
    emit({ ...record, elapsedMs: 0, outcome: 'start' });
    try {
      const value = await run();
      emit({ ...record, elapsedMs: performance.now() - started, outcome: 'success' });
      return value;
    } catch (error) {
      emit({ ...record, elapsedMs: performance.now() - started, outcome: 'failure' }, error);
      throw error;
    }
  });
}

export function cloudResponseRay(response: Response | undefined): string | undefined {
  const ray = response?.headers.get('cf-ray');
  return ray && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/iu.test(ray) ? ray : undefined;
}

export async function withCloudRequestDiagnostics<T>(
  request: Pick<SignedControlRequest, 'nonce' | 'operation'>,
  run: (diagnostics: CloudRequestDiagnostics) => Promise<T>,
): Promise<T> {
  const context = artifactSyncContext.getStore();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const diagnostics: CloudRequestDiagnostics = {
    headers: context ? { 'x-gitspace-sync-attempt': context.attemptId } : {},
    stage: 'before-headers',
  };
  const record = {
    event: 'artifact_sync_request',
    ...context,
    requestId: request.nonce,
    operation: request.operation,
    startedAt,
  };
  const finish = (outcome: 'success' | 'failure', error?: unknown): void => {
    try {
      emit({
        ...record,
        elapsedMs: performance.now() - started,
        stage: diagnostics.stage,
        outcome,
        status: diagnostics.response?.status,
        cfRay: cloudResponseRay(diagnostics.response),
      }, error);
    } catch {
      // Response metadata collection is diagnostic only.
    }
  };
  if (context) emit({ ...record, elapsedMs: 0, stage: diagnostics.stage, outcome: 'start' });
  try {
    const value = await run(diagnostics);
    diagnostics.stage = 'complete';
    if (context) finish('success');
    return value;
  } catch (error) {
    finish('failure', error);
    throw error;
  }
}
