import { afterEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { downloadBlobReadFunction } from '../src/page-files.js';
import { command, FRAME, installed, settle, type DebuggerCommand } from './installed.js';

const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

/** The screencast commands the extension sent to a tab, in order. */
const screencasts = (commands: DebuggerCommand[], targetId: string) => commands.filter(entry => entry.targetId === targetId && ['Page.startScreencast', 'Page.stopScreencast'].includes(entry.method)).map(({ method, params }) => method === 'Page.startScreencast' ? params : 'stop');

describe('one screencast per tab', () => {
  it('runs at the largest size its consumers need, acknowledges frames for the capture, keeps them from the script, and stops when the last consumer leaves', async () => {
    const chrome = await installed({ protocol: 4 });
    const groupId = chrome.grant.body.groupId;
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    // The Browser tab records the tab the script drives: the 1×1 painting screencast restarts at the capture's size.
    const captureId = crypto.randomUUID();
    await chrome.authorize({ type: 'manage', action: 'captureStart', groupId, targetId: 'target-1', captureId }, 'browser_control');
    const started = chrome.execute({ operation: 'captureStart', groupId, targetId: 'target-1', captureId });
    await settle();
    chrome.sent.length = 0;
    await chrome.pageEvent('target-1', 'Page.screencastFrame', { data: FRAME, sessionId: 7, metadata: { deviceWidth: 1200, deviceHeight: 800 } });
    expect(await started).toEqual({ captureId, width: 32, height: 16, url: 'https://app.example/', title: 'Page' });
    expect(screencasts(chrome.commands, 'target-1')).toEqual([{ format: 'jpeg', quality: 1, maxWidth: 1, maxHeight: 1 }, 'stop', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280 }]);
    expect(chrome.commands).toContainEqual({ targetId: 'target-1', method: 'Page.screencastFrameAck', params: { sessionId: 7 } });
    expect(chrome.sent.filter(message => message.method === 'Page.screencastFrame')).toEqual([]);

    // The script ends; the capture keeps the tab's debugger and its screencast.
    await chrome.execute({ operation: 'release', attemptId });
    expect(chrome.detached).toEqual([]);
    expect(screencasts(chrome.commands, 'target-1')).toHaveLength(3);

    await chrome.authorize({ type: 'manage', action: 'captureStop', captureId }, 'browser_control');
    expect(await chrome.execute({ operation: 'captureStop', captureId })).toEqual({ count: 1, width: 32, height: 16, durationMs: expect.any(Number) });
    expect(screencasts(chrome.commands, 'target-1').at(-1)).toBe('stop');
    expect(chrome.detached).toEqual(['target-1']);
    const frames = Buffer.from(FRAME, 'base64');
    expect(chrome.uploaded(begin => begin.captureId === captureId).map(({ begin, bytes }) => [begin.file, begin.groupId, bytes.byteLength])).toEqual([['frames.bin', groupId, frames.byteLength], ['frames.json', groupId, expect.any(Number)], ['thumbnail.jpg', groupId, frames.byteLength]]);
    const index = chrome.uploaded(begin => begin.file === 'frames.json')[0]?.bytes.toString();
    expect(JSON.parse(index ?? '')).toEqual({ version: 1, frames: [{ t: expect.any(Number), offset: 0, length: frames.byteLength }] });
    for (const request of chrome.requests) expect(await chrome.signedByThisChrome(request)).toBe(true);
  });

  it('records the Browser tab’s capture only on a tab the agent uses, once per signed request', async () => {
    const chrome = await installed({ protocol: 4 });
    const groupId = chrome.grant.body.groupId;
    const captureId = crypto.randomUUID();
    await chrome.authorize({ type: 'manage', action: 'captureStart', groupId, targetId: 'target-2', captureId }, 'browser_control');
    await expect(chrome.execute({ operation: 'captureStart', groupId, targetId: 'target-2', captureId })).rejects.toThrow('records a tab while the agent uses it');
    expect(chrome.attached).toEqual([]);
    await expect(chrome.execute({ operation: 'captureStart', groupId, targetId: 'target-2', captureId })).rejects.toThrow('Signed capture start required');
  });
});

describe('a download an agent tab starts', () => {
  it('goes to the workspace’s drive, not your Downloads folder, before the script’s release is answered', async () => {
    const chrome = await installed({ protocol: 4 });
    const groupId = chrome.grant.body.groupId;
    // One of yours, in no agent tab, stays Chrome's.
    await chrome.download({ id: 4, url: 'https://elsewhere.example/yours.zip', finalUrl: 'https://elsewhere.example/yours.zip', mime: 'application/zip', filename: '', state: 'in_progress' });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    chrome.answer(({ method }) => method === 'Network.loadNetworkResource' ? { resource: { success: true, httpStatusCode: 200, stream: 'io-1', headers: { 'Content-Type': 'text/csv; charset=utf-8' } } }
      : method === 'IO.read' ? { base64Encoded: true, data: btoa('a,b\n1,2\n'), eof: true } : undefined);
    const complete = chrome.hold(request => request.pathname.endsWith('/complete'));
    await chrome.pageEvent('target-1', 'Page.downloadWillBegin', { frameId: 'main', guid: 'g-1', url: 'https://app.example/report.csv', suggestedFilename: 'report.csv' });
    await chrome.download({ id: 5, url: 'https://app.example/report.csv', finalUrl: 'https://app.example/report.csv', mime: 'text/csv', filename: '', state: 'in_progress' });
    expect(chrome.downloadCalls).toEqual(['cancel:5', 'erase:5']);
    // Loaded again through the tab, with the page's credentials.
    expect(chrome.commands.find(entry => entry.method === 'Network.loadNetworkResource')).toEqual({ targetId: 'target-1', method: 'Network.loadNetworkResource', params: { frameId: 'main', url: 'https://app.example/report.csv', options: { disableCache: false, includeCredentials: true } } });

    let released = false;
    const release = chrome.execute({ operation: 'release', attemptId }).then(() => { released = true; });
    await settle();
    expect(released).toBe(false);
    complete();
    await release;
    expect(chrome.uploaded(begin => begin.kind === 'download')).toEqual([{ begin: { kind: 'download', groupId, attemptId, name: 'report.csv', mediaType: 'text/csv' }, bytes: Buffer.from('a,b\n1,2\n') }]);
    for (const request of chrome.requests) expect(await chrome.signedByThisChrome(request)).toBe(true);
    await chrome.advance(10_000);
    expect(chrome.downloadCalls).toEqual(['cancel:5', 'erase:5']);
  });

  it('is taken out of your Downloads folder when Chrome reported it first and already saved it there', async () => {
    const chrome = await installed({ protocol: 4 });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    chrome.answer(({ method, params }) => method === 'Runtime.callFunctionOn' && params.functionDeclaration === downloadBlobReadFunction ? { result: { value: { total: 2, type: 'application/json', data: btoa('{}') } } } : undefined);
    await chrome.download({ id: 6, url: 'blob:https://app.example/1234', finalUrl: 'blob:https://app.example/1234', mime: '', filename: '/home/you/Downloads/export.json', state: 'complete' });
    await chrome.pageEvent('target-1', 'Page.downloadWillBegin', { frameId: 'main', guid: 'g-2', url: 'blob:https://app.example/1234', suggestedFilename: 'export.json' });
    await chrome.execute({ operation: 'release', attemptId });
    expect(chrome.downloadCalls).toEqual(['cancel:6', 'removeFile:6', 'erase:6']);
    expect(chrome.uploaded(begin => begin.kind === 'download').map(({ begin, bytes }) => [begin.name, begin.mediaType, bytes.toString()])).toEqual([['export.json', 'application/json', '{}']]);
  });
});

describe('a drive file into a page’s file input', () => {
  /** A page with a file input the debugger resolves as node 12; the extension's isolated-world calls run on it. */
  function page(answer: (respond: (command: DebuggerCommand) => unknown) => void, multiple: boolean) {
    const window = new Window();
    windows.push(window);
    const input = window.document.createElement('input');
    input.type = 'file'; input.multiple = multiple;
    window.document.body.appendChild(input);
    const events: string[] = [];
    window.document.addEventListener('input', event => { events.push(`input:${event.composed}`); });
    window.document.addEventListener('change', event => { events.push(`change:${event.composed}`); });
    answer(({ method, params }) => {
      if (method === 'DOM.resolveNode' && params.backendNodeId === 12) return { object: { objectId: 'input-12' } };
      if (method !== 'Runtime.callFunctionOn' || params.objectId !== 'input-12' || typeof params.functionDeclaration !== 'string' || !Array.isArray(params.arguments)) return undefined;
      return { result: { value: window.eval(`(${params.functionDeclaration})`).apply(input, params.arguments.map((argument: { value: unknown }) => argument.value)) } };
    });
    return { input, events };
  }

  it('fetches each sealed link itself, sets the input’s files and fires input and change', async () => {
    const chrome = await installed({ protocol: 4 });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    const big = Uint8Array.from({ length: 3.5 * 1024 * 1024 }, (_, index) => index % 251);
    chrome.files.set('/files/token-a', new TextEncoder().encode('hello'));
    chrome.files.set('/files/token-b', big);
    const { input, events } = page(chrome.answer, true);
    await chrome.execute(command(attemptId, 'target-1', 'GitSpace.setInputFilesFromUrls', { backendNodeId: 12, files: [
      { url: 'https://account.gitspace.test/files/token-a', name: 'a.txt', mediaType: 'text/plain', size: 5 },
      { url: 'https://account.gitspace.test/files/token-b', name: 'b.bin', mediaType: 'application/octet-stream', size: big.byteLength },
    ] }));
    expect([...input.files].map(file => [file.name, file.type, file.size])).toEqual([['a.txt', 'text/plain', 5], ['b.bin', 'application/octet-stream', big.byteLength]]);
    expect(new Uint8Array(await input.files[1]?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(big);
    expect(events).toEqual(['input:true', 'change:false']);
    // The link never reaches the page or the relay.
    expect(JSON.stringify(chrome.commands)).not.toContain('/files/');
  });

  it('refuses two files for an input that takes one, and a file the drive holds at another size', async () => {
    const chrome = await installed({ protocol: 4 });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    chrome.files.set('/files/token-a', new TextEncoder().encode('hello'));
    const { input, events } = page(chrome.answer, false);
    const file = { url: 'https://account.gitspace.test/files/token-a', name: 'a.txt', mediaType: 'text/plain', size: 5 };
    await expect(chrome.execute(command(attemptId, 'target-1', 'GitSpace.setInputFilesFromUrls', { backendNodeId: 12, files: [file, file] }))).rejects.toThrow('This input takes one file');
    await expect(chrome.execute(command(attemptId, 'target-1', 'GitSpace.setInputFilesFromUrls', { backendNodeId: 12, files: [{ ...file, size: 6 }] }))).rejects.toThrow('a.txt is 5 bytes in the drive, not 6');
    expect(input.files.length).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('Capture', () => {
  it('in the popup records the tab with its sound through the offscreen document, and Stop saves it to the drive', async () => {
    const chrome = await installed({ protocol: 4 });
    const groupId = chrome.grant.body.groupId;
    // You opened the popup on tab 1: Chrome lets the extension capture it.
    chrome.captureGrants.add(1);
    expect((await chrome.popup({ popupState: true })).activeTab).toMatchObject({ tabId: 1, capture: { recording: null, unavailable: null } });
    const recording = await chrome.popup({ startCapture: 1 });
    expect(chrome.streamIds).toEqual([{ targetTabId: 1 }]);
    expect(chrome.offscreenCreated).toEqual([{ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: expect.any(String) }]);
    expect(chrome.recorders).toMatchObject([{ mimeType: 'video/webm;codecs=vp9,opus', state: 'recording', slice: 5000 }]);
    const start = chrome.sent.find(message => message.capture)?.capture;
    expect(start).toEqual({ event: 'start', captureId: expect.any(String), groupId, targetId: 'target-1', track: 'video', sound: true, page: { url: 'https://app.example/', title: 'Page' }, startedAt: expect.any(String) });
    const captureId = typeof start === 'object' && start !== null && 'captureId' in start ? start.captureId : '';
    expect(recording).toMatchObject({ activeTab: { capture: { recording: captureId } }, recordings: [{ captureId, track: 'video', saving: false }] });
    expect(chrome.toolbar.at(-1)).toMatchObject({ badge: 'REC', badgeColor: '#d93025', title: 'GitSpace is recording a tab in this Chrome' });

    const PART = 32 * 1024 * 1024;
    chrome.recorders[0]?.emit(Uint8Array.from([1, 2, 3]));
    await chrome.advance(1000);
    // Nothing goes out before a part fills or the recording ends.
    expect(chrome.requests).toEqual([]);
    // Each part but the last is exactly the drive's 32 MiB, sent as soon as it fills.
    chrome.recorders[0]?.emit(new Uint8Array(PART).fill(7));
    await chrome.waitFor(() => chrome.requests.length === 2);
    expect(chrome.requests.map(({ method, body }) => [method, body.byteLength])).toEqual([['POST', expect.any(Number)], ['PUT', PART]]);

    const stopped = await chrome.popup({ stopCapture: captureId });
    expect(stopped).toMatchObject({ recordings: [], activeTab: { capture: { recording: null } } });
    expect([...chrome.uploads.values()].map(({ begin, parts }) => [begin.file, parts.map(part => part.byteLength)])).toEqual([['video.webm', [PART, 5]], ['thumbnail.jpg', [4]]]);
    const [video, thumbnail] = chrome.uploaded(begin => begin.captureId === captureId);
    expect(video?.begin).toEqual({ kind: 'capture', groupId, captureId, file: 'video.webm', mediaType: 'video/webm' });
    expect([...video?.bytes.subarray(0, 4) ?? []]).toEqual([1, 2, 3, 7]);
    expect([...video?.bytes.subarray(-4) ?? []]).toEqual([7, 7, 9, 9]);
    expect(thumbnail).toEqual({ begin: { kind: 'capture', groupId, captureId, file: 'thumbnail.jpg', mediaType: 'image/jpeg' }, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    for (const request of chrome.requests) expect(await chrome.signedByThisChrome(request)).toBe(true);
    expect(chrome.sent.filter(message => message.capture).at(-1)).toEqual({ capture: { event: 'end', captureId, state: 'saved', reason: null, endedAt: expect.any(String), tracks: { video: { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: expect.any(Number) } } } });
    expect(chrome.isOffscreenOpen()).toBe(false);
    expect(chrome.toolbar.at(-1)?.badge).toBe('');
  });

  it('on a tab’s in-page control records its screencast frames where Chrome gives no video of it', async () => {
    const chrome = await installed({ protocol: 4 });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await settle();
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { capture: 'ready' } });
    await chrome.pageEvent('target-1', 'Runtime.bindingCalled', { name: '__gitspaceStop', payload: 'capture', executionContextId: 50 });
    await chrome.pageEvent('target-1', 'Page.screencastFrame', { data: FRAME, sessionId: 1, metadata: {} });
    expect(chrome.streamIds).toEqual([{ targetTabId: 1 }]);
    expect(chrome.offscreenCreated).toEqual([]);
    const start = chrome.sent.find(message => message.capture)?.capture;
    expect(start).toMatchObject({ event: 'start', targetId: 'target-1', track: 'frames', sound: false });
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'run', capture: 'recording' } });

    await chrome.pageEvent('target-1', 'Runtime.bindingCalled', { name: '__gitspaceStop', payload: 'captureStop', executionContextId: 50 });
    await chrome.waitFor(() => chrome.sent.some(message => typeof message.capture === 'object' && message.capture !== null && 'event' in message.capture && message.capture.event === 'end'));
    expect(chrome.sent.filter(message => message.capture).at(-1)).toMatchObject({ capture: { event: 'end', state: 'saved', reason: null, tracks: { frames: { path: 'frames.bin', index: 'frames.json', count: 1, width: 32, height: 16 } } } });
    // The script still drives the tab, which keeps painting.
    expect(screencasts(chrome.commands, 'target-1').at(-1)).toEqual({ format: 'jpeg', quality: 1, maxWidth: 1, maxHeight: 1 });
    expect(chrome.detached).toEqual([]);
  });
});

describe('with an account at protocol 3', () => {
  it('leaves downloads to Chrome and offers no Capture', async () => {
    const chrome = await installed({ live: true });
    await chrome.relay(3);
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await settle();
    expect(chrome.sentCommands()).toEqual(['Page.startScreencast']);
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { capture: 'none' } });
    await chrome.pageEvent('target-1', 'Page.downloadWillBegin', { frameId: 'main', guid: 'g-1', url: 'https://app.example/report.csv', suggestedFilename: 'report.csv' });
    await chrome.download({ id: 5, url: 'https://app.example/report.csv', finalUrl: 'https://app.example/report.csv', mime: 'text/csv', filename: '', state: 'in_progress' });
    await chrome.execute({ operation: 'release', attemptId });
    expect(chrome.downloadCalls).toEqual([]);
    expect(chrome.requests).toEqual([]);
    chrome.captureGrants.add(1);
    expect((await chrome.popup({ popupState: true })).activeTab).toMatchObject({ capture: { recording: null, unavailable: 'Your GitSpace account does not save captures yet; update GitSpace' } });
    expect(await chrome.popup({ startCapture: 1 })).toEqual({ error: 'Your GitSpace account does not save captures yet; update GitSpace' });
    expect(chrome.streamIds).toEqual([]);
  });
});
