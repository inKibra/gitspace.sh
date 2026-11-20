import { expect, test } from 'bun:test';
import { SECURE_INPUT_MARK, secureFillField } from './browser-secure-fill.js';

/** One field of the fake page, as the functions the fill runs on it see it. */
type Field = { localName: string; attributes: Map<string, string>; value: string; masked: string | null; selected: boolean; isConnected: boolean; isContentEditable: boolean; disabled: boolean; readOnly: boolean };

/**
 * A tab's CDP session over a page with one field at `#field` (backend node 12), on `origin` (the field's own window is
 * a frame when `frame`). The functions the fill sends run for real on the field; `Input.insertText` replaces a
 * selected field's value. `onFocus` runs when the field is focused (the page navigating meanwhile, say).
 */
function tab(options: { type?: string; origin?: string; frame?: boolean; onFocus?: (page: { origin: string }) => void } = {}) {
  const page = { origin: options.origin ?? 'https://app.example' };
  const field: Field = { localName: 'input', attributes: new Map(options.type ? [['type', options.type]] : []), value: '', masked: null, selected: false, isConnected: true, isContentEditable: false, disabled: false, readOnly: false };
  const element = {
    get localName() { return field.localName; }, get isConnected() { return field.isConnected; }, get isContentEditable() { return field.isContentEditable; }, get disabled() { return field.disabled; }, get readOnly() { return field.readOnly; },
    get type() { return field.attributes.get('type') ?? 'text'; },
    getAttribute: (name: string) => field.attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { field.attributes.set(name, value); },
    style: { setProperty: (name: string, value: string) => { if (name === '-webkit-text-security') field.masked = value; } },
    select: () => { field.selected = true; },
  };
  const top = {};
  const window = { top: options.frame ? top : null };
  if (!options.frame) window.top = window;
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const send = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    sent.push({ method, params });
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: params.selector === '#field' ? 5 : 0 };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: params.nodeId === 5 ? 12 : 0 } };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'DOM.resolveNode') { if (params.backendNodeId !== 12) throw new Error('No node with given id found'); return { object: { objectId: 'field' } }; }
    if (method === 'DOM.focus') { options.onFocus?.(page); return {}; }
    if (method === 'Runtime.callFunctionOn') {
      const factory: unknown = Reflect.apply(Function, undefined, ['window', 'location', `return (${String(params.functionDeclaration)})`]);
      const declared: unknown = typeof factory === 'function' ? Reflect.apply(factory, undefined, [window, page]) : null;
      if (typeof declared !== 'function') throw new Error('Not a function');
      const values = Array.isArray(params.arguments) ? params.arguments.map(argument => Reflect.get(Object(argument), 'value')) : [];
      return { result: { value: Reflect.apply(declared, element, values) } };
    }
    if (method === 'Input.insertText') { if (field.selected) field.value = String(params.text); return {}; }
    return {};
  };
  return { send, field, sent, methods: () => sent.map(({ method }) => method) };
}
const origin = 'https://app.example';
const value = 'correct horse battery staple';

test('a selector names the field: the value goes in as one insertText, and the text field is marked and masked', async () => {
  const { send, field, sent } = tab();
  expect(await secureFillField(send, { field: { selector: '#field' }, origin, value })).toEqual({ filled: true });
  expect(field.value).toBe(value);
  expect(field.attributes.has(SECURE_INPUT_MARK)).toBe(true);
  expect(field.masked).toBe('disc');
  expect(sent.filter(({ method }) => method === 'Input.insertText')).toEqual([{ method: 'Input.insertText', params: { text: value } }]);
  // The value goes nowhere but the insert.
  expect(JSON.stringify(sent.filter(({ method }) => method !== 'Input.insertText'))).not.toContain(value);
});

test('a ref names the field by its backend node, with no query of the page', async () => {
  const { send, field, methods } = tab();
  expect(await secureFillField(send, { field: { ref: '0:12' }, origin, value })).toEqual({ filled: true });
  expect(field.value).toBe(value);
  expect(methods()).not.toContain('DOM.querySelector');
});

test('a password field is filled unmasked; a one-time-code text field is masked', async () => {
  const password = tab({ type: 'password' });
  expect(await secureFillField(password.send, { field: { selector: '#field' }, origin, value })).toEqual({ filled: true });
  expect(password.field.masked).toBeNull();
  expect(password.field.attributes.has(SECURE_INPUT_MARK)).toBe(true);
  const code = tab({ type: 'text' });
  code.field.attributes.set('autocomplete', 'one-time-code');
  expect(await secureFillField(code.send, { field: { selector: '#field' }, origin, value: '123456' })).toEqual({ filled: true });
  expect(code.field.masked).toBe('disc');
});

test('a page on another origin is refused before anything goes in', async () => {
  const { send, field, methods } = tab({ origin: 'https://evil.example' });
  expect(await secureFillField(send, { field: { selector: '#field' }, origin, value })).toEqual({ refused: 'The tab shows https://evil.example, not https://app.example' });
  expect(methods()).not.toContain('Input.insertText');
  expect(field.attributes.has(SECURE_INPUT_MARK)).toBe(false);
});

test('a page that changed origin before the insert is refused, and the value never goes in', async () => {
  const { send, field, methods } = tab({ onFocus: page => { page.origin = 'https://evil.example'; } });
  expect(await secureFillField(send, { field: { selector: '#field' }, origin, value })).toEqual({ refused: 'The tab shows https://evil.example, not https://app.example' });
  expect(methods()).not.toContain('Input.insertText');
  expect(field.value).toBe('');
});

test('a field in a frame, a field that takes no text and a missing field are refused', async () => {
  const frame = tab({ frame: true });
  expect(await secureFillField(frame.send, { field: { selector: '#field' }, origin, value })).toEqual({ refused: 'The field is inside a frame, not the tab\'s page' });
  const box = tab({ type: 'checkbox' });
  expect(await secureFillField(box.send, { field: { selector: '#field' }, origin, value })).toEqual({ refused: 'The field does not take typed text' });
  const missing = tab();
  expect(await secureFillField(missing.send, { field: { selector: '#other' }, origin, value })).toEqual({ refused: 'The page has no such field now' });
  expect(await secureFillField(missing.send, { field: { ref: '0:99' }, origin, value })).toEqual({ refused: 'The field is gone from the tab\'s page' });
  for (const { methods } of [frame, box, missing]) expect(methods()).not.toContain('Input.insertText');
});
