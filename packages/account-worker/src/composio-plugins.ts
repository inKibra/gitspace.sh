import type { Composio } from '@composio/core';
import {
  composioToolAllowed,
  type ComposioMcpMaterialization,
  type ComposioPluginCatalog,
  type ComposioPluginTool,
  type McpComposioTransport,
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

/** `@composio/core` and the OpenAI SDK it brings load on first use, not with the worker: evaluating them took about
 * 12 ms of its startup, and Cloudflare rejects a Worker whose startup takes over 1 s of CPU. So the module is imported
 * here, dynamically, and its enums are written as their values (`ConnectedAccountStatuses.ACTIVE` is `'ACTIVE'`). */
async function sdk(env: Env, accountApiKey?: string | null): Promise<Composio> {
  const { Composio } = await import('@composio/core');
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
    const toolkits = await (await sdk(this.env, this.accountApiKey)).toolkits.get({ managedBy: 'composio', sortBy: 'usage', limit: 100 });
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
    const composio = await sdk(this.env, this.accountApiKey);
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
    const account = await (await sdk(this.env, this.accountApiKey)).connectedAccounts.get(connectedAccountId);
    if (account.status === 'ACTIVE' && !account.isDisabled) {
      return { status: 'ready', message: null };
    }
    if (account.status === 'FAILED'
      || account.status === 'EXPIRED'
      || account.status === 'REVOKED'
      || account.isDisabled) {
      return { status: 'failed', message: account.statusReason ?? `Composio account is ${account.status.toLowerCase()}` };
    }
    return { status: 'connecting', message: 'Finish authentication in the browser' };
  }

  async tools(toolkit: string): Promise<ComposioPluginTool[]> {
    const tools = await (await sdk(this.env, this.accountApiKey)).tools.getRawComposioTools({ toolkits: [toolkit], important: false, limit: 1_000 });
    return tools.map((tool) => ({
      slug: tool.slug,
      name: tool.name,
      description: tool.description ?? null,
      readOnly: hasTag(tool.tags, 'readOnlyHint'),
      destructive: hasTag(tool.tags, 'destructiveHint'),
    })).sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Resolves the policy against Composio's current tool list, so newly added tools follow their group's setting. */
  async materialize(principalId: string, transport: McpComposioTransport): Promise<ComposioMcpMaterialization> {
    const enabled = (await this.tools(transport.toolkit)).filter((tool) => composioToolAllowed(transport.toolPolicy, tool)).map((tool) => tool.slug);
    if (enabled.length === 0) throw new Error('This Composio plugin has no allowed tools');
    const session = await (await sdk(this.env, this.accountApiKey)).sessions.create(principalId, {
      sessionPreset: 'direct_tools',
      toolkits: [transport.toolkit],
      tools: { [transport.toolkit]: { enable: enabled } },
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
    await (await sdk(this.env, this.accountApiKey)).connectedAccounts.delete(connectedAccountId);
  }
}
