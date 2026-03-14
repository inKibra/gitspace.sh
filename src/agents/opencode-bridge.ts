export type OpenCodeHttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface OpenCodeBridgeRequest {
  requestId: string;
  workspaceId: string;
  method: OpenCodeHttpMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

export interface OpenCodeBridgeResponse {
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

export interface OpenCodeBridgeStreamOpen {
  requestId: string;
  workspaceId: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

export interface OpenCodeBridgeStreamOpened {
  requestId: string;
}

export interface OpenCodeBridgeStreamEvent {
  requestId: string;
  event?: string;
  data: string;
  id?: string;
}

export interface OpenCodeBridgeStreamClosed {
  requestId: string;
}

export interface OpenCodeBridgeStreamError {
  requestId: string;
  message: string;
}

export interface OpenCodeBridgeStreamClose {
  requestId: string;
}

export interface OpenCodeBridgeBackend {
  requestOpenCode(request: Omit<OpenCodeBridgeRequest, 'requestId'>): Promise<OpenCodeBridgeResponse>;
  subscribeOpenCode(
    request: Omit<OpenCodeBridgeStreamOpen, 'requestId'>,
    handler: (event: OpenCodeBridgeStreamEvent) => void
  ): Promise<() => Promise<void>>;
}

export function encodeBridgeBody(body: Uint8Array | ArrayBuffer | string | undefined): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === 'string') {
    return Buffer.from(body).toString('base64');
  }
  return Buffer.from(body instanceof Uint8Array ? body : new Uint8Array(body)).toString('base64');
}

export function decodeBridgeBody(bodyBase64: string | undefined): Uint8Array {
  if (!bodyBase64) {
    return new Uint8Array(0);
  }
  return new Uint8Array(Buffer.from(bodyBase64, 'base64'));
}

export function buildOpenCodeUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>
): string {
  const url = new URL(path, `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
