import {
  decodeSignedRpcHeader,
  inputWithinScope,
  requiredCapability,
  RPC_DEVICE_HEADER,
  RPC_SIGNATURE_MAX_SKEW_MS,
  verifyRpcSignature,
  type GitSpaceRpcCaller,
  type VerifiedDevice,
} from '@gitspace/protocol';
import { parse as parseDevalue } from 'devalue';
import { z } from 'zod';

export interface SignedRpcHandlerOptions {
  /** The result-rpc fetch handler; receives the verified caller through `callerFor(request)`. */
  handler: (request: Request) => Promise<Response>;
  lookupDevice(deviceId: string): Promise<VerifiedDevice | null>;
  /** Procedure kind by dotted path, for capability derivation. */
  procedureKind(path: string): 'query' | 'mutation' | 'subscription' | null;
  /** Project owning a workspace, for scoped grants naming a workspace only. */
  workspaceProject(workspaceId: string): string | null;
}

const callers = new WeakMap<Request, GitSpaceRpcCaller>();
const SIGNED_TARGET_HEADER = 'x-gitspace-signed-target';

/** Caller attached by the signed handler; the router's `createContext` reads it. */
export function callerFor(request: Request): GitSpaceRpcCaller | undefined {
  return callers.get(request);
}

function transportError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}

const envelopeItemSchema = z.object({ path: z.string().min(1), input: z.unknown() });
const envelopeSchema = z.union([
  z.object({ v: z.literal(1), path: z.string().min(1), input: z.unknown() }).transform((single) => [{ path: single.path, input: single.input }]),
  z.object({ v: z.literal(1), batch: z.array(envelopeItemSchema) }).transform((batch) => batch.batch),
]);

/** Procedure paths and inputs named by a result-rpc request body, without decoding inputs. */
function envelopeItems(body: string): Array<{ path: string; input: unknown }> | null {
  try {
    const parsed = envelopeSchema.safeParse(parseDevalue(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Authenticates every `/rpc` request with a device signature, then authorizes
 * each procedure in the envelope against the grant's capabilities and scope
 * before result-rpc sees it. Replays are rejected within the signature skew
 * window; the window itself bounds how long a nonce must be remembered.
 */
export function createSignedRpcHandler(options: SignedRpcHandlerOptions) {
  const nonces: Record<string, number> = {};
  let lastSweep = 0;
  return async (request: Request): Promise<Response> => {
    const encodedHeader = request.headers.get(RPC_DEVICE_HEADER);
    if (!encodedHeader) return transportError(401, 'RPC_DEVICE_REQUIRED', 'Requests must be signed by an enrolled device');
    const header = decodeSignedRpcHeader(encodedHeader);
    if (!header) return transportError(401, 'RPC_DEVICE_INVALID', 'Device signature header is malformed');
    const now = Date.now();
    if (Math.abs(now - header.timestamp) > RPC_SIGNATURE_MAX_SKEW_MS) return transportError(401, 'RPC_SIGNATURE_EXPIRED', 'Device signature timestamp is out of range');
    const device = await options.lookupDevice(header.deviceId);
    if (!device) return transportError(401, 'RPC_DEVICE_UNKNOWN', 'Device is not enrolled or has been revoked');
    const body = new Uint8Array(await request.arrayBuffer());
    const url = new URL(request.url);
    const forwardedTarget = request.headers.get(SIGNED_TARGET_HEADER);
    const signedPath = forwardedTarget?.startsWith('/') && forwardedTarget.length <= 2_048
      ? forwardedTarget
      : `${url.pathname}${url.search}`;
    if (!verifyRpcSignature(header, { method: request.method, path: signedPath, body }, device.signingPublicKey)) {
      return transportError(401, 'RPC_SIGNATURE_INVALID', 'Device signature does not match the request');
    }
    if (now - lastSweep > RPC_SIGNATURE_MAX_SKEW_MS) {
      lastSweep = now;
      for (const [nonce, seenAt] of Object.entries(nonces)) if (now - seenAt > RPC_SIGNATURE_MAX_SKEW_MS) delete nonces[nonce];
    }
    if (nonces[header.nonce] !== undefined) return transportError(409, 'RPC_REPLAY', 'Device request was already consumed');
    nonces[header.nonce] = now;

    const items = envelopeItems(new TextDecoder().decode(body));
    if (!items) return transportError(400, 'RPC_ENVELOPE_INVALID', 'Request envelope could not be read');
    for (const item of items) {
      const kind = options.procedureKind(item.path);
      if (!kind) return transportError(404, 'RPC_PROCEDURE_UNKNOWN', `Unknown procedure ${item.path}`);
      const capability = requiredCapability(item.path, kind);
      if (!device.capabilities.includes(capability)) return transportError(403, 'RPC_FORBIDDEN', `${item.path} requires ${capability}`);
      if (!inputWithinScope(device.scope, item.input, options.workspaceProject)) return transportError(403, 'RPC_OUT_OF_SCOPE', `${item.path} is outside this device's scope`);
      if (item.path.startsWith('environment.') && item.input && typeof item.input === 'object') {
        const input = item.input as Record<string, unknown>;
        if (input.scope === 'global' && device.scope.kind !== 'user') {
          return transportError(403, 'RPC_OUT_OF_SCOPE', 'Global environment changes require account scope');
        }
        if (input.scope === 'project' && device.scope.kind === 'workspace') {
          return transportError(403, 'RPC_OUT_OF_SCOPE', 'Project environment changes require project or account scope');
        }
      }
    }

    const inner = new Request(request.url, { method: request.method, headers: request.headers, body: body.length > 0 ? body : null, signal: request.signal });
    callers.set(inner, { deviceId: device.deviceId, kind: device.kind, label: device.label, scope: device.scope, capabilities: device.capabilities });
    return options.handler(inner);
  };
}
