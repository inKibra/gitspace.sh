import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MachineBrowser } from './browser.js';
import { browserTestAuthority, browserInvoker, browserText } from './browser-test-support.js';
import type { LocalAttachment } from './journal.js';
import { z } from 'zod';

/** Opt-in actual Chromium and supervisor proof; no user Chrome connection is used. */
export async function runBrowserSmoke(options: { executablePath: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-browser-proof-'));
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/cookie' ? `<!doctype html><title>Persistent profile</title><p>${request.headers.get('cookie') ?? 'missing'}</p>` : `<!doctype html><html lang="en"><title>Browser proof</title><label>Name<input id="name" value="SECRET-PRIVATE"></label><input type="password" value="SECRET-PASSWORD"><input autocomplete="cc-number" value="SECRET-PAYMENT"><div contenteditable="true"><span>SECRET-EDITABLE</span></div><button onclick="this.textContent='Hello '+document.querySelector('#name').value">Greet</button><span id="clock"></span><script>document.cookie='proof=persistent;Max-Age=3600;SameSite=Lax';setInterval(()=>document.querySelector('#clock').textContent=Date.now(),10)</script></html>`, { headers: { 'content-type': 'text/html' } }) });
  const authority = await browserTestAuthority(), local = { rootPath: directory } as LocalAttachment;
  const browser = new MachineBrowser({ directory, executablePath: options.executablePath, enabled: true, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  const url = `http://127.0.0.1:${fixture.port}`;
  try {
    const opened = browserText(await invoke({ action: 'open', url }));
    assert.equal(opened.source, 'headless');
    const targetId = opened.targetId;
    await assert.rejects(() => invoke({ action: 'observe', targetId }, 'other'), /scope/);
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
    try { await browser.close(); }
    finally {
      await fixture.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }
}
if (import.meta.main) {
  const executablePath = process.env.GITSPACE_BROWSER_PROOF_EXECUTABLE;
  if (!executablePath || process.env.GITSPACE_BROWSER_PROOF_ISOLATED !== '1') throw new Error('Set GITSPACE_BROWSER_PROOF_EXECUTABLE and GITSPACE_BROWSER_PROOF_ISOLATED=1 for a dedicated local Chromium proof');
  await runBrowserSmoke({ executablePath });
}
