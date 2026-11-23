import { describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { contractDigest, ok } from 'result-rpc';
import { createFetchHandler, serverRpc } from 'result-rpc/server';
import { deviceProtocolBase64, encodeApiKey } from '@gitspace/protocol/device-grant';
import { gitspaceContract, inspectorArtifactFileContract, inspectorListArtifactsContract, type GitSpaceRpcContext } from '@gitspace/protocol/rpc-contract';
import { createGitSpaceMcpHandler } from '../src/index.js';

const key = encodeApiKey({
  version: 2, userId: 'owner', deviceId: crypto.randomUUID(), signingPrivateKey: deviceProtocolBase64.encode(new Uint8Array(32).fill(9)),
  rpcUrl: 'https://account.test/rpc', enrollUrl: 'https://account.test/v1/devices/enroll',
});
const FILE_URL = 'https://account.test/files/sealed-token';
const artifact = {
  url: 'drive://workspace/shots/home%20page.png', path: 'shots/home page.png', hash: `sha256:${'a'.repeat(64)}`, size: 68, mediaType: 'image/png',
  scope: 'workspace' as const, workspaceId: 'workspace', writtenAt: null,
};

/** The account's artifact procedures over one drive file. */
function account(): typeof globalThis.fetch {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const file = server.implement(inspectorArtifactFileContract).handler(async () => ok({
    url: FILE_URL, downloadUrl: `${FILE_URL}?download=1`, size: artifact.size, mediaType: artifact.mediaType, expiresAt: new Date(Date.now() + 7_200_000).toISOString(), hash: artifact.hash,
  }));
  const list = server.implement(inspectorListArtifactsContract).handler(async () => ok({ artifacts: [artifact], scopes: [{ workspaceId: 'workspace', generation: 1 }] }));
  const rpc = createFetchHandler({ router: server.router({ inspector: { artifacts: { file, list } } }), endpoint: '/rpc', contractVersion: contractDigest(gitspaceContract), createContext: () => ({}) });
  return Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => rpc(new Request(input, init)), { preconnect: globalThis.fetch.preconnect });
}

async function connect() {
  const handler = createGitSpaceMcpHandler({ key, capabilities: ['rpc.read', 'rpc.write', 'session.prompt'], scope: { kind: 'user' }, fetch: account() });
  const client = new Client({ name: 'gitspace-file-links-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('https://account.test/mcp'), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  return client;
}

/** Every property in a schema document (definitions included) whose own schema has `annotation`, as
 * `<property>=<value>`. */
function annotated(schema: unknown, annotation: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'properties' && item && typeof item === 'object') {
        for (const [name, property] of Object.entries(item)) {
          if (property && typeof property === 'object' && annotation in property) found.push(`${name}=${String(Reflect.get(property, annotation))}`);
        }
      }
      visit(item);
    }
  };
  visit(schema);
  return [...new Set(found)].sort();
}

describe('files by link over MCP', () => {
  test('a client listing tools finds every base64 field by contentEncoding and every link by format uri', async () => {
    const client = await connect();
    try {
      const tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
      const tool = (name: string) => {
        const found = tools.get(name);
        if (!found) throw new Error(`${name} is not listed`);
        return found;
      };
      expect(annotated(tool('gitspace_inspector_artifacts_read_page').outputSchema, 'contentEncoding')).toEqual(['base64=base64']);
      expect(annotated(tool('gitspace_inspector_transcript_page').outputSchema, 'contentEncoding')).toEqual(['data=base64']);
      expect(annotated(tool('gitspace_inspector_transcript_page').outputSchema, 'contentMediaType')).toEqual(['data=image/jpeg', 'data=image/png', 'data=image/webp']);
      expect(annotated(tool('gitspace_inspector_artifacts_write').inputSchema, 'contentEncoding')).toEqual(['base64=base64']);
      expect(annotated(tool('gitspace_inspector_artifacts_upload_chunk').inputSchema, 'contentEncoding')).toEqual(['data=base64']);
      // Links are the properties marked format uri (date-time and others are formats too).
      const links = (schema: unknown) => annotated(schema, 'format').filter(entry => entry.endsWith('=uri'));
      expect(links(tool('gitspace_inspector_artifacts_file').outputSchema)).toEqual(['downloadUrl=uri', 'url=uri']);
      expect(links(tool('gitspace_inspector_transcript_page').outputSchema)).toEqual(['url=uri']);
      for (const name of ['gitspace_inspector_artifacts_shares_create', 'gitspace_inspector_guide_shares_create']) expect(links(tool(name).outputSchema)).toEqual(['url=uri']);
      expect(links(tool('gitspace_inspector_artifacts_import').inputSchema)).toEqual(['url=uri']);
      expect(links(tool('gitspace_runtime_session').inputSchema)).toEqual(['url=uri']);
    } finally { await client.close(); }
  });

  test('a result naming one file carries a resource_link to it beside its JSON, and a list carries none', async () => {
    const client = await connect();
    try {
      const file = await client.callTool({ name: 'gitspace_inspector_artifacts_file', arguments: { spaceId: 'workspace', expectedGeneration: 0, url: artifact.url, hash: null } });
      expect(file.content).toEqual([
        { type: 'text', text: JSON.stringify(file.structuredContent) },
        { type: 'resource_link', uri: FILE_URL, name: 'home page.png', mimeType: 'image/png', size: 68 },
      ]);
      const listed = await client.callTool({ name: 'gitspace_inspector_artifacts_list', arguments: { spaceId: 'workspace', expectedGeneration: 0 } });
      expect(listed.content).toEqual([{ type: 'text', text: JSON.stringify(listed.structuredContent) }]);
    } finally { await client.close(); }
  });
});
