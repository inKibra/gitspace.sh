import { expect, test } from 'bun:test';
import { scriptTools, type ScriptCdpSession, type ScriptFiles, type ScriptLocator, type ScriptShot, type ScriptUploadFiles } from './tools.js';

type FakePage = { session: ScriptCdpSession; sent: string[]; calls: { method: string; params: Record<string, unknown> }[]; locator(selector: string): ScriptLocator<FakePage>; located: { selector: string; files: { name: string; mimeType: string; buffer: Uint8Array }[] }[] };

/** A page as CDP shows it: its current load, and whether its one element (node 7) is enabled yet. Its viewport is
 * 2000×1000 CSS pixels at two device pixels each. */
function page(loaderId: string, enabledAfterChecks = 0): FakePage {
  const sent: string[] = [], calls: FakePage['calls'] = [], located: FakePage['located'] = [];
  let checks = 0;
  const session: ScriptCdpSession = {
    async send(method, params = {}) {
      sent.push(method === 'Input.dispatchMouseEvent' ? `${method}:${String(params.type)}` : method);
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId } } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { connected: true, visible: true, enabled: ++checks > enabledAfterChecks } } };
      if (method === 'Runtime.evaluate') return String(params.expression).startsWith('globalThis[Symbol.for(') ? { result: { type: 'object', objectId: 'held' } } : { result: { value: 'Linux x86_64' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: params.objectId === 'held' ? 41 : 0 } };
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `tab-${loaderId.slice(0, 4)}`, type: 'page', url: 'https://example.com/report', title: 'Report' } };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 250, clientWidth: 2000, clientHeight: 1000 }, visualViewport: { clientWidth: 4000 } };
      if (method === 'Page.captureScreenshot') return { data: `jpeg@${String(Reflect.get(Object(params.clip), 'scale'))}` };
      return {};
    },
  };
  const fake: FakePage = {
    session, sent, calls, located,
    locator: selector => ({
      page: () => fake,
      setInputFiles: async files => { located.push({ selector, files }); },
      // Runs as in the page's top document, whose window is its own top.
      evaluate: async (action, argument) => {
        Reflect.set(globalThis, 'top', globalThis);
        try { return action({ tagName: 'INPUT' }, argument); } finally { Reflect.deleteProperty(globalThis, 'top'); }
      },
    }),
  };
  return fake;
}

/** The session's side of a script's files: what it was asked, and the files it gives an upload. */
function host(upload: ScriptUploadFiles) {
  const shots: ScriptShot[] = [], uploads: string[][] = [];
  const files: ScriptFiles = {
    async capture(shot) { shots.push(shot); return { ok: true, value: { captureId: 'capture', url: 'drive://workspace/browser/captures/capture/image.jpg' } }; },
    async uploadFiles(urls) { uploads.push(urls); return urls.some(url => !url.startsWith('drive://workspace/')) ? { ok: false, error: `${urls[0]} is not a file of this workspace's drive` } : { ok: true, value: upload }; },
  };
  return { files, shots, uploads };
}
const none = host({ kind: 'bytes', files: [] }).files;
const tools = (pages: FakePage[], files: ScriptFiles = none) => scriptTools<FakePage>({ pages: () => pages, newCDPSession: async current => current.session }, files);

test('act clicks the element on the page whose current load the ref names, once it is enabled', async () => {
  const other = page('AAAAAAAA11111111'), target = page('B0C0FFEE22222222', 2);
  const { act } = tools([other, target]);
  await act('b0c0ffee:7', 'click');
  expect(target.sent.filter(method => method.startsWith('Input.'))).toEqual(['Input.dispatchMouseEvent:mousePressed', 'Input.dispatchMouseEvent:mouseReleased']);
  expect(target.sent.filter(method => method === 'Runtime.callFunctionOn')).toHaveLength(3);
  expect(other.sent.some(method => method.startsWith('Input.') || method === 'DOM.resolveNode')).toBe(false);
});

test('a ref from a document no open page has any more fails as stale, and nothing is clicked', async () => {
  const navigated = page('CCCCCCCC33333333');
  const { act } = tools([navigated]);
  await expect(act('b0c0ffee:7', 'click')).rejects.toThrow('stale');
  await expect(act('3:7', 'click')).rejects.toThrow('not a ref from view()');
  expect(navigated.sent.filter(method => method !== 'Page.getFrameTree')).toEqual([]);
});

test('capture hands the session a screenshot of the latest page at most 1600 device pixels a side, a thumbnail at most 480 wide, and the tab it shows', async () => {
  const older = page('AAAAAAAA11111111'), latest = page('B0C0FFEE22222222');
  const { files, shots } = host({ kind: 'bytes', files: [] });
  expect(await tools([older, latest], files).capture(undefined, { name: 'Checkout' })).toEqual({ captureId: 'capture', url: 'drive://workspace/browser/captures/capture/image.jpg' });
  // 2000 CSS pixels at two device pixels each: 1600 / 4000 for the image, 480 / 4000 for the thumbnail.
  expect(latest.calls.filter(call => call.method === 'Page.captureScreenshot').map(call => call.params)).toEqual([
    { format: 'jpeg', quality: 80, captureBeyondViewport: false, clip: { x: 0, y: 250, width: 2000, height: 1000, scale: 0.4 } },
    { format: 'jpeg', quality: 60, captureBeyondViewport: false, clip: { x: 0, y: 250, width: 2000, height: 1000, scale: 0.12 } },
  ]);
  expect(shots).toEqual([{ name: 'Checkout', targetId: 'tab-B0C0', page: { url: 'https://example.com/report', title: 'Report' }, image: 'jpeg@0.4', thumbnail: 'jpeg@0.12' }]);
  expect(older.calls).toEqual([]);
});

test('upload on the cloud browser gives Playwright the drive files’ bytes, through the locator or a marked ref', async () => {
  const bytes = new TextEncoder().encode('quarterly numbers');
  const { files, uploads } = host({ kind: 'bytes', files: [{ name: 'report.csv', mediaType: 'text/csv', bytes }] });
  const current = page('B0C0FFEE22222222');
  const { upload } = tools([current], files);
  await upload(current.locator('#file'), 'drive://workspace/report.csv');
  await upload('b0c0ffee:7', ['drive://workspace/report.csv']);
  expect(uploads).toEqual([['drive://workspace/report.csv'], ['drive://workspace/report.csv']]);
  const [byLocator, byRef] = current.located;
  expect(byLocator?.selector).toBe('#file');
  expect(byRef?.selector).toMatch(/^\[data-gitspace-upload="[0-9a-f-]{36}"\]$/u);
  for (const set of [byLocator, byRef]) expect(set?.files.map(file => ({ ...file, buffer: [...file.buffer] }))).toEqual([{ name: 'report.csv', mimeType: 'text/csv', buffer: [...bytes] }]);
  // The ref's node is marked for the locator, then unmarked.
  const marks = current.calls.filter(call => call.method === 'Runtime.callFunctionOn').map(call => String(call.params.functionDeclaration));
  expect(marks.map(mark => mark.includes('setAttribute') ? 'mark' : mark.includes('removeAttribute') ? 'unmark' : mark)).toEqual(['mark', 'unmark']);
  expect(current.sent).not.toContain('GitSpace.setInputFilesFromUrls');
  // A file the session refuses fails the script's call, and no input changes.
  await expect(upload(current.locator('#file'), 'drive://base/report.csv')).rejects.toThrow("drive://base/report.csv is not a file of this workspace's drive");
  expect(current.located).toHaveLength(2);
});

test('upload on your Chrome sends the extension sealed links to the files and the input’s node, for a ref or a locator', async () => {
  const links = [{ url: 'https://test.gitspace.sh/files/sealed', name: 'report.csv', mediaType: 'text/csv', size: 17 }];
  const { files } = host({ kind: 'links', files: links });
  const current = page('B0C0FFEE22222222');
  const { upload } = tools([current], files);
  await upload('b0c0ffee:7', 'drive://workspace/report.csv');
  await upload(current.locator('#file'), 'drive://workspace/report.csv');
  expect(current.calls.filter(call => call.method === 'GitSpace.setInputFilesFromUrls').map(call => call.params)).toEqual([{ backendNodeId: 7, files: links }, { backendNodeId: 41, files: links }]);
  // The locator's element was held on the page only while its node was found.
  expect(current.calls.filter(call => call.method === 'Runtime.evaluate').map(call => String(call.params.expression).startsWith('delete ') ? 'released' : 'found')).toEqual(['found', 'released']);
  expect(current.located).toEqual([]);
});
