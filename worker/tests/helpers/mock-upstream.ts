import type { Server } from 'bun';

export interface MockUpstream {
  server: Server;
  githubApiBase: string;
  githubOauthBase: string;
  cloudflareApiBase: string;
  cfArtifactsApiBase: string;
  cfArtifactsApiToken: string;
  listArtifactRepos: () => Array<{ id: string; name: string; gitUrl: string }>;
  getLastArtifactTokenRequest: () => { repoId: string; access: string; ttlSeconds: number } | null;
  getLastGithubOauthTokenRequest: () => Record<string, unknown> | null;
  failNextTunnelCreate: (tunnelName: string, status?: number, body?: string) => void;
  failNextCustomHostnameCreate: (hostname: string, status?: number, body?: string) => void;
  registerGitHubUser: (token: string, user: { id: number; login: string; name: string; email: string; avatar_url: string }) => void;
  listTunnelConfigurations: () => Array<{ tunnelId: string; ingress: Array<{ hostname?: string; service: string }> }>;
  listDnsRecords: () => Array<{ id: string; name: string; content: string }>;
  close: () => void;
}

interface TunnelRecord {
  id: string;
  name: string;
  token: string;
  configSource: 'cloudflare' | 'local';
  tunnelSecret?: string;
}

interface TunnelConfigurationRecord {
  tunnelId: string;
  ingress: Array<{ hostname?: string; service: string }>;
}

interface CustomHostnameRecord {
  id: string;
  hostname: string;
  sslMethod: 'http' | 'txt' | 'email';
  wildcard: boolean;
  delegationSuffix: string;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonObject(request: Request): Promise<JsonObject> {
  const body: unknown = await request.json();
  return isJsonObject(body) ? body : {};
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function isTunnelIngressRule(value: unknown): value is { hostname?: string; service: string } {
  if (!isJsonObject(value) || typeof value.service !== 'string') {
    return false;
  }

  return value.hostname === undefined || typeof value.hostname === 'string';
}


export function startMockUpstream(): MockUpstream {
  const tunnels = new Map<string, TunnelRecord>();
  const dnsRecords = new Map<string, { id: string; name: string; content: string }>();
  const customHostnames = new Map<string, CustomHostnameRecord>();
  const tunnelConfigurations = new Map<string, TunnelConfigurationRecord>();
  const githubUsers = new Map<string, { id: number; login: string; name: string; email: string; avatar_url: string }>();
  let lastGithubOauthTokenRequest: Record<string, unknown> | null = null;
  const failingTunnelCreates = new Map<string, { status: number; body: string }>();
  const failingCustomHostnameCreates = new Map<string, { status: number; body: string }>();
  const artifactRepos = new Map<string, { id: string; name: string; gitUrl: string }>();
  let lastArtifactTokenRequest: { repoId: string; access: string; ttlSeconds: number } | null = null;
  const cfArtifactsApiToken = 'cf-artifacts-api-token';

  githubUsers.set('github-access-token', {
    id: 12345,
    login: 'octocat',
    name: 'The Octocat',
    email: 'octocat@example.com',
    avatar_url: 'https://avatars.example.com/octocat',
  });

  const delegatedDcvSuffix = 'f98fb997bce4f333.dcv.cloudflare.com';

  function normalizeDnsRecordName(name: string): string {
    return name.endsWith('.gitspace.sh') ? name : `${name}.gitspace.sh`;
  }

  function getExpectedDelegatedDcvTarget(hostname: string): string {
    return `${hostname}.${delegatedDcvSuffix}`;
  }

  function getCustomHostnameStatus(record: CustomHostnameRecord): { status: string; sslStatus: string } {
    if (record.sslMethod === 'txt' && record.wildcard) {
      const expectedName = `_acme-challenge.${record.hostname}`;
      const expectedTarget = getExpectedDelegatedDcvTarget(record.hostname);
      const delegatedRecord = Array.from(dnsRecords.values()).find((dnsRecord) => dnsRecord.name === expectedName);
      const delegatedReady = delegatedRecord?.content === expectedTarget;
      return delegatedReady
        ? { status: 'active', sslStatus: 'active' }
        : { status: 'pending', sslStatus: 'pending_validation' };
    }

    return { status: 'active', sslStatus: 'active' };
  }

  function buildDelegatedDcvRecords(record: CustomHostnameRecord) {
    return [{
      cname: `_acme-challenge.${record.hostname}`,
      cname_target: getExpectedDelegatedDcvTarget(record.hostname),
      status: getCustomHostnameStatus(record).sslStatus === 'active' ? 'active' : 'pending',
      txt_name: `_acme-challenge.${record.hostname}`,
      txt_value: `txt-${record.id}`,
    }];
  }


  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      // CF Artifacts git hosting mock (best-effort REST shapes; see
      // src/services/artifacts-upstream.ts for the deploy-time caveats)
      if (path.startsWith('/artifacts-host/')) {
        const authToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (authToken !== cfArtifactsApiToken) {
          return new Response('Unauthorized', { status: 401 });
        }

        if (path === '/artifacts-host/repos' && request.method === 'POST') {
          return readJsonObject(request).then((body) => {
            const name = stringField(body.name, '');
            if (!name) {
              return new Response('Bad request', { status: 400 });
            }
            let repo = Array.from(artifactRepos.values()).find((entry) => entry.name === name);
            if (!repo) {
              repo = {
                id: `cfrepo_${crypto.randomUUID()}`,
                name,
                gitUrl: `https://artifacts-upstream.example.com/${name}.git`,
              };
              artifactRepos.set(repo.id, repo);
            }
            return Response.json({ success: true, result: { id: repo.id, git_url: repo.gitUrl } });
          });
        }

        const tokenMatch = path.match(/^\/artifacts-host\/repos\/([^/]+)\/tokens$/);
        if (tokenMatch && request.method === 'POST') {
          const repoId = decodeURIComponent(tokenMatch[1] ?? '');
          if (!artifactRepos.has(repoId)) {
            return new Response('Not found', { status: 404 });
          }
          return readJsonObject(request).then((body) => {
            const access = body.access === 'read' ? 'read' : 'write';
            const ttlSeconds = typeof body.ttl_seconds === 'number' ? body.ttl_seconds : 3600;
            lastArtifactTokenRequest = { repoId, access, ttlSeconds };
            return Response.json({
              success: true,
              result: {
                token: `cfa_${access}_${crypto.randomUUID().replace(/-/g, '')}`,
                expires_at: Date.now() + ttlSeconds * 1000,
              },
            });
          });
        }

        return new Response(`Unhandled artifacts route: ${request.method} ${path}`, { status: 404 });
      }

      if (path === '/login/oauth/access_token' && request.method === 'POST') {
        return readJsonObject(request).then((body) => {
          lastGithubOauthTokenRequest = body;
          return Response.json({ access_token: 'github-access-token' });
        });
      }

      if (path === '/user' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        const user = githubUsers.get(token);
        if (!user) {
          return new Response('Unauthorized', { status: 401 });
        }

        return Response.json(user);
      }

      if (path === '/user/emails' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        const user = githubUsers.get(token);
        if (!user) {
          return new Response('Unauthorized', { status: 401 });
        }

        return Response.json([
          { email: user.email, primary: true, verified: true },
        ]);
      }

      if (path.includes('/cfd_tunnel') && request.method === 'GET' && path.endsWith('/token')) {
        const tunnelId = path.split('/').at(-2) ?? '';
        const tunnel = Array.from(tunnels.values()).find((entry) => entry.id === tunnelId);
        if (!tunnel) {
          return new Response('Not found', { status: 404 });
        }
        return Response.json({ success: true, result: tunnel.token });
      }

      if (path.endsWith('/cfd_tunnel') && request.method === 'GET') {
        const name = url.searchParams.get('name');
        const result = name && tunnels.has(name) ? [tunnels.get(name)] : [];
        return Response.json({ success: true, result });
      }

      if (path.endsWith('/cfd_tunnel') && request.method === 'POST') {
        return readJsonObject(request).then((body) => {
          const name = stringField(body.name, 'tunnel');
          const configuredFailure = failingTunnelCreates.get(name);
          if (configuredFailure) {
            failingTunnelCreates.delete(name);
            return new Response(configuredFailure.body, { status: configuredFailure.status });
          }

          const configSource = body.config_src === 'local' ? 'local' : 'cloudflare';
          const tunnel = {
            id: crypto.randomUUID(),
            name,
            token: `token-${name}-${crypto.randomUUID()}`,
            configSource,
            tunnelSecret: typeof body.tunnel_secret === 'string' ? body.tunnel_secret : undefined,
          } satisfies TunnelRecord;
          tunnels.set(name, tunnel);
          return Response.json({
            success: true,
            result: configSource === 'local'
              ? { id: tunnel.id, name: tunnel.name, config_src: tunnel.configSource }
              : { id: tunnel.id, name: tunnel.name, token: tunnel.token, config_src: tunnel.configSource },
          });
        });
      }

      if (path.includes('/cfd_tunnel/') && path.endsWith('/configurations') && request.method === 'PUT') {
        return readJsonObject(request).then((body) => {
          const tunnelId = path.split('/').at(-2) ?? '';
          const config = isJsonObject(body.config) ? body.config : {};
          const ingress = config.ingress;
          tunnelConfigurations.set(tunnelId, {
            tunnelId,
            ingress: Array.isArray(ingress) ? ingress.filter(isTunnelIngressRule) : [],
          });
          return Response.json({ success: true });
        });
      }

      if (path.includes('/cfd_tunnel/') && path.endsWith('/connections') && request.method === 'DELETE') {
        return Response.json({ success: true });
      }

      if (path.includes('/cfd_tunnel/') && request.method === 'DELETE') {
        const tunnelId = path.split('/').at(-1) ?? '';
        const existing = Array.from(tunnels.entries()).find(([, tunnel]) => tunnel.id === tunnelId);
        if (existing) {
          tunnels.delete(existing[0]);
        }
        return Response.json({ success: true });
      }

      if (path.endsWith('/dns_records') && request.method === 'GET') {
        const name = url.searchParams.get('name') ?? '';
        const matches = Array.from(dnsRecords.values()).filter((record) => record.name === name);
        return Response.json({ success: true, result: matches });
      }

      if (path.endsWith('/dns_records') && request.method === 'POST') {
        return readJsonObject(request).then((body) => {
          const record = {
            id: crypto.randomUUID(),
            name: normalizeDnsRecordName(stringField(body.name, '')),
            content: stringField(body.content, ''),
          };
          dnsRecords.set(record.id, record);
          return Response.json({ success: true, result: { id: record.id } });
        });
      }

      if (path.includes('/dns_records/') && request.method === 'PUT') {
        const recordId = path.split('/').at(-1) ?? '';
        return readJsonObject(request).then((body) => {
          dnsRecords.set(recordId, {
            id: recordId,
            name: normalizeDnsRecordName(stringField(body.name, '')),
            content: stringField(body.content, ''),
          });
          return Response.json({ success: true, result: { id: recordId } });
        });
      }

      if (path.includes('/dns_records/') && request.method === 'DELETE') {
        const recordId = path.split('/').at(-1) ?? '';
        dnsRecords.delete(recordId);
        return Response.json({ success: true });
      }

      if (path.endsWith('/custom_hostnames') && request.method === 'POST') {
        return readJsonObject(request).then((body) => {
          const hostname = stringField(body.hostname, 'hostname.gitspace.sh');
          const configuredFailure = failingCustomHostnameCreates.get(hostname);
          if (configuredFailure) {
            failingCustomHostnameCreates.delete(hostname);
            return new Response(configuredFailure.body, { status: configuredFailure.status });
          }

          const ssl = isJsonObject(body.ssl) ? body.ssl : {};
          const method = ssl.method === 'txt' || ssl.method === 'email' ? ssl.method : 'http';
          const record: CustomHostnameRecord = {
            id: crypto.randomUUID(),
            hostname,
            sslMethod: method,
            wildcard: Boolean(ssl.wildcard),
            delegationSuffix: delegatedDcvSuffix,
          };
          customHostnames.set(record.id, record);
          const status = getCustomHostnameStatus(record);
          return Response.json({
            success: true,
            result: { id: record.id, hostname: record.hostname, status: status.status },
          });
        });
      }

      if (path.includes('/custom_hostnames/') && request.method === 'GET') {
        const id = path.split('/').at(-1) ?? '';
        const record = customHostnames.get(id);
        if (!record) {
          return new Response('Not found', { status: 404 });
        }
        const status = getCustomHostnameStatus(record);
        return Response.json({
          success: true,
          result: {
            id: record.id,
            hostname: record.hostname,
            status: status.status,
            ssl: {
              status: status.sslStatus,
              dcv_delegation_records: buildDelegatedDcvRecords(record),
            },
          },
        });
      }

      if (path.includes('/custom_hostnames/') && request.method === 'PATCH') {
        const id = path.split('/').at(-1) ?? '';
        const record = customHostnames.get(id);
        if (!record) {
          return new Response('Not found', { status: 404 });
        }
        const status = getCustomHostnameStatus(record);
        return Response.json({
          success: true,
          result: {
            id: record.id,
            hostname: record.hostname,
            status: status.status,
            ssl: {
              status: status.sslStatus,
              dcv_delegation_records: buildDelegatedDcvRecords(record),
            },
          },
        });
      }

      if (path.includes('/custom_hostnames/') && request.method === 'DELETE') {
        const id = path.split('/').at(-1) ?? '';
        customHostnames.delete(id);
        return Response.json({ success: true });
      }

      return new Response(`Unhandled upstream route: ${request.method} ${path}`, { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    server,
    githubApiBase: base,
    githubOauthBase: base,
    cloudflareApiBase: `${base}/client/v4`,
    cfArtifactsApiBase: `${base}/artifacts-host`,
    cfArtifactsApiToken,
    listArtifactRepos: () => Array.from(artifactRepos.values()),
    getLastArtifactTokenRequest: () => lastArtifactTokenRequest,
    getLastGithubOauthTokenRequest: () => lastGithubOauthTokenRequest,
    failNextTunnelCreate: (tunnelName, status = 500, body = 'tunnel create failed') => {
      failingTunnelCreates.set(tunnelName, { status, body });
    },
    failNextCustomHostnameCreate: (hostname, status = 500, body = 'custom hostname create failed') => {
      failingCustomHostnameCreates.set(hostname, { status, body });
    },
    registerGitHubUser: (token, user) => {
      githubUsers.set(token, user);
    },
    listTunnelConfigurations: () => Array.from(tunnelConfigurations.values()).map((entry) => ({
      tunnelId: entry.tunnelId,
      ingress: entry.ingress.map((rule) => ({
        hostname: rule.hostname,
        service: rule.service,
      })),
    })),
    listDnsRecords: () => Array.from(dnsRecords.values()),
    close: () => server.stop(true),
  };
}
