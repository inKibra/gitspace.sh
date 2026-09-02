import {
  ENCRYPTED_RPC_CONTENT_TYPE,
  RPC_REQUEST_HEADER,
  RPC_DEVICE_HEADER,
  RPC_SESSION_HEADER,
  decodeRequestPayload,
  encodeResponseMetadata,
  encryptRpcRecord,
  decryptRpcRecord,
  frameRpcRecord,
} from '@gitspace/protocol';

export interface EncryptedRpcHandlerOptions {
  handler: (request: Request) => Promise<Response>;
  resolveKey(sessionId: string): Promise<Uint8Array | null> | Uint8Array | null;
  consumeRequestId(sessionId: string, requestId: string): Promise<boolean> | boolean;
}

function transportError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function createEncryptedRpcHandler(options: EncryptedRpcHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('content-type') !== ENCRYPTED_RPC_CONTENT_TYPE) {
      return transportError(415, 'RPC_ENCRYPTION_REQUIRED', 'RPC request must use encrypted transport');
    }
    const sessionId = request.headers.get(RPC_SESSION_HEADER) ?? '';
    const requestId = request.headers.get(RPC_REQUEST_HEADER) ?? '';
    if (!sessionId || !/^[0-9a-f-]{36}$/u.test(requestId)) {
      return transportError(401, 'RPC_SESSION_INVALID', 'Encrypted RPC session headers are invalid');
    }
    const key = await options.resolveKey(sessionId);
    if (!key || key.byteLength !== 32) {
      return transportError(401, 'RPC_SESSION_UNKNOWN', 'Encrypted RPC session is unknown');
    }
    if (!await options.consumeRequestId(sessionId, requestId)) {
      return transportError(409, 'RPC_REPLAY', 'Encrypted RPC request was already consumed');
    }
    let decoded;
    try {
      const sealed = new Uint8Array(await request.arrayBuffer());
      decoded = decodeRequestPayload(await decryptRpcRecord({
        sealed,
        key,
        sessionId,
        requestId,
        direction: 'request',
        sequence: 0,
      }));
    } catch {
      return transportError(400, 'RPC_DECRYPT_FAILED', 'Encrypted RPC request could not be authenticated');
    }

    const innerHeaders = new Headers();
    innerHeaders.set('content-type', decoded.contentType);
    // Sealing wraps a signed request; the device signature rides outside the
    // envelope and is verified against the plaintext by the signed handler.
    const deviceHeader = request.headers.get(RPC_DEVICE_HEADER);
    if (deviceHeader) innerHeaders.set(RPC_DEVICE_HEADER, deviceHeader);
    const inner = await options.handler(new Request(request.url, {
      method: request.method,
      headers: innerHeaders,
      body: Uint8Array.from(decoded.body).buffer,
      signal: request.signal,
    }));
    const reader = inner.body?.getReader() ?? null;
    let sequence = 0;
    let metadataPending = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (metadataPending) {
            metadataPending = false;
            controller.enqueue(frameRpcRecord(await encryptRpcRecord({
              plaintext: encodeResponseMetadata(inner),
              key,
              sessionId,
              requestId,
              direction: 'response',
              sequence,
            })));
            sequence += 1;
            return;
          }
          if (!reader) {
            controller.close();
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          controller.enqueue(frameRpcRecord(await encryptRpcRecord({
            plaintext: chunk.value,
            key,
            sessionId,
            requestId,
            direction: 'response',
            sequence,
          })));
          sequence += 1;
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': ENCRYPTED_RPC_CONTENT_TYPE,
        'cache-control': 'no-store',
      },
    });
  };
}
