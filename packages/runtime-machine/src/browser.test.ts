import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineBrowser } from './browser.js';
import { BrowserOutputStore, BROWSER_ARTIFACT_BYTES, boundedText } from './browser-output.js';
import { browserTestAuthority, browserInvoker, browserText } from './browser-test-support.js';
import { RuntimeBrowserArgumentsSchema, type RuntimeBrowserArguments, type RuntimeBrowserSignedGrant } from '@gitspace/protocol-runtime';
import type { RuntimeBrowserRelay, RuntimeBrowserRelayChannel } from './browser-relay-transport.js';
import type { LocalAttachment } from './journal.js';
import { ExecutorEffectUncertain } from './commands.js';
import * as identities from '../../supervisor/src/process-identity.js';

class Relay implements RuntimeBrowserRelay {
  async authorize() {}
  async tabs(groupId: string) { return [...this.channels].filter(([, entry]) => entry.grant.body.groupId === groupId).map(([targetId]) => ({ targetId, title: 'Fixture', url: 'https://fixture.test' })); }
  channels = new Map<string, { grant: RuntimeBrowserSignedGrant; listener?: (event: unknown) => void }>();
  connected = true;
  detached = false;
  uncertain = false;
  block?: Promise<void>;
  axNodes?: unknown[];
  navigationLoaded = true;
  async status() { return { connected: true }; }
  async prepare() {}
  async open(signed: RuntimeBrowserSignedGrant, args: RuntimeBrowserArguments): Promise<RuntimeBrowserRelayChannel & { targetId: string }> {
    if (args.action === 'tabs') throw new Error('Tabs has no target');
    const targetId = args.targetId ?? crypto.randomUUID(), grant = signed.body;
    let entry = this.channels.get(targetId);
    if (!entry) { entry = { grant: signed }; this.channels.set(targetId, entry); }
    const current = entry;
    return {
      targetId,
      send: async (method, params = {}) => {
        if (method === 'Target.attachToTarget') return { sessionId: targetId };
        if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'page', targetId: targetId, title: 'Fixture', url: 'https://fixture.test' } };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: 'https://fixture.test' } } };
        if (method === 'Page.navigate') return { frameId: 'frame', loaded: this.navigationLoaded };
        if (method === 'Accessibility.getFullAXTree') {
          if (grant.workspaceId === 'blocked') await this.block;
          current.listener?.({ method: 'DOM.attributeModified', sessionId: targetId });
          if (this.axNodes) return { gitspaceDocument: 0, nodes: this.axNodes };
          return { gitspaceDocument: 0, nodes: Array.from({ length: 500 }, (_, i) => ({ nodeId: String(i), backendDOMNodeId: i + 1, role: { value: i === 0 ? 'textbox' : 'button' }, name: { value: i === 0 ? 'secret' : 'x'.repeat(4000) }, value: { value: 'secret' } })) };
        }
        if (method === 'DOM.describeNode') return { node: { backendNodeId: params.backendNodeId, nodeName: 'BUTTON' } };
        if (method === 'Target.closeTarget') { this.channels.delete(targetId); return { success: true }; }
        if (method === 'GitSpace.validateRef') return { connected: !this.detached };
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        if (method === 'Input.dispatchMouseEvent' && this.uncertain) throw new ExecutorEffectUncertain('lost acknowledgement');
        return {};
      },
      subscribe: listener => { current.listener = listener; return () => { current.listener = undefined; }; },
      close: async () => {},
    };
  }
  async revoke(id: string) { for (const [targetId, entry] of this.channels) if (entry.grant.body.groupId === id) this.channels.delete(targetId); }
}
const local = { rootPath: '/tmp' } as LocalAttachment;
test('signed relay commands enforce identity, stable document refs, redaction, bounds and revoke', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-test-')), authority = await browserTestAuthority(), relay = new Relay();
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  try {
    const opened = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'tab' }));
    expect(opened.targetId).toBe('tab');
    const observed = browserText(await invoke({ action: 'observe', source: 'relay', targetId: opened.targetId, limit: 200 }));
    expect(observed.nodes[0].name).toBe('[form field]'); expect(JSON.stringify(observed)).not.toContain('secret'); expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(32768); expect(observed.nextOffset).toBeGreaterThan(0);
    await invoke({ action: 'act', source: 'relay', targetId: opened.targetId, ref: observed.nodes[1].ref, operation: 'click' });
    relay.detached = true;
    await expect(invoke({ action: 'act', source: 'relay', targetId: opened.targetId, ref: observed.nodes[1].ref, operation: 'click' })).rejects.toThrow('detached');
    await expect(invoke({ action: 'observe', source: 'relay', targetId: opened.targetId }, 'other')).rejects.toThrow('scope');
    const args = RuntimeBrowserArgumentsSchema.parse({ action: 'observe', source: 'relay', targetId: opened.targetId });
    const grant = relay.channels.get(opened.targetId)!.grant;
    const signed = await authority.dispatch(args, { type: 'execute', args, grant });
    signed.requestId = 'altered'; await expect(browser.execute(signed, local, AbortSignal.timeout(1000))).rejects.toThrow('scope');
    const replay = await authority.dispatch(args, { type: 'execute', args, grant });
    await browser.execute(replay, local, AbortSignal.timeout(1000)); await expect(browser.execute(replay, local, AbortSignal.timeout(1000))).rejects.toThrow('consumed');
    await browser.execute(await authority.dispatch({ action: 'revoke', groupId: opened.groupId }, { type: 'manage', action: 'revoke', groupId: opened.groupId }), local, AbortSignal.timeout(1000));
    await expect(invoke(args)).rejects.toThrow('stale');
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test('relay navigation exposes loaded and partial completion to the browser caller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-navigation-')), authority = await browserTestAuthority(), relay = new Relay();
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  try {
    const opened = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'navigation-tab' }));
    const navigate = { action: 'navigate', source: 'relay', targetId: opened.targetId, url: 'https://fixture.test/next' };
    expect(browserText(await invoke(navigate))).toMatchObject({ frameId: 'frame', loaded: true });
    relay.navigationLoaded = false;
    expect(browserText(await invoke(navigate))).toMatchObject({ frameId: 'frame', loaded: false });
    // Partial completion is a known result, not an uncertain-effect fence.
    relay.navigationLoaded = true;
    expect(browserText(await invoke(navigate))).toMatchObject({ frameId: 'frame', loaded: true });
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
test('one signed group discovers multiple targets and closing a tab preserves sibling access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-group-')), authority = await browserTestAuthority(), relay = new Relay();
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  try {
    const first = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'first' }));
    const second = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'second' }));
    expect(second.groupId).toBe(first.groupId);
    expect(browserText(await invoke({ action: 'tabs', source: 'relay' })).map((tab: { targetId: string }) => tab.targetId)).toEqual(['first', 'second']);
    await invoke({ action: 'close', source: 'relay', targetId: first.targetId });
    expect(browserText(await invoke({ action: 'observe', source: 'relay', targetId: second.targetId })).nodes[0].name).toBe('[form field]');
    await browser.execute(await authority.dispatch({ action: 'revoke', groupId: first.groupId }, { type: 'manage', action: 'revoke', groupId: first.groupId }), local, AbortSignal.timeout(1000));
    await expect(invoke({ action: 'observe', source: 'relay', targetId: second.targetId })).rejects.toThrow('stale');
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
test('revocation fences an envelope while renewed workspace group remains usable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-renew-')), authority = await browserTestAuthority(), relay = new Relay();
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  try {
    const opened = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'renewed' }));
    const old = relay.channels.get(opened.targetId)!.grant;
    await browser.execute(await authority.dispatch({ action: 'revoke', groupId: opened.groupId }, { type: 'manage', action: 'revoke', groupId: opened.groupId }), local, AbortSignal.timeout(1000));
    const args = RuntimeBrowserArgumentsSchema.parse({ action: 'open', source: 'relay', targetId: opened.targetId });
    const renewed = await authority.grant({ ...old.body, expiresAt: new Date(Date.parse(old.body.expiresAt) + 1000).toISOString() });
    expect(browserText(await browser.execute(await authority.dispatch(args, { type: 'execute', args, grant: renewed }), local, AbortSignal.timeout(1000))).targetId).toBe(opened.targetId);
    await expect(browser.execute(await authority.dispatch(args, { type: 'execute', args, grant: old }), local, AbortSignal.timeout(1000))).rejects.toThrow('revoked');
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
test('different workspaces progress independently and uncertain effects retain recovery fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-parallel-')), authority = await browserTestAuthority(), relay = new Relay();
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const blocked = browserInvoker(browser, authority, local, 'blocked'), free = browserInvoker(browser, authority, local, 'free');
  const gate = Promise.withResolvers<void>(); relay.block = gate.promise;
  try {
    const a = browserText(await blocked({ action: 'open', source: 'relay', targetId: 'a' })), b = browserText(await free({ action: 'open', source: 'relay', targetId: 'b' }));
    const pending = blocked({ action: 'observe', source: 'relay', targetId: a.targetId });
    const observation = browserText(await free({ action: 'observe', source: 'relay', targetId: b.targetId }));
    relay.uncertain = true;
    await expect(free({ action: 'act', source: 'relay', targetId: b.targetId, ref: observation.nodes[1].ref, operation: 'click' })).rejects.toBeInstanceOf(ExecutorEffectUncertain);
    const status = browserText(await browser.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }, 'free'), local, AbortSignal.timeout(1000)));
    expect(status.records.some((record: {state:string}) => record.state === 'fenced')).toBe(true);
    gate.resolve(); await pending;
  } finally { gate.resolve(); await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
test('corrupt recovery record does not reject startup or authorize a process kill', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-recovery-')), authority = await browserTestAuthority();
  const recordId = `browser-${crypto.randomUUID()}.json`;
  await mkdir(join(directory, 'launches')); await writeFile(join(directory, 'launches', recordId), JSON.stringify({ projectId: 'project', workspaceId: 'workspace' }));
  const browser = new MachineBrowser({ directory, enabled: true, executablePath: '/nonexistent/browser-recovery-must-not-launch', verifyAuthorization: authority.verifyAuthorization });
  try {
    await browser.recover();
    const status = browserText(await browser.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }), local, AbortSignal.timeout(1000)));
    expect(status.records[0].state).toBe('stopped');
    await browser.execute(await authority.dispatch({ action: 'discard', recordId }, { type: 'manage', action: 'discard', recordId }), local, AbortSignal.timeout(1000));
    const discarded = browserText(await browser.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }), local, AbortSignal.timeout(1000)));
    expect(discarded.records).toEqual([]);
    const other = browserText(await browser.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }, 'other'), local, AbortSignal.timeout(1000)));
    expect(other.records).toEqual([]);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const evidence of ['prior', 'same', 'legacy', 'unavailable', 'unrecorded'] as const) {
test(`corrupt browser recovery requires positive boot absence: ${evidence}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-unresolved-')), authority = await browserTestAuthority();
  const recordId = `browser-${crypto.randomUUID()}.json`, name = 'browser-unresolved';
  const currentBoot = spyOn(identities, 'bootIdentity').mockResolvedValue(evidence === 'unavailable' ? null : 'current-boot');
  const claimBoot = evidence === 'legacy' ? undefined : evidence === 'unrecorded' ? null : evidence === 'same' ? 'current-boot' : 'prior-boot';
  await mkdir(join(directory, 'launches'));
  await writeFile(join(directory, 'launches', recordId), JSON.stringify({ projectId: 'project', workspaceId: 'workspace' }));
  const registry = join(directory, 'supervisor', 'daemons', name);
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, 'meta.json'), JSON.stringify({
    daemon: { id: crypto.randomUUID(), name, owner: 'runtime:project:workspace', state: 'starting', createdAt: new Date().toISOString(), pid: null, exitCode: null, restartCount: 0 },
    spec: { name, application: '/unverified', args: [], envNames: [], cwd: directory, pty: false, restart: 'no', persist: true, detached: false },
    identity: null, claimBoot, cursor: 0, base: 0, output: '',
  }));
  const browser = new MachineBrowser({ directory, enabled: true, verifyAuthorization: authority.verifyAuthorization });
  try {
    await browser.recover();
    const status = browserText(await browser.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }), local, AbortSignal.timeout(1000)));
    expect(status.records[0].state).toBe(evidence === 'prior' ? 'stopped' : 'uncertain');
    if (evidence === 'prior') {
      await browser.execute(await authority.dispatch({ action: 'discard', recordId }, { type: 'manage', action: 'discard', recordId }), local, AbortSignal.timeout(1000));
      const discarded = browserText(await browser.execute(await authority.dispatch({ action: 'status' }, { type: 'manage', action: 'status' }), local, AbortSignal.timeout(1000)));
      expect(discarded.records).toEqual([]);
    } else {
      for (const action of ['reconcile', 'discard'] as const) {
        await expect(browser.execute(await authority.dispatch({ action, recordId }, { type: 'manage', action, recordId }), local, AbortSignal.timeout(1000))).rejects.toThrow('absence is not proven');
      }
    }
  } finally { currentBoot.mockRestore(); await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
}
test('artifact storage enforces scope, byte paging, total cap and expiration', () => {
  const store = new BrowserOutputStore(), artifact = store.put('scope', 'é'.repeat(20000), 'machine');
  const page = store.read('scope', artifact.id, 0, 10);
  expect(Buffer.from(page.data, 'base64').length).toBe(10); expect(page.nextOffset).toBe(10);
  expect(() => store.read('other', artifact.id)).toThrow('scope'); expect(() => store.read('scope', artifact.id, 0, 100000)).toThrow('range');
  expect(() => store.put('scope', 'x'.repeat(BROWSER_ARTIFACT_BYTES + 1), 'machine')).toThrow('limit');
  store.clear(); expect(() => store.read('scope', artifact.id)).toThrow('expired');
});

test('UTF-8 truncation stays within its byte budget without replacement characters', () => {
  const value = boundedText('é'.repeat(10), 8);
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(8);
  expect(value).not.toContain('\uFFFD');
  expect(value).toBe('éé…');
});

test('spontaneous cross-origin navigation revokes subsequent commands but unrelated mutations retain refs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-origin-')), authority = await browserTestAuthority(), relay = new Relay();
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  try {
    const opened = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'origin-tab' }));
    const observation = browserText(await invoke({ action: 'observe', source: 'relay', targetId: opened.targetId }));
    const entry = relay.channels.get(opened.targetId)!;
    entry.listener?.({ method: 'DOM.childNodeInserted', sessionId: opened.targetId });
    await invoke({ action: 'act', source: 'relay', targetId: opened.targetId, ref: observation.nodes[1].ref, operation: 'click' });
    entry.listener?.({ method: 'Page.frameNavigated', sessionId: opened.targetId, params: { frame: { id: 'frame', url: 'https://unapproved.test' } } });
    await expect(invoke({ action: 'observe', source: 'relay', targetId: opened.targetId })).rejects.toThrow('stale');

  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test('AX redacts editable descendants before pagination including ignored roots and parent-only links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-ax-sensitive-')), authority = await browserTestAuthority(), relay = new Relay();
  relay.axNodes = [
    { nodeId: 'payment', role: { value: 'textbox' }, childIds: ['payment-wrapper'] },
    { nodeId: 'payment-wrapper', ignored: true, childIds: ['payment-value'] },
    { nodeId: 'payment-value', role: { value: 'StaticText' }, name: { value: 'secret-card-number' } },
    { nodeId: 'editor', ignored: true, role: { value: 'generic' }, properties: [{ name: 'editable', value: { value: 'richtext' } }] },
    { nodeId: 'editor-value', parentId: 'editor', role: { value: 'StaticText' }, name: { value: 'secret-contenteditable' } },
    { nodeId: 'editor-inline', parentId: 'editor-value', role: { value: 'InlineTextBox' }, name: { value: 'secret-contenteditable' } },
    { nodeId: 'public', role: { value: 'StaticText' }, name: { value: 'Public description' } },
    { nodeId: 'labelled', role: { value: 'textbox' }, name: { value: 'Name', sources: [{ type: 'relatedElement', nativeSource: 'labelwrapped', value: { value: 'Name' } }] } },
    { nodeId: 'aria', role: { value: 'textbox' }, name: { value: 'Card holder', sources: [{ type: 'attribute', attribute: 'aria-label', value: { value: 'Card holder' } }] } },
    { nodeId: 'value-name', role: { value: 'textbox' }, name: { value: 'secret-derived-name', sources: [{ type: 'attribute', attribute: 'value', value: { value: 'secret-derived-name' } }, { type: 'relatedElement', nativeSource: 'label', superseded: true, value: { value: 'secret-unused-label' } }] } },
  ];
  const browser = new MachineBrowser({ directory, enabled: true, relay, verifyAuthorization: authority.verifyAuthorization });
  const invoke = browserInvoker(browser, authority, local);
  try {
    const opened = browserText(await invoke({ action: 'open', source: 'relay', targetId: 'sensitive-tab' }));
    const observed = browserText(await invoke({ action: 'observe', source: 'relay', targetId: opened.targetId, offset: 1, limit: 10 }));
    expect(observed.nodes.map((node: { name: string }) => node.name)).toEqual(['[form field]', '[form field]', '[form field]', 'Public description', 'Name', 'Card holder', '[form field]']);
    expect(JSON.stringify(observed)).not.toContain('secret');
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
