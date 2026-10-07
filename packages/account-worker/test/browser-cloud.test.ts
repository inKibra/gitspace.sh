import { expect, test } from 'vitest';
import { AccountBrowserRuntime } from '../src/browser-runtime.js';
import { RuntimeAccountBrowserAuthorizationSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';

const RequestFrame = z.object({ id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()), sessionId: z.string().optional() });
test.each(['Fetch', 'Image', 'Document', 'Redirect', 'Unknown'])('cloud permits explicit service navigation but denies ordinary-document %s access', async resource => {
  const store = new Map<string, unknown>();
  const storage = { async get(key: string) { return store.get(key); }, async put(key: string, value: unknown) { store.set(key, value); }, async delete(key: string) { return store.delete(key); } };
  const calls: Array<{ url: string; method: string }> = [];
  const fulfilled = Promise.withResolvers<z.infer<typeof RequestFrame>>();
  const denied = Promise.withResolvers<z.infer<typeof RequestFrame>>();
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].addEventListener('message', event => {
    const command = RequestFrame.parse(JSON.parse(String(event.data)));
    let result: unknown = {};
    if (command.method === 'Target.createTarget') result = { targetId: 'cloud-target' };
    if (command.method === 'Target.attachToTarget') result = { sessionId: 'cloud-session' };
    if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'frame', url: 'about:blank' } } };
    if (command.method === 'Page.navigate') {
      result = { frameId: 'frame' };
      pair[1].send(JSON.stringify({ method: 'Network.requestWillBeSent', sessionId: 'cloud-session', params: { requestId: 'hosted-network', frameId: 'frame', type: 'Document', documentURL: command.params.url, initiator: { type: 'other' }, request: { url: command.params.url } } }));
      pair[1].send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'cloud-session', params: { requestId: 'hosted-request', networkId: 'hosted-network', frameId: 'frame', resourceType: 'Document', request: { url: command.params.url, method: 'GET', headers: {} } } }));
    }
    if (command.method === 'Fetch.fulfillRequest') fulfilled.resolve(command);
    if ((command.method === 'Fetch.fulfillRequest' || command.method === 'Fetch.failRequest') && command.params.requestId === 'attacker-request') denied.resolve(command);
    pair[1].send(JSON.stringify({ id: command.id, result }));
  });
  const binding = { async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init); calls.push({ url: request.url, method: request.method });
    if (request.method === 'POST') return Response.json({ sessionId: 'binding-session' });
    expect(request.headers.get('upgrade')).toBe('websocket');
    return new Response(null, { status: 101, webSocket: pair[0] });
  } };
  const serviceRequests: Request[] = [];
  const runtime = new AccountBrowserRuntime({ storage, binding, serviceHostname: hostname => hostname === 'app--tenant-srv.gssh.dev', workspaceServiceHostname: hostname => hostname === 'app--tenant-srv.gssh.dev', serviceFetch: async request => { serviceRequests.push(request); return new Response('private account service', { status: 201 }); } });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const placement = { kind: 'cloud', accountId: 'account' };
  const authority = { body: { accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: 'AA==', issuedAt: new Date().toISOString(), expiresAt }, signature: 'AA==' };
  const authorization = RuntimeAccountBrowserAuthorizationSchema.parse({ body: { scope: { projectId: 'project', workspaceId: 'workspace', placement, conversationId: 'conversation', conversationKind: 'subagent', taskId: 'task', requestId: 'request', attemptId: 'attempt' }, issuedAt: new Date().toISOString(), expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'open', source: 'headless', url: 'https://app--tenant-srv.gssh.dev/private' }, grant: { body: { projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'headless', origins: [], expiresAt }, signature: 'AA==', authority } } }, signature: 'AA==', authority });
  try {
    expect((await runtime.execute(authorization, AbortSignal.timeout(5000))).status).toBe('completed');
    const reply = await fulfilled.promise;
    expect(reply.params.responseCode).toBe(201); expect(atob(String(reply.params.body))).toBe('private account service');
    expect(serviceRequests.map(request => request.url)).toEqual(['https://app--tenant-srv.gssh.dev/private']);
    pair[1].send(JSON.stringify({ method: 'Page.frameNavigated', sessionId: 'cloud-session', params: { frame: { id: 'frame', url: 'https://attacker.example/' } } }));
    const resourceType = resource === 'Redirect' ? 'Document' : resource;
    if (resource !== 'Unknown') pair[1].send(JSON.stringify({ method: 'Network.requestWillBeSent', sessionId: 'cloud-session', params: { requestId: 'attacker-network', frameId: 'frame', type: resourceType, documentURL: 'https://attacker.example/', initiator: { type: 'script' }, request: { url: 'https://app--tenant-srv.gssh.dev/private' }, ...(resource === 'Redirect' ? { redirectResponse: { status: 302 } } : {}) } }));
    pair[1].send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'cloud-session', params: { requestId: 'attacker-request', networkId: 'attacker-network', frameId: 'frame', resourceType, request: { url: 'https://app--tenant-srv.gssh.dev/private', method: 'GET', headers: {} } } }));
    expect((await denied.promise).method).toBe('Fetch.failRequest');
    expect(serviceRequests).toHaveLength(1);
    expect(calls).toEqual([{ url: 'https://browser.internal/v1/devtools/browser?keep_alive=600000', method: 'POST' }, { url: 'https://browser.internal/v1/devtools/browser/binding-session', method: 'GET' }]);
    await expect(runtime.execute(authorization, AbortSignal.timeout(5000))).rejects.toThrow('already consumed');
  } finally { pair[1].close(); }
});
