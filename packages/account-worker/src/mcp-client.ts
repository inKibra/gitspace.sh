import { Client, SSEClientTransport, StreamableHTTPClientTransport, type FetchLike, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';

/**
 * A cloud agent's connection to a person's network MCP server, opened for one call. Streamable HTTP probes
 * `server/discover` and speaks 2026-07-28 to a server that answers it, else falls back to the 2025 `initialize`
 * handshake; HTTP+SSE predates the 2026-07-28 revision, so it always opens with `initialize`. Redirects are followed
 * only within the server's origin (the transports' default `same-origin` policy), so headers and tokens never leave it.
 * `fetch` replaces the global fetch (tests serve a server in-process).
 */
export async function connectMcp(input: { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; authProvider?: OAuthClientProvider; timeout: number; signal?: AbortSignal; fetch?: FetchLike }): Promise<Client> {
  const headers = input.headers ?? {};
  const send = input.fetch ?? fetch;
  const options = { redirectPolicy: 'same-origin' as const, requestInit: { headers }, ...(input.authProvider ? { authProvider: input.authProvider } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) };
  const transport = input.type === 'http'
    ? new StreamableHTTPClientTransport(new URL(input.url), options)
    : new SSEClientTransport(new URL(input.url), { ...options, eventSourceInit: { fetch: (url, init) => send(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }) } });
  const client = new Client({ name: 'gitspace-cloud', version: '1.0.0' }, { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator(), ...(input.type === 'http' ? { versionNegotiation: { mode: 'auto' } } : {}) });
  try {
    await client.connect(transport, { timeout: input.timeout, ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

/** The server identity a connection status records (`serverVersion`): its name and version as it reports them, and the
 * protocol revision and era the connection negotiated. */
export function mcpServerIdentity(client: Client): string {
  const server = client.getServerVersion();
  return `${server ? `${server.name} ${server.version}` : 'unnamed server'} · MCP ${client.getNegotiatedProtocolVersion() ?? 'unknown'} (${client.getProtocolEra() ?? 'legacy'} era)`;
}
