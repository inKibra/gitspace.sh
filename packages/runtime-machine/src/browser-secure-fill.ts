/** Secure input's fill (`secure-input.ts` in protocol-runtime), the same on your Chrome (the extension) and the cloud
 * browser (its session object): CDP to one tab, in an isolated world, never the page's own JavaScript world. */

/** One tab's CDP session. */
export type SecureFillSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
/** What a fill did: filled, or refused with why. The value appears in neither. */
export type SecureFillOutcome = { filled: true } | { refused: string };

/** The attribute a filled field carries until its page goes: capture recorders mask it (`capture-tracks.ts`). */
export const SECURE_INPUT_MARK = 'data-gitspace-secure-input';
/** The field's state, read in the isolated world: still in its page, on the top page (not a frame), takes text, is a
 * password field, and the origin its page shows. */
const FIELD_STATE = `function() {
  const types = { '': 1, text: 1, email: 1, tel: 1, url: 1, search: 1, password: 1, number: 1 };
  const input = this.localName === 'input' && types[(this.getAttribute('type') || '').toLowerCase()] === 1;
  const fillable = (input || this.localName === 'textarea' || this.isContentEditable === true) && !this.disabled && !this.readOnly;
  return { connected: this.isConnected, top: window === window.top, fillable, password: this.localName === 'input' && this.type === 'password', origin: location.origin };
}`;
/** Marks the field (masking what it shows unless it is a password field, so screenshots, screencasts and recordings
 * of the page show no value until it navigates), selects what it holds so the fill replaces it, and answers the
 * origin its page shows now. */
const MARK_AND_SELECT = `function(mask) {
  this.setAttribute('${SECURE_INPUT_MARK}', '');
  if (mask) this.style.setProperty('-webkit-text-security', 'disc', 'important');
  if (typeof this.select === 'function') this.select();
  else { const range = document.createRange(); range.selectNodeContents(this); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  return location.origin;
}`;

type FieldState = { connected: boolean; top: boolean; fillable: boolean; password: boolean; origin: string };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
function fieldState(value: unknown): FieldState | null {
  const state = record(value);
  return typeof state.connected === 'boolean' && typeof state.top === 'boolean' && typeof state.fillable === 'boolean' && typeof state.password === 'boolean' && typeof state.origin === 'string'
    ? { connected: state.connected, top: state.top, fillable: state.fillable, password: state.password, origin: state.origin } : null;
}
/** A `Runtime.callFunctionOn` answer's value; null when it threw. */
function returned(answer: unknown): unknown {
  const reply = record(answer);
  return reply.exceptionDetails === undefined ? record(reply.result).value : null;
}
/** The backend node a selector or ref names in the tab's top page, or null when none does. */
async function fieldNode(send: SecureFillSend, field: { selector: string } | { ref: string }): Promise<number | null> {
  if ('ref' in field) {
    const node = Number(field.ref.split(':').at(-1));
    return Number.isSafeInteger(node) && node > 0 ? node : null;
  }
  const root = record(record(await send('DOM.getDocument', { depth: 0 })).root).nodeId;
  const found = record(await send('DOM.querySelector', { nodeId: root, selector: field.selector })).nodeId;
  if (typeof found !== 'number' || found === 0) return null;
  const node = record(record(await send('DOM.describeNode', { nodeId: found })).node).backendNodeId;
  return typeof node === 'number' ? node : null;
}

/**
 * Fills `value` into the field `field` names on one tab, only while the tab's top page shows `origin`: checked when the
 * field is found and again right before the value goes in. The field must be in the top page and take text. A field
 * that is not a password field is masked once filled. The value goes in as one `Input.insertText`, as typing it would.
 */
export async function secureFillField(send: SecureFillSend, input: { field: { selector: string } | { ref: string }; origin: string; value: string }): Promise<SecureFillOutcome> {
  let node: number | null;
  try { node = await fieldNode(send, input.field); } catch { node = null; }
  if (node === null) return { refused: 'The page has no such field now' };
  const frame = record(record(record(await send('Page.getFrameTree')).frameTree).frame).id;
  const world = record(await send('Page.createIsolatedWorld', { frameId: frame, worldName: 'gitspace-secure-input' })).executionContextId;
  let objectId: unknown;
  try { objectId = record(record(await send('DOM.resolveNode', { backendNodeId: node, executionContextId: world })).object).objectId; } catch { objectId = undefined; }
  if (typeof objectId !== 'string') return { refused: 'The field is gone from the tab\'s page' };
  try {
    const state = fieldState(returned(await send('Runtime.callFunctionOn', { objectId, functionDeclaration: FIELD_STATE, returnByValue: true })));
    if (!state?.connected) return { refused: 'The field is gone from the tab\'s page' };
    if (!state.top) return { refused: 'The field is inside a frame, not the tab\'s page' };
    if (state.origin !== input.origin) return { refused: `The tab shows ${state.origin}, not ${input.origin}` };
    if (!state.fillable) return { refused: 'The field does not take typed text' };
    await send('DOM.focus', { backendNodeId: node });
    const origin = returned(await send('Runtime.callFunctionOn', { objectId, functionDeclaration: MARK_AND_SELECT, arguments: [{ value: !state.password }], returnByValue: true }));
    if (origin !== input.origin) return { refused: `The tab shows ${typeof origin === 'string' ? origin : 'another page'}, not ${input.origin}` };
    await send('Input.insertText', { text: input.value });
    return { filled: true };
  } finally { await send('Runtime.releaseObject', { objectId }).catch(() => {}); }
}
