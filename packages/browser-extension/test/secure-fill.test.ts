import { afterEach, describe, expect, it } from 'bun:test';
import { Window, type Element } from 'happy-dom';
import { SECURE_INPUT_MARK } from '@gitspace/runtime-machine/browser-secure-fill';
import { installed, settle, type DebuggerCommand } from './installed.js';

const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

const SECURE_INPUT_ID = 'A'.repeat(43);
const VALUE = 'correct horse battery staple';

/** Your Chrome, connected, with tab 1 (target-1) of the workspace's group showing a sign-in page on
 * https://app.example. The tab's debugger answers the DOM, Runtime and Input commands a fill sends from that page:
 * functions run on its elements and inserted text replaces the focused field's value. */
async function signIn(options: { takeover?: boolean } = {}) {
  const chrome = await installed(options);
  const window = new Window({ url: 'https://app.example/login' });
  windows.push(window);
  window.document.body.innerHTML = '<input id="user" name="user"><input id="pass" type="password">';
  const nodes: Element[] = [];
  const nodeId = (element: Element) => { if (!nodes.includes(element)) nodes.push(element); return nodes.indexOf(element) + 1; };
  const element = (id: unknown) => nodes[Number(id) - 1];
  chrome.answer(({ targetId, method, params }: DebuggerCommand) => {
    if (targetId !== 'target-1') return undefined;
    if (method === 'DOM.getDocument') return { root: { nodeId: 1000 } };
    if (method === 'DOM.querySelector') { const found = window.document.querySelector(String(params.selector)); return { nodeId: found ? nodeId(found) : 0 }; }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: params.nodeId } };
    if (method === 'DOM.resolveNode') return element(params.backendNodeId) ? { object: { objectId: String(params.backendNodeId) } } : undefined;
    if (method === 'Runtime.callFunctionOn') {
      const values = Array.isArray(params.arguments) ? params.arguments.map(argument => Reflect.get(Object(argument), 'value')) : [];
      return { result: { value: window.eval(`(${String(params.functionDeclaration)})`).apply(element(params.objectId), values) } };
    }
    if (method === 'DOM.focus') { Reflect.apply(Reflect.get(element(params.backendNodeId) ?? {}, 'focus'), element(params.backendNodeId), []); return {}; }
    if (method === 'Input.insertText') { Reflect.set(window.document.activeElement ?? {}, 'value', params.text); return {}; }
    return undefined;
  });
  const field = (id: string) => { const found = window.document.getElementById(id); if (!found) throw new Error(`No #${id}`); return found; };
  /** The account signs a fill of `field` on target-1 for https://app.example, then sends it with the value. */
  const fill = async (selector: string, options: { sign?: boolean; origin?: string } = {}) => {
    const fields = { groupId: chrome.grant.body.groupId, targetId: 'target-1', origin: options.origin ?? 'https://app.example', selector, secureInputId: SECURE_INPUT_ID };
    if (options.sign !== false) await chrome.authorize({ type: 'manage', action: 'secureFill', ...fields, fillKind: 'text' }, 'browser_control');
    return send(fields);
  };
  const send = (fields: Record<string, unknown>) => chrome.execute({ operation: 'secureFill', ...fields, kind: 'text', value: VALUE });
  return { chrome, window, field, fill, send };
}

describe('a secure input fill', () => {
  it('fills the signed field of the tab and answers filled; the field is masked and marked, and the value reaches nothing else', async () => {
    const { chrome, window, field, fill } = await signIn();
    expect(await fill('#user')).toEqual({ filled: true });
    const user = field('user');
    expect(Reflect.get(user, 'value')).toBe(VALUE);
    expect(user.hasAttribute(SECURE_INPUT_MARK)).toBe(true);
    expect(window.getComputedStyle(user).getPropertyValue('-webkit-text-security')).toBe('disc');
    expect(chrome.commands.filter(({ method }) => method === 'Input.insertText')).toEqual([{ targetId: 'target-1', method: 'Input.insertText', params: { text: VALUE } }]);
    const elsewhere = JSON.stringify([chrome.sent, [...chrome.stored.values()].filter(value => !(value instanceof CryptoKey)), [...chrome.local.values()], chrome.commands.filter(({ method }) => method !== 'Input.insertText')]);
    expect(elsewhere).not.toContain(VALUE);
  });

  it('fills a password field unmasked, as the page masks it itself', async () => {
    const { field, fill } = await signIn();
    expect(await fill('#pass')).toEqual({ filled: true });
    expect(Reflect.get(field('pass'), 'value')).toBe(VALUE);
    expect(field('pass').hasAttribute(SECURE_INPUT_MARK)).toBe(true);
    expect(field('pass').getAttribute('style') ?? '').not.toContain('text-security');
  });

  it('is refused on a tab that went to another origin, and its field stays empty', async () => {
    const { chrome, field, fill } = await signIn();
    await chrome.updateTab(1, { url: 'https://news.example/' });
    expect(await fill('#user')).toEqual({ refused: 'The tab shows https://news.example, not https://app.example' });
    expect(Reflect.get(field('user'), 'value')).toBe('');
    expect(chrome.sentCommands()).not.toContain('Input.insertText');
  });

  it('is refused on a closed tab and on a tab that left the group', async () => {
    const { chrome, fill } = await signIn();
    await chrome.updateTab(1, { groupId: -1 });
    expect(await fill('#user')).toEqual({ refused: 'The tab left the workspace group' });
    await chrome.closeTab(1);
    expect(await fill('#user')).toEqual({ refused: 'The tab is closed' });
    expect(chrome.sentCommands()).not.toContain('Input.insertText');
  });

  it('needs its own signed fill, used once', async () => {
    const { chrome, field, fill, send } = await signIn();
    await expect(fill('#user', { sign: false })).rejects.toThrow('Signed secure input fill required');
    // Signed for another field.
    await chrome.authorize({ type: 'manage', action: 'secureFill', groupId: chrome.grant.body.groupId, targetId: 'target-1', origin: 'https://app.example', selector: '#pass', fillKind: 'text', secureInputId: SECURE_INPUT_ID }, 'browser_control');
    await expect(send({ groupId: chrome.grant.body.groupId, targetId: 'target-1', origin: 'https://app.example', selector: '#user', secureInputId: SECURE_INPUT_ID })).rejects.toThrow('Signed secure input fill required');
    // Signed for another secure input.
    await chrome.authorize({ type: 'manage', action: 'secureFill', groupId: chrome.grant.body.groupId, targetId: 'target-1', origin: 'https://app.example', selector: '#user', fillKind: 'text', secureInputId: 'B'.repeat(43) }, 'browser_control');
    await expect(send({ groupId: chrome.grant.body.groupId, targetId: 'target-1', origin: 'https://app.example', selector: '#user', secureInputId: SECURE_INPUT_ID })).rejects.toThrow('Signed secure input fill required');
    expect(chrome.sentCommands()).not.toContain('Input.insertText');
    expect(await fill('#user')).toEqual({ filled: true });
    Reflect.set(field('user'), 'value', '');
    await expect(send({ groupId: chrome.grant.body.groupId, targetId: 'target-1', origin: 'https://app.example', selector: '#user', secureInputId: SECURE_INPUT_ID })).rejects.toThrow('Signed secure input fill required');
    expect(Reflect.get(field('user'), 'value')).toBe('');
  });

  it('is not your input: the tab the agent works in stays the agent’s', async () => {
    const { chrome, fill } = await signIn({ takeover: true });
    const held = () => chrome.sent.some(message => 'group' in message && JSON.stringify(message.group).includes('"holder":"you"'));
    await chrome.authorize({ type: 'execute', args: { action: 'observe', source: 'relay', targetId: 'target-1', screenshot: false, offset: 0, limit: 400 }, grant: chrome.grant }, 'browser');
    await chrome.execute({ operation: 'open', grant: chrome.grant });
    await settle();
    expect(await fill('#user')).toEqual({ filled: true });
    // The overlay reads the fill's typed text as input on the page.
    await chrome.fromPage(1, 'take');
    expect(held()).toBe(false);
    // Your own input after that takes the tab.
    await chrome.advance(300);
    await chrome.fromPage(1, 'take');
    expect(held()).toBe(true);
  });
});

describe('the hello', () => {
  it('says this extension takes secure input fills', async () => {
    const chrome = await installed({ live: true });
    await chrome.relay();
    await chrome.waitFor(() => chrome.sent.some(message => message.hello));
    expect(chrome.sent.find(message => message.hello)).toMatchObject({ secureInput: true });
  });
});
