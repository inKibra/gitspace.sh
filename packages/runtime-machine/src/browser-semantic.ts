import { z } from 'zod';
import type { RuntimeBrowserArguments, RuntimeBrowserGrant } from '@gitspace/protocol-runtime';
import type { RuntimeToolResult } from '@gitspace/protocol-runtime';
type ExecutorContent = RuntimeToolResult['content'];
import { BROWSER_IMAGE_BYTES, BROWSER_TEXT_BYTES, boundedText } from './browser-output.js';
import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from './browser-screenshot.js';
const Evaluation = z.object({ result: z.object({ value: z.unknown().optional(), objectId: z.string().optional() }), exceptionDetails: z.unknown().optional() });
const AxTree = z.object({ gitspaceDocument: z.number().int().nonnegative().optional(), nodes: z.array(z.object({ nodeId: z.string().max(256), parentId: z.string().max(256).optional(), ignored: z.boolean().optional(), backendDOMNodeId: z.number().optional(), role: z.object({ value: z.unknown() }).optional(), name: z.object({ value: z.unknown(), sources: z.array(z.object({ type: z.string(), attribute: z.string().optional(), nativeSource: z.string().optional(), superseded: z.boolean().optional(), invalid: z.boolean().optional(), value: z.object({ value: z.unknown().optional() }).optional() })).max(256).optional() }).optional(), properties: z.array(z.object({ name: z.string(), value: z.object({ value: z.unknown().optional() }) })).max(256).optional(), childIds: z.array(z.string()).max(20000).optional() })).max(20000) });
const Box = z.object({ model: z.object({ content: z.array(z.number()).length(8) }) });
export type BrowserSemanticTab = { grant: Pick<RuntimeBrowserGrant, 'source' | 'groupId'>; targetId: string; refs: Map<string, number>; document: number };
export async function performBrowserAction(options: { tab: BrowserSemanticTab; args: RuntimeBrowserArguments; frame: { id: string }; signal: AbortSignal; send(method: string, params?: Record<string, unknown>): Promise<unknown>; close(): Promise<void>; allows(url: string): boolean; artifact(text: string): unknown; selectAllModifier: number }): Promise<ExecutorContent> {
 const { tab, args, frame, signal, send } = options; const grant = tab.grant;
      let result: unknown = { ok: true };
      const content: ExecutorContent = [];
      if (args.action === 'close') await options.close();
      else if (args.action === 'navigate') {
        const destination = new URL(args.url); if (!['http:', 'https:'].includes(destination.protocol) && args.url !== 'about:blank') throw new Error('Browser navigation supports only HTTP, HTTPS or about:blank');
        if (!options.allows(args.url)) throw new Error('Navigation origin not authorized');
        const navigationResult = await send('Page.navigate', { url: args.url });
        result = grant.source === 'relay'
          ? z.object({ loaded: z.boolean(), frameId: z.string() }).parse(navigationResult)
          : z.object({ frameId: z.string().optional(), errorText: z.string().optional() }).parse(navigationResult);
        tab.refs.clear(); tab.document++;
      } else if (args.action === 'evaluate') {
        const evaluated = Evaluation.parse(await send('Runtime.evaluate', { expression: args.expression, returnByValue: true, awaitPromise: true }));
        if (evaluated.exceptionDetails) throw new Error('Browser expression failed'); result = evaluated.result.value ?? null;
      } else if (args.action === 'observe') {
        const document = tab.document;
        const tree = AxTree.parse(await send('Accessibility.getFullAXTree', { depth: 32 }));
        if (document !== tab.document) throw new Error('Browser document changed during observation');
        if (grant.source === 'relay') {
          if (tree.gitspaceDocument === undefined) throw new Error('Relay observation lacks document identity');
          tab.document = tree.gitspaceDocument;
        }
        // Chromium exposes editable values again as descendant StaticText/InlineTextBox
        // names. Redact the complete AX subtree before pagination, including ignored
        // ancestors and generic rich-text/contenteditable roots.
        const children = new Map<string, string[]>();
        const sensitiveIds = new Set<string>();
        const sensitiveRoots = new Set<string>();
        const pending: string[] = [];
        for (const node of tree.nodes) {
          if (node.childIds) children.set(node.nodeId, [...node.childIds]);
          const role = typeof node.role?.value === 'string' ? node.role.value : '';
          if (['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox'].includes(role)
            || node.properties?.some(property => (property.name === 'editable' && property.value.value !== false && property.value.value !== undefined)
              || (property.name === 'protected' && property.value.value === true))) { pending.push(node.nodeId); sensitiveRoots.add(node.nodeId); }
        }
        for (const node of tree.nodes) if (node.parentId) {
          const siblings = children.get(node.parentId);
          if (siblings) siblings.push(node.nodeId); else children.set(node.parentId, [node.nodeId]);
        }
        while (pending.length) {
          const id = pending.pop()!;
          if (sensitiveIds.has(id)) continue;
          sensitiveIds.add(id);
          for (const child of children.get(id) ?? []) pending.push(child);
        }
        const visible = tree.nodes.filter(node => !node.ignored);
        const nodes: { ref?: string; role: string; name: string }[] = [];
        let bytes = 0, next = args.offset;
        for (const node of visible.slice(args.offset, args.offset + args.limit)) {
          const role = typeof node.role?.value === 'string' ? boundedText(node.role.value, 128) : '';
          const sensitive = sensitiveIds.has(node.nodeId);
          const ref = node.backendDOMNodeId ? `${tab.document}:${node.backendDOMNodeId}` : undefined;
          const labelSource = sensitiveRoots.has(node.nodeId) ? node.name?.sources?.find(source =>
            !source.superseded && !source.invalid && typeof source.value?.value === 'string'
            && ((source.type === 'attribute' && source.attribute === 'aria-label')
              || (source.type === 'relatedElement' && (source.attribute === 'aria-labelledby'
                || ['label', 'labelfor', 'labelwrapped'].includes(source.nativeSource ?? ''))))) : undefined;
          const safeLabel = typeof labelSource?.value?.value === 'string' ? boundedText(labelSource.value.value, 512) : undefined;
          const item = { ref, role, name: sensitive ? safeLabel ?? '[form field]' : boundedText(typeof node.name?.value === 'string' ? node.name.value : '', 512) };
          const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > 24_000) break;
          bytes += size; next++; nodes.push(item); if (ref && node.backendDOMNodeId) tab.refs.set(ref, node.backendDOMNodeId);
        }
        while (tab.refs.size > 1000) tab.refs.delete(tab.refs.keys().next().value!);
        result = { groupId: grant.groupId, targetId: tab.targetId, nodes, nextOffset: next < visible.length ? next : null, total: visible.length };
      } else if (args.action === 'act') {
        const backendNodeId = tab.refs.get(args.ref);
        if (!backendNodeId) throw new Error('Element reference stale; observe again');
        const node = z.object({ node: z.object({ backendNodeId: z.number(), nodeName: z.string() }) }).parse(await send('DOM.describeNode', { backendNodeId }));
        if (node.node.backendNodeId !== backendNodeId) throw new Error('Element reference target changed');
        let connected: boolean;
        if (tab.grant.source === 'relay') connected = z.object({ connected: z.boolean() }).parse(await send('GitSpace.validateRef', { backendNodeId })).connected;
        else {
          const object = z.object({ object: z.object({ objectId: z.string() }) }).parse(await send('DOM.resolveNode', { backendNodeId }));
          try { connected = Evaluation.parse(await send('Runtime.callFunctionOn', { objectId: object.object.objectId, functionDeclaration: 'function(){return this.isConnected && this.ownerDocument === document}', returnByValue: true })).result.value === true; }
          finally { await send('Runtime.releaseObject', { objectId: object.object.objectId }); }
        }
        if (!connected || tab.refs.get(args.ref) !== backendNodeId) throw new Error('Element reference detached or document changed');
        if (args.operation === 'click') {
          await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          const quad = Box.parse(await send('DOM.getBoxModel', { backendNodeId })).model.content;
          const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
          if (tab.refs.get(args.ref) !== backendNodeId) throw new Error('Element document changed');
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else {
          await send('DOM.focus', { backendNodeId });
          if (args.operation === 'fill') {
            if (args.value === undefined) throw new Error('Fill requires value');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: options.selectAllModifier, commands: ['selectAll'] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }); await send('Input.insertText', { text: args.value });
          } else {
            const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32 };
            if (!args.value || !keys[args.value]) throw new Error('Unsupported key');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: args.value, windowsVirtualKeyCode: keys[args.value] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: args.value, windowsVirtualKeyCode: keys[args.value] });
          }
        }
      }
      if (args.action === 'screenshot' || (args.action === 'observe' && args.screenshot)) {
        const refs = [...tab.refs].slice(0, 100).map(([ref, backendNodeId]) => ({ ref, backendNodeId }));
        let viewport: { width: number; height: number }, contextId: number | undefined;
        if (tab.grant.source === 'relay') viewport = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(await send('GitSpace.screenshotPrepare', { refs }));
        else {
          contextId = z.object({ executionContextId: z.number() }).parse(await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'gitspace-browser-mask' })).executionContextId;
          const boxes: { ref: string; x: number; y: number }[] = [];
          for (const ref of refs) { try { const quad = Box.parse(await send('DOM.getBoxModel', { backendNodeId: ref.backendNodeId })).model.content; boxes.push({ ref: ref.ref, x: quad[0]!, y: quad[1]! }); } catch {} }
          viewport = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(Evaluation.parse(await send('Runtime.callFunctionOn', { executionContextId: contextId, functionDeclaration: browserScreenshotPrepareFunction, arguments: [{ value: boxes }], returnByValue: true })).result.value);
        }
        try {
          let data = '';
          const initialScale = Math.min(1, 1280 / viewport.width, 1280 / viewport.height);
          for (const scale of [initialScale, initialScale / 2, initialScale / 4]) {
            data = z.object({ data: z.string().max(8_000_000) }).parse(await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } })).data;
            if (Buffer.byteLength(data, 'base64') <= BROWSER_IMAGE_BYTES) break;
          }
          if (Buffer.byteLength(data, 'base64') > BROWSER_IMAGE_BYTES) throw new Error('Browser screenshot exceeds image limit');
          content.push({ type: 'image', data, mimeType: 'image/jpeg' });
        } finally {
          if (tab.grant.source === 'relay') await send('GitSpace.screenshotRestore');
          else await send('Runtime.callFunctionOn', { executionContextId: contextId, functionDeclaration: browserScreenshotRestoreFunction, returnByValue: true });
        }
      }
      signal.throwIfAborted();
      const text = JSON.stringify(result);
      return [{ type: 'text', text: Buffer.byteLength(text) <= BROWSER_TEXT_BYTES ? text : JSON.stringify({ artifact: options.artifact(text) }) }, ...content];

}
