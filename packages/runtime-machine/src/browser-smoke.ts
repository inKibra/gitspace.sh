import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MachineBrowser } from './browser.js';
import { browserTestAuthority, browserInvoker, browserText } from './browser-test-support.js';
import type { LocalAttachment } from './journal.js';
import { z } from 'zod';
import { openServiceForward } from '../../account-machine/src/service-forward.js';

/** Opt-in actual Chromium and supervisor proof; no user Chrome connection is used. */
export async function runBrowserSmoke(options: { executablePath: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-browser-proof-'));
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/cookie' ? `<!doctype html><title>Persistent profile</title><p>${request.headers.get('cookie') ?? 'missing'}</p>` : `<!doctype html><html lang="en"><title>Browser proof</title><label>Name<input id="name" value="SECRET-PRIVATE"></label><input type="password" value="SECRET-PASSWORD"><input autocomplete="cc-number" value="SECRET-PAYMENT"><div contenteditable="true"><span>SECRET-EDITABLE</span></div><button onclick="this.textContent='Hello '+document.querySelector('#name').value">Greet</button><span id="clock"></span><script>document.cookie='proof=persistent;Max-Age=3600;SameSite=Lax';setInterval(()=>document.querySelector('#clock').textContent=Date.now(),10)</script></html>`, { headers: { 'content-type': 'text/html' } }) });
  const serviceOrigin = 'https://app--tenant-srv.gssh.dev';
  const apiOrigin = 'https://api--tenant-srv.gssh.dev';
  const serviceMethods: string[] = [];
  const privateRequests: string[] = [];
  const attackerURL = 'https://attacker.example/form';
  const attackerHTML = `<!doctype html><body style="margin:0"><form method="POST" target="_top" action="${apiOrigin}/iframe-submitted"><input type="hidden" name="proof" value="posted"><button onclick="parent.postMessage(event.isTrusted?'attacker-clicked':'attacker-untrusted','*')" style="position:absolute;left:0;top:0;width:160px;height:60px">Attack top form</button></form><script>parent.postMessage("attacker-ready","*")</script></body>`;
  const serviceFixture = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    privateRequests.push(path);
    serviceMethods.push(`${request.method} ${path}`);
    if (path === '/') return new Response(null, { status: 302, headers: { location: `${serviceOrigin}/login` } });
    if (path === '/cors') return new Response(request.method === 'OPTIONS' ? null : 'cross-service', { headers: { 'access-control-allow-origin': serviceOrigin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'x-proof', 'content-type': 'text/plain' } });
    if (path === '/assets/router.js') return new Response('document.querySelector("#route").addEventListener("click",()=>{location.href="/routed";})', { headers: { 'content-type': 'text/javascript' } });
    if (path === '/submitted') assert.equal(await request.text(), 'proof=posted');
    const pages: Record<string, string> = {
      '/page': '<script>fetch("/subresource").then(r=>r.text()).then(text=>document.body.dataset.result=text)</script><a id="next" href="/linked">Next page</a>',
      '/linked': '<form method="POST" action="/submitted"><input name="proof" value="posted"><button type="submit">Send form</button></form>',
      '/submitted': '<a id="login" href="/">Login redirect</a>',
      '/login': '<p>Login destination</p><button id="route">Full page route</button><script src="/assets/router.js" defer></script>',
      '/routed': '<p>Routed destination</p>',
      '/iframe-parent': `<script>addEventListener("message",event=>{if(event.origin!=="https://attacker.example")return;if(event.data==="attacker-ready")document.body.dataset.iframeReady="yes";if(event.data==="attacker-clicked")document.body.dataset.iframeClicked="yes"})</script><iframe style="position:absolute;left:0;top:0;width:200px;height:100px;border:0" src="${attackerURL}"></iframe>`,
      '/parent-form': `<form method="POST" target="_top" action="${apiOrigin}/parent-submitted"><input name="proof" value="posted"><button type="submit">Send parent form</button></form>`,
      '/parent-submitted': '<p>Parent form accepted</p>',
    };
    return new Response(pages[path] === undefined ? 'private-subresource' : `<!doctype html><title>Private service</title><body>${pages[path]}</body>`, { headers: { 'content-type': pages[path] === undefined ? 'text/plain' : 'text/html' } });
  } });
  const authority = await browserTestAuthority(), local = { rootPath: directory } as LocalAttachment;
  const browser = new MachineBrowser({ directory, executablePath: options.executablePath, enabled: true, verifyAuthorization: authority.verifyAuthorization, services: {
    serviceHostname: hostname => [serviceOrigin, apiOrigin].some(origin => hostname === new URL(origin).hostname),
    workspaceServiceHostname: hostname => [serviceOrigin, apiOrigin].some(origin => hostname === new URL(origin).hostname),
    async serviceForward(hostname) {
      return openServiceForward({ hostname, fetch: async request => {
        assert(!request.headers.has('x-gitspace-forward-token'));
        assert(!request.headers.has('x-gitspace-forward-origin'));
        const destination = new URL(request.url);
        const upstream = new URL(`http://127.0.0.1:${serviceFixture.port}`);
        upstream.pathname = destination.pathname; upstream.search = destination.search;
        return fetch(new Request(upstream, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' }));
      } });
    },
  } });
  const invoke = browserInvoker(browser, authority, local);
  const url = `http://127.0.0.1:${fixture.port}`;
  try {
    const opened = browserText(await invoke({ action: 'open', url }));
    assert.equal(opened.source, 'headless');
    const targetId = opened.targetId;
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId, expression: `fetch(${JSON.stringify(`${serviceOrigin}/attacker-fetch`)}).then(()=>"unexpected").catch(()=>"denied")` })), 'denied');
    assert.equal(privateRequests.length, 0);
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId, expression: `fetch(${JSON.stringify(`${apiOrigin}/attacker-preflight`)},{method:"POST",headers:{"x-proof":"attacker"}}).then(()=>"unexpected").catch(()=>"denied")` })), 'denied');
    assert.equal(privateRequests.length, 0);
    const privateTab = browserText(await invoke({ action: 'open', url: `${serviceOrigin}/page` }));
    for (let retry = 0; retry < 50; retry++) {
      if (browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'document.body?.dataset.result' }))) break;
      await delay(40);
    }
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'document.body.dataset.result' })), 'private-subresource');
    assert(privateRequests.includes('/page')); assert(privateRequests.includes('/subresource'));
    assert(!privateRequests.includes('/attacker-fetch'));
    const waitPrivatePath = async (path: string) => {
      for (let retry = 0; retry < 50; retry++) {
        if (browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'location.pathname' })) === path) return;
        await delay(40);
      }
      assert.fail(`Service navigation did not reach ${path}`);
    };
    const clickPrivate = async (name: string) => {
      for (let retry = 0; retry < 50; retry++) {
        const observation = browserText(await invoke({ action: 'observe', targetId: privateTab.targetId }));
        const node = observation.nodes.find((node: { role: string; name: string }) => ['link', 'button'].includes(node.role) && node.name === name);
        if (node) {
          await invoke({ action: 'act', targetId: privateTab.targetId, ref: node.ref, operation: 'click' });
          return;
        }
        await delay(40);
      }
      assert.fail(`Service control did not become available: ${name}`);
    };
    await clickPrivate('Next page');
    await waitPrivatePath('/linked');
    await clickPrivate('Send form');
    await waitPrivatePath('/submitted');
    assert(serviceMethods.includes('POST /submitted'));
    await clickPrivate('Login redirect');
    await waitPrivatePath('/login');
    assert(privateRequests.includes('/'));
    await clickPrivate('Full page route');
    await waitPrivatePath('/routed');
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: `fetch(${JSON.stringify(`${apiOrigin}/cors`)},{method:"POST",headers:{"x-proof":"browser"}}).then(r=>r.text())` })), 'cross-service');
    assert(serviceMethods.includes('OPTIONS /cors')); assert(serviceMethods.includes('POST /cors'));
    browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'history.pushState({},"","/spa-route?state=1#ready");location.href' }));
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'fetch("/spa-fetch").then(r=>r.text())' })), 'private-subresource');
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: '(()=>{const {promise,resolve,reject}=Promise.withResolvers();const xhr=new XMLHttpRequest();xhr.open("GET","/spa-xhr");xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=()=>reject(new Error("XHR denied after pushState"));xhr.send();return promise})()' })), 'private-subresource');
    assert(serviceMethods.includes('GET /spa-fetch')); assert(serviceMethods.includes('GET /spa-xhr'));
    await invoke({ action: 'navigate', targetId: privateTab.targetId, url: `${serviceOrigin}/parent-form` });
    await clickPrivate('Send parent form');
    await waitPrivatePath('/parent-submitted');
    assert(serviceMethods.includes('POST /parent-submitted'));
    const privateTarget = browser['tabs'].get(privateTab.targetId);
    assert(privateTarget);
    let attackerFixtureError: unknown;
    // Supply only the untrusted HTTPS fixture's response. Chromium still creates
    // its real cross-origin frame, fetch metadata and user-activated navigation.
    const stopAttackerFixture = privateTarget.channel.subscribe(raw => {
      const intercepted = z.object({ method: z.literal('Network.requestIntercepted'), sessionId: z.string(), params: z.object({ interceptionId: z.string(), request: z.object({ url: z.string() }) }) }).safeParse(raw);
      if (!intercepted.success || intercepted.data.sessionId !== privateTarget.sessionId || intercepted.data.params.request.url !== attackerURL) return;
      void privateTarget.channel.send('Network.continueInterceptedRequest', {
        interceptionId: intercepted.data.params.interceptionId,
        rawResponse: Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(attackerHTML)}\r\n\r\n${attackerHTML}`).toString('base64'),
      }, privateTarget.sessionId).catch(error => { attackerFixtureError = error; });
    });
    await privateTarget.channel.send('Network.setRequestInterception', { patterns: [{ urlPattern: attackerURL, interceptionStage: 'Request' }] }, privateTarget.sessionId);
    await invoke({ action: 'navigate', targetId: privateTab.targetId, url: `${serviceOrigin}/iframe-parent` });
    for (let retry = 0; retry < 50; retry++) {
      if (browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'document.body.dataset.iframeReady' })) === 'yes') break;
      await delay(40);
    }
    if (attackerFixtureError) throw attackerFixtureError;
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'document.body.dataset.iframeReady' })), 'yes', 'The real cross-site iframe must load before clicking its form');
    await privateTarget.channel.send('Page.bringToFront', {}, privateTarget.sessionId);
    const iframePoint = z.object({ x: z.number(), y: z.number() }).parse(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: '(async()=>{for(let i=0;i<2;i++){const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(resolve);await promise}const frame=document.querySelector("iframe");frame.scrollIntoView();const rect=frame.getBoundingClientRect();return {x:rect.left+30,y:rect.top+30}})()' })));
    let attackRequestId: string | undefined, attackFailed = false;
    const stopAttackObservation = privateTarget.channel.subscribe(raw => {
      const event = z.object({ method: z.string(), sessionId: z.string().optional(), params: z.object({ requestId: z.string(), request: z.object({ url: z.string() }).optional() }).optional() }).safeParse(raw);
      if (!event.success || event.data.sessionId !== privateTarget.sessionId) return;
      if (event.data.method === 'Network.requestWillBeSent' && event.data.params?.request?.url === `${apiOrigin}/iframe-submitted`) attackRequestId = event.data.params.requestId;
      if (event.data.method === 'Network.loadingFailed' && attackRequestId && event.data.params?.requestId === attackRequestId) attackFailed = true;
    });
    try {
      // A real trusted pointer gesture inside the third-party frame, not synthetic CDP request metadata.
      await privateTarget.channel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...iframePoint }, privateTarget.sessionId);
      await privateTarget.channel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...iframePoint, button: 'left', clickCount: 1 }, privateTarget.sessionId);
      await privateTarget.channel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...iframePoint, button: 'left', clickCount: 1 }, privateTarget.sessionId);
      for (let retry = 0; retry < 50 && !attackFailed && !serviceMethods.includes('POST /iframe-submitted'); retry++) await delay(40);
      if (!attackRequestId) assert.equal(browserText(await invoke({ action: 'evaluate', targetId: privateTab.targetId, expression: 'document.body.dataset.iframeClicked' })), 'yes', 'The cross-site button must receive the trusted pointer click');
      assert(attackRequestId, 'The actual iframe click must attempt the top-level POST');
      assert(!serviceMethods.includes('POST /iframe-submitted'), 'The third-party iframe must not post through its trusted parent authority');
      assert(attackFailed, 'Chromium must observe the denied top-level form request');
    } finally {
      stopAttackObservation();
      stopAttackerFixture();
      await privateTarget.channel.send('Network.setRequestInterception', { patterns: [] }, privateTarget.sessionId);
    }
    const hashTab = browserText(await invoke({ action: 'open', url: `${serviceOrigin}/login#route` }));
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId: hashTab.targetId, expression: 'location.hash' })), '#route');
    await invoke({ action: 'close', targetId: hashTab.targetId });
    await invoke({ action: 'close', targetId: privateTab.targetId });
    const otherWorkspace = browserInvoker(browser, authority, local, 'other-workspace');
    await assert.rejects(() => otherWorkspace({ action: 'observe', targetId }), /outside group/);
    const observe = async () => {
      for (let retry = 0; retry < 50; retry++) {
        const value = browserText(await invoke({ action: 'observe', targetId }));
        if (value.nodes.some((node: {role:string;name:string}) => node.role === 'textbox' && node.name === 'Name')) return value;
        await delay(100);
      }
      throw new Error('Actual Chromium fixture did not become ready');
    };
    let observed = await observe();
    assert(!JSON.stringify(observed).includes('SECRET-'));
    const input = observed.nodes.find((node: {role:string;name:string}) => node.role === 'textbox' && node.name === 'Name');
    await delay(80);
    await invoke({ action: 'act', targetId, ref: input.ref, operation: 'fill', value: 'Browser' });
    observed = await observe();
    const button = observed.nodes.find((node: {role:string}) => node.role === 'button');
    await delay(80); await invoke({ action: 'act', targetId, ref: button.ref, operation: 'click' });
    for (let retry = 0; retry < 50; retry++) {
      observed = await observe();
      if (observed.nodes.some((node: {name:string}) => node.name === 'Hello Browser')) break;
      await delay(100);
    }
    assert(observed.nodes.some((node: {name:string}) => node.name === 'Hello Browser'));
    const screenshot = (await invoke({ action: 'observe', targetId, screenshot: true }))[1];
    assert(screenshot?.type === 'image'); assert.equal(screenshot.mimeType, 'image/jpeg'); assert(Buffer.from(screenshot.data, 'base64').length <= 512000); assert.equal(Buffer.from(screenshot.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    const profileName = (await readdir(join(directory, 'profiles')))[0]!;
    assert(!(await readdir(join(directory, 'profiles', profileName))).includes('DevToolsActivePort'));
    const inspector = [...browser['profiles'].values()][0]!.connection;
    try {
      const session = z.object({ sessionId: z.string() }).parse(await inspector.send('Target.attachToTarget', { targetId: opened.targetId, flatten: true }));
      const box = z.object({ model: z.object({ content: z.array(z.number()).length(8) }) }).parse(await inspector.send('DOM.getBoxModel', { backendNodeId: Number(button.ref.split(':')[1]) }, session.sessionId));
      // Inspect the captured pixels, not merely calls to the masking helper.
      // This connection is to the proof's private Chrome, never a user relay.
      const pixels = z.object({ result: z.object({ value: z.array(z.array(z.number())) }) }).parse(await inspector.send('Runtime.evaluate', {
        expression: `(async()=>{const image=new Image();image.src=${JSON.stringify(`data:image/jpeg;base64,${screenshot.data}`)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const scale=image.width/innerWidth;const fields=[...document.querySelectorAll('input,[contenteditable]')].map(el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]});return [...fields,${JSON.stringify([box.model.content[0]! + 2, box.model.content[1]! + 14])}].map(([x,y])=>[...ctx.getImageData(Math.floor(x*scale),Math.floor(y*scale),1,1).data])})()`,
        returnByValue: true, awaitPromise: true,
      }, session.sessionId));
      assert.equal(pixels.result.value.length, 5);
      assert(pixels.result.value.every(pixel => pixel.slice(0, 3).every(channel => channel < 64)), `Form fields must be opaque and the actionable ref overlay visible in captured JPEG pixels: ${JSON.stringify(pixels.result.value)}`);
    } finally { /* The supervising browser owns this private pipe connection. */ }
    assert.equal(browserText(await invoke({ action: 'evaluate', targetId, expression: '1 + 1' })), 2);
    await invoke({ action: 'close', targetId }); await assert.rejects(() => invoke({ action: 'observe', targetId }), /stale/);
    const second = browserText(await invoke({ action: 'open', source: 'headless', url: `${url}/cookie` }));
    assert.equal(second.groupId, opened.groupId);
    const sibling = browserText(await invoke({ action: 'open' }));
    assert.equal(sibling.groupId, second.groupId);
    const groupTabs = browserText(await invoke({ action: 'tabs' }));
    assert(groupTabs.some((tab: { targetId: string }) => tab.targetId === second.targetId));
    assert(groupTabs.some((tab: { targetId: string }) => tab.targetId === sibling.targetId));
    await invoke({ action: 'close', targetId: sibling.targetId });
    await delay(200);
    assert(JSON.stringify(browserText(await invoke({ action: 'observe', targetId: second.targetId }))).includes('proof=persistent'));
    const profilesBefore = await readdir(join(directory, 'profiles'));
    const launchName = (await readdir(join(directory, 'launches')))[0]!;
    const unknown = JSON.parse(await readFile(join(directory, 'launches', launchName), 'utf8'));
    unknown.spec.name = `browser-${crypto.randomUUID()}`;
    unknown.identity = { pid: process.pid, boot: 'different-boot', started: 'different-start' };
    const unknownName = `${unknown.spec.name}.json`;
    await writeFile(join(directory, 'launches', unknownName), JSON.stringify(unknown));
    const recovered = new MachineBrowser({ directory, executablePath: options.executablePath, enabled: true, verifyAuthorization: authority.verifyAuthorization });
    try {
      await recovered.recover();
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = browserText(await recovered.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }), local, AbortSignal.timeout(30000)));
        if (status.records.length === 0) break;
        await delay(100);
      }
      await assert.rejects(() => invoke({ action: 'observe', targetId: second.targetId }));
      const processes = await (await browser['supervisor']()).request({ op: 'list' });
      assert.equal(processes.op, 'list'); if (processes.op !== 'list') throw new Error('Unexpected supervisor response');
      assert(processes.daemons.every(process => process.state === 'exited'));
      assert(!(await readdir(join(directory, 'launches'))).includes(unknownName), 'Unknown supervisor record with positively mismatched process identity must reconcile without killing that PID');
      process.kill(process.pid, 0);
      assert.deepEqual(await readdir(join(directory, 'profiles')), profilesBefore);
      const invokeRecovered = browserInvoker(recovered, authority, local);
      const third = browserText(await invokeRecovered({ action: 'open', source: 'headless', url: `${url}/cookie` }));
      await delay(200); assert(JSON.stringify(browserText(await invokeRecovered({ action: 'observe', targetId: third.targetId }))).includes('proof=persistent'));
      await invokeRecovered({ action: 'close', targetId: third.targetId });
    } finally { await recovered.close(); }
    console.log('PASS actual headless Chromium: signed dispatch, mutating document refs, fill/click, bounded masked JPEG, group scopes, persistent profile and recovery');
  } finally {
    await serviceFixture.stop(true);
    try {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      console.error(`Browser proof cleanup requires recovery at ${directory}`);
      throw error;
    } finally { await fixture.stop(true); }
  }
}
if (import.meta.main) {
  const executablePath = process.env.GITSPACE_BROWSER_PROOF_EXECUTABLE;
  if (!executablePath || process.env.GITSPACE_BROWSER_PROOF_ISOLATED !== '1') throw new Error('Set GITSPACE_BROWSER_PROOF_EXECUTABLE and GITSPACE_BROWSER_PROOF_ISOLATED=1 for a dedicated local Chromium proof');
  await runBrowserSmoke({ executablePath });
}
