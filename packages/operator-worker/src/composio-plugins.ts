import { Composio, ConnectedAccountStatuses, SessionPreset } from '@composio/core';
import type {
  ComposioMcpMaterialization,
  ComposioPluginCatalog,
  ComposioPluginTool,
  McpComposioTransport,
} from '@gitspace/protocol';

export interface ComposioAuthorizationStart {
  connectedAccountId: string;
  redirectUrl: string;
}

export interface ComposioAccountStatus {
  status: 'connecting' | 'ready' | 'failed';
  message: string | null;
}

export interface ComposioPluginProvider {
  catalog(): Promise<ComposioPluginCatalog>;
  authorize(principalId: string, toolkit: string, callbackUrl: string): Promise<ComposioAuthorizationStart>;
  status(connectedAccountId: string): Promise<ComposioAccountStatus>;
  tools(toolkit: string): Promise<ComposioPluginTool[]>;
  materialize(principalId: string, transport: McpComposioTransport): Promise<ComposioMcpMaterialization>;
  disconnect(connectedAccountId: string): Promise<void>;
}

function requireApiKey(env: Env, accountApiKey?: string | null): string {
  const value = accountApiKey?.trim() || env.COMPOSIO_API_KEY?.trim();
  if (!value) throw new Error('Composio is not configured. Add an API key in Settings → Connections.');
  return value;
}

function sdk(env: Env, accountApiKey?: string | null): Composio {
  return new Composio({ apiKey: requireApiKey(env, accountApiKey), allowTracking: false });
}

function hasTag(tags: readonly string[] | undefined, expected: string): boolean {
  return tags?.some((tag) => tag.toLowerCase() === expected.toLowerCase()) === true;
}

export class ComposioPluginGateway implements ComposioPluginProvider {
  constructor(
    private readonly env: Env,
    private readonly accountApiKey?: string | null,
  ) {}

  async catalog(): Promise<ComposioPluginCatalog> {
    if (!this.accountApiKey?.trim() && !this.env.COMPOSIO_API_KEY?.trim()) return { configured: false, toolkits: [] };
    const toolkits = await sdk(this.env, this.accountApiKey).toolkits.get({ managedBy: 'composio', sortBy: 'usage', limit: 100 });
    return {
      configured: true,
      toolkits: toolkits.map((toolkit) => ({
        slug: toolkit.slug,
        name: toolkit.name,
        description: toolkit.meta.description ?? null,
        logoUrl: toolkit.meta.logo ?? null,
        toolsCount: toolkit.meta.toolsCount ?? 0,
      })),
    };
  }

  async authorize(principalId: string, toolkit: string, callbackUrl: string): Promise<ComposioAuthorizationStart> {
    const composio = sdk(this.env, this.accountApiKey);
    const session = await composio.sessions.create(principalId, {
      toolkits: [toolkit],
      manageConnections: false,
      sandbox: { enable: false },
    });
    const request = await session.authorize(toolkit, { callbackUrl });
    if (!request.redirectUrl) throw new Error(`Composio did not return an authorization URL for ${toolkit}`);
    return { connectedAccountId: request.id, redirectUrl: request.redirectUrl };
  }

  async status(connectedAccountId: string): Promise<ComposioAccountStatus> {
    const account = await sdk(this.env, this.accountApiKey).connectedAccounts.get(connectedAccountId);
    if (account.status === ConnectedAccountStatuses.ACTIVE && !account.isDisabled) {
      return { status: 'ready', message: null };
    }
    if (account.status === ConnectedAccountStatuses.FAILED
      || account.status === ConnectedAccountStatuses.EXPIRED
      || account.status === ConnectedAccountStatuses.REVOKED
      || account.isDisabled) {
      return { status: 'failed', message: account.statusReason ?? `Composio account is ${account.status.toLowerCase()}` };
    }
    return { status: 'connecting', message: 'Finish authentication in the browser' };
  }

  async tools(toolkit: string): Promise<ComposioPluginTool[]> {
    const tools = await sdk(this.env, this.accountApiKey).tools.getRawComposioTools({ toolkits: [toolkit], important: false, limit: 1_000 });
    return tools.map((tool) => ({
      slug: tool.slug,
      name: tool.name,
      description: tool.description ?? null,
      readOnly: hasTag(tool.tags, 'readOnlyHint'),
      destructive: hasTag(tool.tags, 'destructiveHint'),
    })).sort((left, right) => left.name.localeCompare(right.name));
  }

  async materialize(principalId: string, transport: McpComposioTransport): Promise<ComposioMcpMaterialization> {
    if (transport.allowedTools.length === 0) throw new Error('This Composio plugin has no allowed tools');
    const session = await sdk(this.env, this.accountApiKey).sessions.create(principalId, {
      sessionPreset: SessionPreset.DIRECT_TOOLS,
      toolkits: [transport.toolkit],
      tools: { [transport.toolkit]: { enable: transport.allowedTools } },
      connectedAccounts: { [transport.toolkit]: transport.connectedAccountId },
      manageConnections: false,
      sandbox: { enable: false },
      mcp: true,
    });
    return {
      type: session.mcp.type,
      url: session.mcp.url,
      headers: session.mcp.headers ?? {},
      timeoutMs: 30_000,
    };
  }

  async disconnect(connectedAccountId: string): Promise<void> {
    await sdk(this.env, this.accountApiKey).connectedAccounts.delete(connectedAccountId);
  }
}
