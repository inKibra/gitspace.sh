import { expect, test } from 'bun:test';
import { attachBrowserServiceForward } from './browser-service-forward.js';
import { BrowserServicePolicy } from './browser-service-policy.js';
import type { RuntimeBrowserRelayChannel } from './browser-relay-transport.js';
import { openServiceForward } from '../../account-machine/src/service-forward.js';

const service = 'https://app--tenant-srv.gssh.dev';
const scenarios = [
  { name: 'explicit tool navigation', document: 'about:blank', type: 'Document', explicit: true, allowed: true },
  { name: 'same-workspace service subresource', document: `${service}/page`, type: 'Fetch', allowed: true },
  { name: 'verified cross-service CORS request preserves origin', document: `${service}/page`, destination: 'https://api--tenant-srv.gssh.dev', type: 'Fetch', allowed: true },
  { name: 'attacker fetch', document: 'https://attacker.example/', type: 'Fetch', allowed: false },
  { name: 'attacker image', document: 'https://attacker.example/', type: 'Image', allowed: false },
  { name: 'attacker iframe', document: 'https://attacker.example/', type: 'Document', allowed: false },
  { name: 'redirect laundering', document: 'https://attacker.example/', type: 'Document', redirect: true, allowed: false },
  { name: 'unknown initiator frame', document: 'about:blank', type: 'Fetch', unknown: true, allowed: false },
  { name: 'other-workspace service document', document: 'https://other--tenant-srv.gssh.dev/', type: 'Fetch', allowed: false },
];
for (const scenario of scenarios) test(`private service policy: ${scenario.name}`, async () => {
  let listener: ((event: unknown) => void) | undefined;
  const completed = Promise.withResolvers<{ method: string; params: Record<string, unknown> }>();
  const received: string[] = [];
  const origins: Array<string | null> = [];
  const destination = scenario.destination ?? service;
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { received.push(request.headers.get('x-gitspace-forward-token') ?? ''); origins.push(request.headers.get('origin')); expect(request.headers.has('x-gitspace-forward-origin')).toBe(false); return new Response('secret', { status: 202 }); } });
  let opened = 0, closed = 0;
  const channel: RuntimeBrowserRelayChannel = {
    async send(method, params = {}) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: scenario.document } } };
      if (method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest') completed.resolve({ method, params });
      return {};
    },
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
    async close() {},
  };
  const policy = new BrowserServicePolicy(hostname => [new URL(service).hostname, new URL(destination).hostname].includes(hostname));
  const cleanup = await attachBrowserServiceForward(channel, 'session', {
    async serviceForward(hostname) {
      opened++;
      const forward = await openServiceForward({ hostname, fetch: request => fetch(new URL(new URL(request.url).pathname, `http://127.0.0.1:${local.port}`), { headers: request.headers }) });
      return { ...forward, async close() { closed++; await forward.close(); } };
    },
    serviceHostname: hostname => hostname.endsWith('--tenant-srv.gssh.dev'),
  }, error => completed.reject(error), policy);
  try {
    if ('explicit' in scenario && scenario.explicit) policy.beginNavigation(`${service}/private`);
    if (!('unknown' in scenario)) listener?.({ method: 'Network.requestWillBeSent', sessionId: 'session', params: { requestId: 'network', frameId: 'frame', type: scenario.type, documentURL: scenario.document, initiator: { type: 'explicit' in scenario ? 'other' : 'script' }, request: { url: `${destination}/private` }, ...('redirect' in scenario ? { redirectResponse: { status: 302 } } : {}) } });
    listener?.({ method: 'Fetch.requestPaused', sessionId: 'session', params: { requestId: 'request', networkId: 'network', frameId: 'frame', resourceType: scenario.type === 'Fetch' ? 'XHR' : scenario.type, request: { url: `${destination}/private`, method: 'GET', headers: { 'x-gitspace-forward-token': 'attacker', 'x-gitspace-forward-origin': 'https://attacker.example', ...('destination' in scenario ? { origin: service } : {}) } } } });
    const response = await completed.promise;
    expect(response.method).toBe(scenario.allowed ? 'Fetch.fulfillRequest' : 'Fetch.failRequest');
    expect(opened).toBe(scenario.allowed ? 1 : 0);
    expect(received).toEqual(scenario.allowed ? [''] : []);
    if ('destination' in scenario) expect(origins).toEqual([service]);
    else if (scenario.allowed) expect(origins).toEqual([null]);
    if (scenario.allowed) { expect(response.params.responseCode).toBe(202); expect(atob(String(response.params.body))).toBe('secret'); }
  } finally { await cleanup(); await local.stop(true); }
  expect(closed).toBe(opened);
});

test('non-local service opener fails closed even for authorized navigation', async () => {
  let listener: ((event: unknown) => void) | undefined;
  const rejected = Promise.withResolvers<unknown>(), failed = Promise.withResolvers<string>();
  const channel: RuntimeBrowserRelayChannel = {
    async send(method) { if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'about:blank' } } }; if (method === 'Fetch.failRequest') failed.resolve(method); return {}; },
    subscribe(value) { listener = value; return () => {}; }, async close() {},
  };
  const policy = new BrowserServicePolicy(() => true);
  const cleanup = await attachBrowserServiceForward(channel, 'session', { serviceHostname: () => true, async serviceForward() { return { url: 'https://public.example/', headers: {}, async close() {} }; } }, error => rejected.resolve(error), policy);
  policy.beginNavigation(`${service}/`);
  listener?.({ method: 'Network.requestWillBeSent', sessionId: 'session', params: { requestId: 'network', frameId: 'frame', type: 'Document', documentURL: `${service}/`, initiator: { type: 'other' }, request: { url: `${service}/` } } });
  listener?.({ method: 'Fetch.requestPaused', sessionId: 'session', params: { requestId: 'request', networkId: 'network', frameId: 'frame', resourceType: 'Document', request: { url: `${service}/`, method: 'GET', headers: {} } } });
  expect(String(await rejected.promise)).toContain('localhost'); expect(await failed.promise).toBe('Fetch.failRequest'); await cleanup();
});
