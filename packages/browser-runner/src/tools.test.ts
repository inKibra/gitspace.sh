import { expect, test } from 'bun:test';
import { scriptTools, type ScriptCdpSession } from './tools.js';

/** A page as CDP shows it: its current load, and whether its one element (node 7) is enabled yet. */
function page(loaderId: string, enabledAfterChecks = 0) {
  const sent: string[] = [];
  let checks = 0;
  const session: ScriptCdpSession = {
    async send(method, params = {}) {
      sent.push(method === 'Input.dispatchMouseEvent' ? `${method}:${String(params.type)}` : method);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId } } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { connected: true, visible: true, enabled: ++checks > enabledAfterChecks } } };
      if (method === 'Runtime.evaluate') return { result: { value: 'Linux x86_64' } };
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    },
  };
  return { session, sent };
}

test('act clicks the element on the page whose current load the ref names, once it is enabled', async () => {
  const other = page('AAAAAAAA11111111'), target = page('B0C0FFEE22222222', 2);
  const { act } = scriptTools({ pages: () => [other, target], newCDPSession: async current => current.session });
  await act('b0c0ffee:7', 'click');
  expect(target.sent.filter(method => method.startsWith('Input.'))).toEqual(['Input.dispatchMouseEvent:mousePressed', 'Input.dispatchMouseEvent:mouseReleased']);
  expect(target.sent.filter(method => method === 'Runtime.callFunctionOn')).toHaveLength(3);
  expect(other.sent.some(method => method.startsWith('Input.') || method === 'DOM.resolveNode')).toBe(false);
});

test('a ref from a document no open page has any more fails as stale, and nothing is clicked', async () => {
  const navigated = page('CCCCCCCC33333333');
  const { act } = scriptTools({ pages: () => [navigated], newCDPSession: async current => current.session });
  await expect(act('b0c0ffee:7', 'click')).rejects.toThrow('stale');
  await expect(act('3:7', 'click')).rejects.toThrow('not a ref from view()');
  expect(navigated.sent.filter(method => method !== 'Page.getFrameTree')).toEqual([]);
});
