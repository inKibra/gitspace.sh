const objects = new Map<string, Uint8Array>();
const spaces = new Map<string, Record<string, unknown>>();
const definitions = new Map<string, Record<string, unknown>>();
const machines = new Map<string, Record<string, unknown>>();
let gitIdentity: Record<string, unknown> | null = null;

Bun.serve({
  hostname: '0.0.0.0',
  port: 8791,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/settings/events') return new Response('offline in fixture', { status: 404 });
    const data = /^\/v1\/data\/(.+)$/u.exec(url.pathname);
    if (data) {
      const key = decodeURIComponent(data[1]!);
      if (request.method === 'PUT') { objects.set(key, new Uint8Array(await request.arrayBuffer())); return new Response(null, { status: 201 }); }
      const bytes = objects.get(key);
      return bytes ? new Response(Uint8Array.from(bytes).buffer) : new Response(null, { status: 404 });
    }
    if (url.pathname !== '/v1/control' || request.method !== 'POST') return new Response('not found', { status: 404 });
    const body = await request.json() as { operation?: string; payload?: Record<string, unknown>; machineId?: string };
    const payload = body.payload ?? {};
    let value: unknown;
    switch (body.operation) {
      case 'settings.omp.get': value = { generation: 0, content: '', checksum: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', updatedAt: new Date(0).toISOString(), updatedBy: 'fixture' }; break;
      case 'settings.get': value = { version: 1, revision: 0, onboardingComplete: false, profile: { displayName: '', handle: null }, git: { authorName: '', authorEmail: '' }, defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, updatedAt: new Date(0).toISOString(), updatedBy: 'fixture' }; break;
      case 'settings.git.get': value = gitIdentity; break;
      case 'settings.git.update': gitIdentity = { ...payload, generation: 1, updatedAt: new Date().toISOString(), updatedBy: body.machineId ?? 'sandbox' }; delete gitIdentity.expectedGeneration; value = gitIdentity; break;
      case 'storage.binding': value = { bucket: 'gitspace-test', endpoint: 'http://host.docker.internal:9000', region: 'us-east-1' }; break;
      case 'storage.credentials': value = { accessKeyId: 'GITSPACETEST', secretAccessKey: 'gitspace-test-secret', sessionToken: '', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; break;
      case 'catalog.space.put': definitions.set(String(payload.spaceId), payload); value = payload; break;
      case 'catalog.space.get': value = definitions.get(String(payload.spaceId)) ?? null; break;
      case 'catalog.space.list': value = [...definitions.values()]; break;
      case 'catalog.machine.list': value = [...machines.values()]; break;
      case 'catalog.machine.put': machines.set(String(payload.id), payload); value = payload; break;
      case 'space.bootstrap': {
        const id = String(payload.spaceId); const existing = spaces.get(id);
        value = existing ?? { projectId: payload.projectId, spaceId: id, state: 'open', machineId: payload.machineId, generation: 1, checkpointRevision: 0, manifestKey: null, manifestHash: null };
        spaces.set(id, value as Record<string, unknown>); break;
      }
      case 'space.get': value = spaces.get(String(payload.spaceId)) ?? null; break;
      case 'space.beginClose': {
        const state = spaces.get(String(payload.spaceId))!; state.state = 'closing'; state.checkpointRevision = Number(state.checkpointRevision) + 1; value = { revision: state.checkpointRevision, previousRevision: null }; break;
      }
      case 'space.commitClosed': {
        const state = spaces.get(String(payload.spaceId))!; state.state = 'closed'; state.machineId = null; state.generation = Number(state.generation) + 1; state.manifestKey = payload.manifestKey; state.manifestHash = payload.manifestHash; value = null; break;
      }
      case 'space.beginOpen': {
        const state = spaces.get(String(payload.spaceId))!; state.state = 'opening'; state.machineId = body.machineId; state.generation = Number(state.generation) + 1; value = { revision: state.checkpointRevision, manifestKey: state.manifestKey, manifestHash: state.manifestHash }; break;
      }
      case 'space.commitOpen': { const state = spaces.get(String(payload.spaceId))!; state.state = 'open'; value = null; break; }
      case 'space.abortClose': { const state = spaces.get(String(payload.spaceId))!; state.state = 'open'; value = null; break; }
      case 'space.failOpen': { const state = spaces.get(String(payload.spaceId))!; state.state = 'closed'; state.machineId = null; value = null; break; }
      default: return Response.json({ status: 'error', error: { code: 'UNSUPPORTED', message: body.operation ?? 'unknown' } }, { status: 400 });
    }
    return Response.json({ status: 'ok', value });
  },
});
console.log('fake control ready');
