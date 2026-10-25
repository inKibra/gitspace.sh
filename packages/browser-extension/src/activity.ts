/**
 * What an agent is doing on your Chrome, in a few words, for the popup and the in-page toolbar (docs/APERTURE-DESIGN.md
 * §6.4): "Clicking “Medium”", "Typing in “Customer name”", "Opening httpbin.org", "Running a script". A single step
 * says it from the step it was signed for, naming the element by the accessible name the agent read when it observed
 * the page; a script says it from its commands as they pass. It never says what is typed. Who acts is the signed
 * scope's `conversationKind`: `main`, since the relay lets only the main agent use your Chrome.
 */
import type { RuntimeBrowserArguments } from '@gitspace/protocol-runtime';

/** The keys a step may press, and those a script's key presses are named by; any other key is typing. */
export const NAMED_KEYS: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32 };
/** An element's name in an activity is at most this long. */
const NAME_LENGTH = 40;

/** `verb` and an element's accessible name in quotes, trimmed of a label's colon; the verb alone without a name. */
function naming(verb: string, name: string | null | undefined): string {
  const plain = (name ?? '').replace(/\s+/g, ' ').trim().replace(/\s*:$/, '');
  if (!plain) return verb;
  return `${verb} “${plain.length > NAME_LENGTH ? `${plain.slice(0, NAME_LENGTH - 1)}…` : plain}”`;
}

function opening(url: string): string {
  try { return `Opening ${new URL(url).hostname}`; } catch { return 'Opening a page'; }
}

/** A single step, from its signed arguments; `names` are the accessible names of the page the agent last observed,
 * by backend node id. */
export function stepActivity(args: RuntimeBrowserArguments, names: ReadonlyMap<number, string>): string {
  if (args.action === 'open') return args.url ? opening(args.url) : 'Opening a tab';
  if (args.action === 'navigate') return opening(args.url);
  if (args.action === 'observe') return 'Reading the page';
  if (args.action === 'screenshot') return 'Taking a screenshot';
  if (args.action === 'close') return 'Closing a tab';
  if (args.action === 'tabs') return 'Looking at its tabs';
  if (args.action === 'act') {
    const name = names.get(Number(args.ref.split(':')[1]));
    if (args.operation === 'click') return naming('Clicking', name);
    if (args.operation === 'fill') return naming('Typing in', name);
    return args.value && Object.hasOwn(NAMED_KEYS, args.value) ? `Pressing ${args.value}` : 'Pressing a key';
  }
  return 'Running a script';
}

/** A script's command that changes what it is doing (null: it does not). A click is named by what is at its point
 * (`clickedName`). */
export function scriptActivity(method: string, params: Record<string, unknown>): string | null {
  if (method === 'Page.navigate' && typeof params.url === 'string') return opening(params.url);
  if (method === 'Input.insertText') return 'Typing';
  if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') return typeof params.key === 'string' && Object.hasOwn(NAMED_KEYS, params.key) ? `Pressing ${params.key}` : 'Typing';
  if (method === 'Page.captureScreenshot') return 'Taking a screenshot';
  return null;
}

/** An accessibility node as `Accessibility.getPartialAXTree` gives it, as far as naming uses it. */
type AXNode = { nodeId: string; parentId?: string; backendDOMNodeId?: number; ignored?: boolean; name?: { value?: unknown } };

/** "Clicking “name”" for the element at a clicked point: the nearest of it and its ancestors with a name. */
export function clickedName(nodes: readonly AXNode[], backendNodeId: number): string {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  let node = nodes.find(entry => entry.backendDOMNodeId === backendNodeId);
  for (let depth = 0; node && depth < 6; depth++, node = node.parentId ? byId.get(node.parentId) : undefined) {
    if (!node.ignored && typeof node.name?.value === 'string' && node.name.value.trim()) return naming('Clicking', node.name.value);
  }
  return 'Clicking';
}
