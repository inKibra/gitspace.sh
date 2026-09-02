export interface GitSpaceRpcHttpServerOptions {
  handler: (request: Request) => Promise<Response>;
  hostname?: string;
  port?: number;
  additionalFetch?: (request: Request) => Response | null | Promise<Response | null>;
}

export interface GitSpaceRpcHttpServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-gitspace-device, x-gitspace-rpc-session, x-gitspace-rpc-request, x-result-rpc-contract, last-event-id',
  'access-control-expose-headers': 'x-result-rpc-contract',
  'access-control-max-age': '600',
};

export function startGitSpaceRpcHttpServer(options: GitSpaceRpcHttpServerOptions): GitSpaceRpcHttpServer {
  const hostname = options.hostname ?? '127.0.0.1';
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(request) {
      const additional = await options.additionalFetch?.(request);
      if (additional) return additional;
      const url = new URL(request.url);
      // Browsers reach other machines directly; authentication is the device
      // signature over the body, so the origin carries no trust and CORS is open.
      if (url.pathname === '/health' || url.pathname === '/rpc') {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
        const response = url.pathname === '/health'
          ? Response.json({
              status: 'ok',
              protocol: 'result-rpc',
              transport: 'http-stream',
              environmentId: process.env.GITSPACE_ENVIRONMENT_ID ?? null,
              generation: process.env.GITSPACE_GENERATION_HASH ?? null,
              release: process.env.GITSPACE_RELEASE_SHA ?? null,
            })
          : await options.handler(request);
        for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
        return response;
      }
      return new Response('Not found', { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) {
    void server.stop(true);
    throw new Error('RPC server did not expose a listening port');
  }
  return {
    hostname,
    port,
    url: `http://${hostname}:${port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
