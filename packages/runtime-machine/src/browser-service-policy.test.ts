import { expect, test } from 'bun:test';
import { BrowserServicePolicy } from './browser-service-policy.js';

const app = 'https://app--tenant-srv.gssh.dev';
const api = 'https://api--tenant-srv.gssh.dev';
function fixture(document = `${app}/page`) {
  const policy = new BrowserServicePolicy(host => [new URL(app).hostname, new URL(api).hostname].includes(host));
  policy.initialize({ frameTree: { frame: { id: 'root', url: document } } });
  const request = (id: string, url: string, options: { type?: string; frameId?: string; documentURL?: string; initiator?: object; redirect?: boolean } = {}) => policy.observe({ method: 'Network.requestWillBeSent', sessionId: 'session', params: { requestId: id, frameId: options.frameId ?? 'root', type: options.type ?? 'Document', documentURL: options.documentURL ?? url, initiator: options.initiator ?? { type: 'other' }, request: { url }, ...(options.redirect ? { redirectResponse: { status: 302 } } : {}) } }, 'session');
  const allows = (id: string, url: string, options: { type?: string; frameId?: string; method?: string; redirectedRequestId?: string; site?: string; headers?: Record<string, string> } = {}) => policy.allows({ requestId: `fetch-${id}-${url}`, networkId: id, frameId: options.frameId ?? 'root', resourceType: options.type ?? 'Document', redirectedRequestId: options.redirectedRequestId, request: { url, method: options.method ?? 'GET', headers: options.headers ?? { Origin: app, Referer: `${app}/page`, ...(options.site ? { 'Sec-Fetch-Site': options.site } : {}) } } });
  return { policy, request, allows };
}

for (const method of ['GET', 'POST']) test(`service document root navigation accepts ${method}`, async () => {
  const f = fixture(); f.request('next', `${app}/next`);
  expect(await f.allows('next', `${app}/next`, { method })).toBe(true);
});
test('explicit navigation ignores fragment removed from network URL', async () => {
  const f = fixture('about:blank'); f.policy.beginNavigation(`${app}/page#route`); f.request('open', `${app}/page`);
  expect(await f.allows('open', `${app}/page`)).toBe(true);
});
test('allowed navigation follows only uninterrupted same-workspace redirects', async () => {
  const f = fixture('about:blank'); f.policy.beginNavigation(`${app}/`); f.request('open', `${app}/`);
  expect(await f.allows('open', `${app}/`)).toBe(true);
  f.request('open', `${app}/login`, { redirect: true });
  expect(await f.allows('open', `${app}/login`, { redirectedRequestId: `fetch-open-${app}/` })).toBe(true);
  f.request('open', 'https://attacker.example/bounce', { redirect: true });
  f.request('open', `${app}/secret`, { redirect: true });
  expect(await f.allows('open', `${app}/secret`, { redirectedRequestId: 'external' })).toBe(false);
});
test('cross-service preflight derives authority from independently tracked initiating request', async () => {
  const f = fixture();
  f.request('fetch', `${api}/data`, { type: 'Fetch', documentURL: `${app}/page`, initiator: { type: 'script' } });
  f.policy.observe({ method: 'Network.requestWillBeSent', sessionId: 'session', params: { requestId: 'preflight', type: 'Other', documentURL: `${api}/data`, initiator: { type: 'preflight', requestId: 'fetch' }, request: { url: `${api}/data` } } }, 'session');
  expect(await f.allows('preflight', `${api}/data`, { type: 'XHR', method: 'OPTIONS' })).toBe(true);
  expect(await f.allows('preflight', `${api}/data`, { type: 'XHR', frameId: 'unrelated-frame', method: 'OPTIONS' })).toBe(false);
  expect(await f.allows('fetch', `${api}/data`, { type: 'XHR' })).toBe(true);
});
for (const document of ['https://attacker.example/', 'https://other--tenant-srv.gssh.dev/', 'about:blank']) test(`untrusted document cannot navigate or preflight: ${document}`, async () => {
  const f = fixture(document); f.request('next', `${app}/next`);
  expect(await f.allows('next', `${app}/next`)).toBe(false);
  f.request('fetch', `${api}/data`, { type: 'Fetch', documentURL: document, initiator: { type: 'script' } });
  f.request('preflight', `${api}/data`, { type: 'Other', frameId: '', initiator: { type: 'preflight', requestId: 'fetch' } });
  expect(await f.allows('preflight', `${api}/data`, { type: 'Other', frameId: '', method: 'OPTIONS' })).toBe(false);
});
test('unknown preflight identity and redirect without an allowed start fail closed', async () => {
  const f = fixture();
  f.request('preflight', `${api}/data`, { type: 'Other', frameId: '', initiator: { type: 'preflight', requestId: 'missing' } });
  expect(await f.allows('preflight', `${api}/data`, { type: 'Other', frameId: '', method: 'OPTIONS' })).toBe(false);
  f.request('redirect', `${app}/secret`, { redirect: true });
  expect(await f.allows('redirect', `${app}/secret`)).toBe(false);
});
test('script full-page navigation needs independently matching committed initiator', async () => {
  const f = fixture();
  f.request('route', `${app}/route`, { initiator: { type: 'script', stack: { callFrames: [{ url: `${app}/page` }] } } });
  expect(await f.allows('route', `${app}/route`)).toBe(true);
  f.request('bundle-route', `${app}/route`, { initiator: { type: 'script', stack: { callFrames: [{ url: `${app}/assets/router.js` }] } } });
  expect(await f.allows('bundle-route', `${app}/route`)).toBe(true);
  f.request('attacker-route', `${app}/route`, { initiator: { type: 'script', stack: { callFrames: [{ url: 'https://attacker.example/' }] } } });
  expect(await f.allows('attacker-route', `${app}/route`)).toBe(false);
});
test('preflight without linked initiator fails even with a trusted target frame', async () => {
  const f = fixture();
  f.request('preflight', `${api}/data`, { type: 'Other', documentURL: `${app}/page`, initiator: { type: 'preflight' } });
  expect(await f.allows('preflight', `${api}/data`, { type: 'Other', method: 'OPTIONS' })).toBe(false);
});
test('cross-site iframe top form cannot borrow the destination root authority', async () => {
  const f = fixture();
  f.policy.observe({ method: 'Page.frameNavigated', sessionId: 'session', params: { frame: { id: 'child', parentId: 'root', url: 'https://attacker.example/form' } } }, 'session');
  f.request('top-form', `${api}/submitted`);
  expect(await f.allows('top-form', `${api}/submitted`, { method: 'POST', site: 'cross-site' })).toBe(false);
  f.request('parent-form', `${api}/submitted`);
  expect(await f.allows('parent-form', `${api}/submitted`, { method: 'POST', site: 'same-site' })).toBe(true);
  f.policy.beginNavigation(`${api}/page`);
  f.request('tool', `${api}/page`);
  expect(await f.allows('tool', `${api}/page`, { site: 'cross-site' })).toBe(true);
});
test('browser navigation source headers bind top forms when Fetch omits Sec-Fetch-Site', async () => {
  const f = fixture();
  f.request('post', `${api}/submitted`);
  expect(await f.allows('post', `${api}/submitted`, { method: 'POST', headers: { Origin: 'https://attacker.example', Referer: 'https://attacker.example/' } })).toBe(false);
  f.request('get', `${api}/submitted`);
  expect(await f.allows('get', `${api}/submitted`, { headers: { Referer: 'https://attacker.example/' } })).toBe(false);
  f.request('hidden', `${api}/submitted`);
  expect(await f.allows('hidden', `${api}/submitted`, { headers: {} })).toBe(false);
  f.request('parent', `${api}/submitted`);
  expect(await f.allows('parent', `${api}/submitted`, { method: 'POST', headers: { origin: app, referer: `${app}/page` } })).toBe(true);
});
test('same-document navigation updates trusted fetch identity without creating unknown frames', async () => {
  const f = fixture();
  f.policy.observe({ method: 'Page.navigatedWithinDocument', sessionId: 'session', params: { frameId: 'root', url: `${app}/route` } }, 'session');
  f.request('fetch', `${api}/data`, { type: 'Fetch', documentURL: `${app}/route`, initiator: { type: 'script' } });
  expect(await f.allows('fetch', `${api}/data`, { type: 'XHR' })).toBe(true);
  f.policy.observe({ method: 'Page.navigatedWithinDocument', sessionId: 'session', params: { frameId: 'unknown', url: `${app}/route` } }, 'session');
  f.request('unknown', `${api}/data`, { type: 'Fetch', frameId: 'unknown', documentURL: `${app}/route` });
  expect(await f.allows('unknown', `${api}/data`, { type: 'XHR', frameId: 'unknown' })).toBe(false);
});
test('same-document child navigation preserves its parent and cannot acquire root authority', async () => {
  const f = fixture();
  f.policy.observe({ method: 'Page.frameNavigated', sessionId: 'session', params: { frame: { id: 'child', parentId: 'root', url: `${app}/child` } } }, 'session');
  f.policy.observe({ method: 'Page.navigatedWithinDocument', sessionId: 'session', params: { frameId: 'child', url: `${app}/child-route` } }, 'session');
  f.request('child-fetch', `${api}/data`, { type: 'Fetch', frameId: 'child', documentURL: `${app}/child-route` });
  expect(await f.allows('child-fetch', `${api}/data`, { type: 'XHR', frameId: 'child' })).toBe(true);
  f.request('child-nav', `${api}/page`, { frameId: 'child' });
  expect(await f.allows('child-nav', `${api}/page`, { frameId: 'child' })).toBe(false);
});
