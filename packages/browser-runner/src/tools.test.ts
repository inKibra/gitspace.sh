import { expect, test } from 'bun:test';
import { scriptTools, type ScriptCdpSession, type ScriptDownload, type ScriptFiles, type ScriptInputTarget, type ScriptLocator, type ScriptShot, type ScriptUploadFiles } from './tools.js';

type FakePage = {
  session: ScriptCdpSession; sent: string[]; calls: { method: string; params: Record<string, unknown> }[];
  locator(selector: string): ScriptLocator; located: { selector: string; files: unknown }[];
  emit(event: string, value: unknown): boolean; events: { event: string; value: unknown }[];
  /** The page's file-input marks now, by DOM node id. */
  marks: Map<number, string>;
};

/** Elements whose attribute value is "file", as Chrome's DOM search finds them: a file input, a button whose type
 * says "file" (no input), and a file input whose type is written in capitals. */
const CANDIDATES: Record<number, { nodeName: string; backendNodeId: number; attributes: string[] }> = {
  21: { nodeName: 'INPUT', backendNodeId: 41, attributes: ['type', 'file', 'name', 'Filedata'] },
  22: { nodeName: 'BUTTON', backendNodeId: 42, attributes: ['type', 'file'] },
  23: { nodeName: 'INPUT', backendNodeId: 43, attributes: ['TYPE', 'FILE'] },
};

/** A page as CDP shows it: its current load, and whether its one element (node 7) is enabled yet. Its viewport is
 * 2000×1000 CSS pixels at two device pixels each. */
function page(loaderId: string, enabledAfterChecks = 0): FakePage {
  const sent: string[] = [], calls: FakePage['calls'] = [], located: FakePage['located'] = [], events: FakePage['events'] = [], marks = new Map<number, string>();
  let checks = 0;
  const session: ScriptCdpSession = {
    async send(method, params = {}) {
      sent.push(method === 'Input.dispatchMouseEvent' ? `${method}:${String(params.type)}` : method);
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId } } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { connected: true, visible: true, enabled: ++checks > enabledAfterChecks } } };
      if (method === 'Runtime.evaluate') return { result: { value: 'Linux x86_64' } };
      if (method === 'DOM.performSearch') return { searchId: 'search', resultCount: params.query === '"file"' ? 3 : 0 };
      if (method === 'DOM.getSearchResults') return { nodeIds: [21, 22, 23] };
      if (method === 'DOM.describeNode') return { node: CANDIDATES[Number(params.nodeId)] };
      if (method === 'DOM.setAttributeValue') marks.set(Number(params.nodeId), String(params.value));
      if (method === 'DOM.removeAttribute') marks.delete(Number(params.nodeId));
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `tab-${loaderId.slice(0, 4)}`, type: 'page', url: 'https://example.com/report', title: 'Report' } };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 250, clientWidth: 2000, clientHeight: 1000 }, visualViewport: { clientWidth: 4000 } };
      if (method === 'Page.captureScreenshot') return { data: `jpeg@${String(Reflect.get(Object(params.clip), 'scale'))}` };
      return {};
    },
  };
  return {
    session, sent, calls, located, events, marks,
    locator: selector => ({ setInputFiles: async files => { located.push({ selector, files }); } }),
    emit: (event, value) => { events.push({ event, value }); return true; },
  };
}

/** The session's side of a script's files: what it was asked, the files it gives an upload, and the run's downloads
 * as it answers them (`publish`). */
function host(upload: ScriptUploadFiles) {
  const shots: ScriptShot[] = [], uploads: string[][] = [], saved: [string, string][] = [];
  type Downloads = { version: number; ended: boolean; downloads: ScriptDownload[] };
  let answer = Promise.withResolvers<{ ok: true; value: Downloads }>();
  const files: ScriptFiles = {
    async capture(shot) { shots.push(shot); return { ok: true, value: { captureId: 'capture', url: 'drive://workspace/browser/captures/capture/image.jpg' } }; },
    async uploadFiles(urls) { uploads.push(urls); return urls.some(url => !url.startsWith('drive://workspace/')) ? { ok: false, error: `${urls[0]} is not a file of this workspace's drive` } : { ok: true, value: upload }; },
    downloads: () => answer.promise,
    async saveDownload(id, url) { saved.push([id, url]); return { ok: true, value: { file: url } }; },
  };
  /** The session answers the waiting `downloads` call; the next one waits again. */
  const publish = async (value: Downloads) => { const current = answer; answer = Promise.withResolvers(); current.resolve({ ok: true, value }); await settle(); };
  return { files, shots, uploads, saved, publish };
}
/** Lets the tools' pending work finish. */
async function settle() { for (let turn = 0; turn < 10; turn++) { const loop = Promise.withResolvers<void>(); setImmediate(loop.resolve); await loop.promise; } }
const none = host({ kind: 'bytes', files: [] }).files;
const tools = (pages: FakePage[], files: ScriptFiles = none) => scriptTools<FakePage>({ pages: () => pages, newCDPSession: async current => current.session }, files);
/** A file input as Playwright finds it on `current`: node `nodeId` of its DOM; the bytes Playwright would set go to `set`. */
function input(current: FakePage, nodeId: number, set: (files: unknown) => void = () => { throw new Error('Playwright sets no bytes here'); }): ScriptInputTarget<FakePage> {
  return { description: '#file', page: async () => current, attribute: async name => name === 'data-gitspace-upload' ? current.marks.get(nodeId) ?? null : null, set: async files => { set(files); } };
}
/** A download as a page heard it (Playwright's `download` event). */
type HeardDownload = { page(): unknown; url(): string; suggestedFilename(): string; path(): Promise<string>; failure(): Promise<string | null>; saveAs(url: string): Promise<void> };
function heard(value: unknown): value is HeardDownload { return typeof value === 'object' && value !== null && 'path' in value && 'saveAs' in value && 'failure' in value; }
const downloadsOf = (current: FakePage) => current.events.filter(entry => entry.event === 'download').map(entry => entry.value).filter(heard);

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

test('a file call on the cloud browser gives Playwright the drive files’ bytes; upload() takes a locator or a marked ref', async () => {
  const bytes = new TextEncoder().encode('quarterly numbers');
  const { files, uploads } = host({ kind: 'bytes', files: [{ name: 'report.csv', mediaType: 'text/csv', bytes }] });
  const current = page('B0C0FFEE22222222');
  const { setInputFiles, upload } = tools([current], files);
  const set: unknown[] = [];
  await setInputFiles(input(current, 21, files => { set.push(files); }), ['drive://workspace/report.csv']);
  expect(uploads).toEqual([['drive://workspace/report.csv']]);
  expect(set).toEqual([[{ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from(bytes) }]]);
  // upload() hands a locator its own file call; a ref's node is marked for a locator, then unmarked.
  await upload(current.locator('#file'), 'drive://workspace/report.csv');
  await upload('b0c0ffee:7', ['drive://workspace/report.csv']);
  const [byLocator, byRef] = current.located;
  expect(byLocator).toEqual({ selector: '#file', files: 'drive://workspace/report.csv' });
  expect(byRef).toEqual({ selector: expect.stringMatching(/^\[data-gitspace-upload="[0-9a-f-]{36}"\]$/u), files: [{ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from(bytes) }] });
  const marks = current.calls.filter(call => call.method === 'Runtime.callFunctionOn').map(call => String(call.params.functionDeclaration));
  expect(marks.map(mark => mark.includes('setAttribute') ? 'mark' : mark.includes('removeAttribute') ? 'unmark' : mark)).toEqual(['mark', 'unmark']);
  expect(current.sent).not.toContain('GitSpace.setInputFilesFromUrls');
  // A file the session refuses fails the script's call, and no input changes.
  await expect(setInputFiles(input(current, 21, files => { set.push(files); }), 'drive://base/report.csv')).rejects.toThrow("drive://base/report.csv is not a file of this workspace's drive");
  expect(set).toHaveLength(1);
});

test('a file call on your Chrome finds its input through Chrome’s DOM and Playwright’s isolated world, and sends the extension sealed links', async () => {
  const links = [{ url: 'https://test.gitspace.sh/files/sealed', name: 'report.csv', mediaType: 'text/csv', size: 17 }];
  const { files } = host({ kind: 'links', files: links });
  const current = page('B0C0FFEE22222222');
  const { setInputFiles, upload } = tools([current], files);
  const marked: number[][] = [];
  const watching: ScriptInputTarget<FakePage> = { ...input(current, 23), attribute: async name => { marked.push([...current.marks.keys()]); return name === 'data-gitspace-upload' ? current.marks.get(23) ?? null : null; } };
  await setInputFiles(watching, 'drive://workspace/report.csv');
  await upload('b0c0ffee:7', 'drive://workspace/report.csv');
  expect(current.calls.filter(call => call.method === 'GitSpace.setInputFilesFromUrls').map(call => call.params)).toEqual([{ backendNodeId: 43, files: links }, { backendNodeId: 7, files: links }]);
  // Only the file inputs were marked, while Playwright read the mark, and the page's own world was never used.
  expect(marked).toEqual([[21, 23]]);
  expect(current.marks.size).toBe(0);
  expect(current.sent.filter(method => method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn')).toEqual([]);
  // An element that is not a file input is refused, and nothing is left marked.
  await expect(setInputFiles(input(current, 22), 'drive://workspace/report.csv')).rejects.toThrow('#file is not a file input');
  expect(current.marks.size).toBe(0);
  expect(current.calls.filter(call => call.method === 'GitSpace.setInputFilesFromUrls')).toHaveLength(2);
});

test('a file call takes files from memory with a Uint8Array buffer, refuses a machine path, a mix and too many bytes, and clears with an empty list', async () => {
  const current = page('B0C0FFEE22222222');
  const { setInputFiles } = tools([current]);
  const set: unknown[] = [];
  const target = input(current, 21, files => { set.push(files); });
  const gamma = new TextEncoder().encode('gamma');
  await setInputFiles(target, { name: 'gamma.txt', mimeType: 'text/plain', buffer: gamma });
  await setInputFiles(target, [{ name: 'raw.bin', buffer: Uint8Array.of(1, 2, 3) }]);
  await setInputFiles(target, []);
  expect(set).toEqual([[{ name: 'gamma.txt', mimeType: 'text/plain', buffer: Buffer.from('gamma') }], [{ name: 'raw.bin', mimeType: 'application/octet-stream', buffer: Buffer.of(1, 2, 3) }], []]);
  await expect(setInputFiles(target, '/home/you/report.pdf')).rejects.toThrow("/home/you/report.pdf: this browser can't read your machine's disk; copy the file to the drive with space_artifacts fromMachine, then pass drive://workspace/<path>");
  await expect(setInputFiles(target, ['drive://workspace/a.txt', { name: 'b.txt', mimeType: 'text/plain', buffer: gamma }])).rejects.toThrow('not both');
  await expect(setInputFiles(target, { name: 'c.txt', mimeType: 'text/plain', buffer: 'gamma' })).rejects.toThrow('buffer a Uint8Array');
  await expect(setInputFiles(target, { name: 'big.bin', mimeType: 'application/octet-stream', buffer: new Uint8Array(2 * 1024 * 1024 + 1) })).rejects.toThrow('at most 8 files and 2 MiB from memory at once');
  await expect(setInputFiles(target, Array.from({ length: 9 }, (_, index) => ({ name: `${index}.txt`, mimeType: 'text/plain', buffer: gamma })))).rejects.toThrow('at most 8 files');
  expect(set).toHaveLength(3);
});

test('a download reaches Playwright’s download event on the page that started it: path() is its drive address once saved, saveAs copies it in the drive', async () => {
  const first = page('AAAAAAAA11111111'), second = page('B0C0FFEE22222222');
  const { files, saved, publish } = host({ kind: 'bytes', files: [] });
  tools([first, second], files).followDownloads();
  const report: ScriptDownload = { id: 'download-1', targetId: 'tab-AAAA', url: 'https://example.com/report.csv', name: 'report.csv', outcome: null };
  await publish({ version: 1, ended: false, downloads: [report] });
  const [download] = downloadsOf(first);
  if (!download) throw new Error('The page heard no download');
  expect([download.page(), download.url(), download.suggestedFilename()]).toEqual([first, 'https://example.com/report.csv', 'report.csv']);
  expect(downloadsOf(second)).toEqual([]);
  const path = download.path();
  await publish({ version: 2, ended: false, downloads: [{ ...report, outcome: { file: 'drive://workspace/browser/downloads/2026-10-28/report.csv', size: 14, mediaType: 'text/csv' } }] });
  expect(await path).toBe('drive://workspace/browser/downloads/2026-10-28/report.csv');
  expect(await download.failure()).toBeNull();
  await download.saveAs('drive://workspace/saved/report.csv');
  await expect(download.saveAs('/home/you/report.csv')).rejects.toThrow("this browser can't write to your machine's disk");
  expect(saved).toEqual([['download-1', 'drive://workspace/saved/report.csv']]);
  // Heard once, however often the session lists it.
  expect(downloadsOf(first)).toHaveLength(1);
});

test('a download of an unnamed tab goes to the latest page, one of a tab not open here to none, and one unsaved when the run ends fails', async () => {
  const first = page('AAAAAAAA11111111'), latest = page('B0C0FFEE22222222');
  const { files, publish } = host({ kind: 'bytes', files: [] });
  tools([first, latest], files).followDownloads();
  await publish({ version: 2, ended: false, downloads: [
    { id: 'unnamed', targetId: null, url: '', name: 'export.json', outcome: null },
    { id: 'elsewhere', targetId: 'tab-FFFF', url: 'https://example.com/other.zip', name: 'other.zip', outcome: null },
  ] });
  expect(downloadsOf(first)).toEqual([]);
  const [download] = downloadsOf(latest);
  if (!download) throw new Error('The latest page heard no download');
  expect(downloadsOf(latest)).toHaveLength(1);
  await publish({ version: 2, ended: true, downloads: [] });
  await expect(download.path()).rejects.toThrow('The download was not saved: The script ended before the download was saved');
  expect(await download.failure()).toBe('The script ended before the download was saved');
});
