import type { Server } from 'bun';

export interface MockUpstream {
  server: Server<any>;
  githubApiBase: string;
  githubOauthBase: string;
  cloudflareApiBase: string;
  registerGitHubUser: (token: string, user: { id: number; login: string; name: string; email: string; avatar_url: string }) => void;
  close: () => void;
}

interface TunnelRecord {
  id: string;
  name: string;
  token: string;
}

export function startMockUpstream(): MockUpstream {
  const tunnels = new Map<string, TunnelRecord>();
  const dnsRecords = new Map<string, { id: string; name: string; content: string }>();
  const customHostnames = new Map<string, { id: string; hostname: string; status: string }>();
  const githubUsers = new Map<string, { id: number; login: string; name: string; email: string; avatar_url: string }>();

  githubUsers.set('github-access-token', {
    id: 12345,
    login: 'octocat',
    name: 'The Octocat',
    email: 'octocat@example.com',
    avatar_url: 'https://avatars.example.com/octocat',
  });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/login/oauth/access_token' && request.method === 'POST') {
        return Response.json({ access_token: 'github-access-token' });
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
        return request.json().then((body: any) => {
          const name = body?.name ?? 'tunnel';
          const tunnel = {
            id: crypto.randomUUID(),
            name,
            token: `token-${name}-${crypto.randomUUID()}`,
          };
          tunnels.set(name, tunnel);
          return Response.json({ success: true, result: { id: tunnel.id, token: tunnel.token } });
        });
      }

      if (path.includes('/cfd_tunnel/') && path.endsWith('/configurations') && request.method === 'PUT') {
        return Response.json({ success: true });
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
        return request.json().then((body: any) => {
          const record = {
            id: crypto.randomUUID(),
            name: `${body.name}.gitspace.sh`,
            content: body.content,
          };
          dnsRecords.set(record.id, record);
          return Response.json({ success: true, result: { id: record.id } });
        });
      }

      if (path.includes('/dns_records/') && request.method === 'PUT') {
        const recordId = path.split('/').at(-1) ?? '';
        return request.json().then((body: any) => {
          dnsRecords.set(recordId, {
            id: recordId,
            name: `${body.name}.gitspace.sh`,
            content: body.content,
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
        return request.json().then((body: any) => {
          const record = {
            id: crypto.randomUUID(),
            hostname: body.hostname,
            status: 'pending',
          };
          customHostnames.set(record.id, record);
          return Response.json({ success: true, result: record });
        });
      }

      if (path.includes('/custom_hostnames/') && request.method === 'GET') {
        const id = path.split('/').at(-1) ?? '';
        const record = customHostnames.get(id);
        if (!record) {
          return new Response('Not found', { status: 404 });
        }
        return Response.json({ success: true, result: { ...record, ssl: { status: 'pending' } } });
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
    registerGitHubUser: (token, user) => {
      githubUsers.set(token, user);
    },
    close: () => server.stop(true),
  };
}
