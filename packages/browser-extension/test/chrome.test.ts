import { describe, expect, it } from 'bun:test';
import type { RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { command, installed, settle } from './installed.js';

describe('group reports', () => {
  it('count the scripts running on the group, again when one starts and when it ends', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.advance(300);
    expect(chrome.sent.flatMap(message => 'group' in message ? [message.group] : []).at(-1)).toMatchObject({ groupId: chrome.grant.body.groupId, running: 1, tabs: [{ targetId: 'target-1' }, { targetId: 'target-2' }, { targetId: 'target-3' }] });
    await chrome.execute({ operation: 'release', attemptId });
    await chrome.advance(300);
    expect(chrome.sent.flatMap(message => 'group' in message ? [message.group] : []).at(-1)).toMatchObject({ groupId: chrome.grant.body.groupId, running: 0 });
  });
});

describe('a tab preview', () => {
  it('is a small JPEG of a group tab the agent is using, once per signed request', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    expect(await chrome.preview('target-1')).toEqual({ image: 'JPEG', reason: null });
    expect(chrome.commands.find(({ method }) => method === 'Page.captureScreenshot')?.params).toEqual({ format: 'jpeg', quality: 50, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1200, height: 800, scale: 0.4 } });
    await expect(chrome.execute({ operation: 'preview', groupId: chrome.grant.body.groupId, targetId: 'target-1' })).rejects.toThrow('Signed tab preview required');
  });

  it('is none for a tab the agent is not using, and never attaches the debugger for it', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    expect(await chrome.preview('target-2')).toEqual({ image: null, reason: 'Preview appears while the agent uses this tab' });
    expect(chrome.attached).toEqual(['target-1']);
    expect(chrome.commands.filter(({ targetId }) => targetId === 'target-2')).toEqual([]);
  });

  it('needs a signed preview of that tab', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.authorize({ type: 'manage', action: 'preview', groupId: chrome.grant.body.groupId, targetId: 'target-2' }, 'browser_control');
    await expect(chrome.execute({ operation: 'preview', groupId: chrome.grant.body.groupId, targetId: 'target-1' })).rejects.toThrow('Signed tab preview required');
    expect(chrome.commands.some(({ method }) => method === 'Page.captureScreenshot')).toBe(false);
  });
});

describe('turning GitSpace off and on in this Chrome', () => {
  it('off ends every script, lets the tabs go and stays disconnected; on connects again', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    const opened = chrome.sockets.length;
    const off = await chrome.popup({ setEnabled: { enabled: false } });
    expect(off).toMatchObject({ enabled: false, reenableAt: null, connection: 'off', log: [expect.objectContaining({ attemptId, endReason: 'stopped' })] });
    expect(chrome.detached).toEqual(['target-1']);
    expect(chrome.local.get('enabled')).toBe(false);
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }))).rejects.toThrow('You stopped this script in Chrome');
    await chrome.alarm('relay-reconnect');
    await chrome.advance(5000);
    expect(chrome.sockets.length).toBe(opened);

    expect(await chrome.popup({ setEnabled: { enabled: true } })).toMatchObject({ enabled: true, connection: 'connecting' });
    expect(chrome.sockets.length).toBe(opened + 1);
    expect(chrome.local.has('enabled')).toBe(false);
  });

  it('off for an hour turns itself back on by alarm', async () => {
    const chrome = await installed();
    const before = Date.now();
    const off = await chrome.popup({ setEnabled: { enabled: false, minutes: 60 } });
    const reenableAt = Number(off.reenableAt);
    expect(reenableAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(chrome.alarms.get('relay-enable')).toEqual({ when: reenableAt });
    const opened = chrome.sockets.length;
    await chrome.alarm('relay-enable');
    expect(chrome.sockets.length).toBe(opened + 1);
    expect(await chrome.popup({ popupState: true })).toMatchObject({ enabled: true, reenableAt: null });
  });

  it('stays off when Chrome starts the extension again', async () => {
    const chrome = await installed({ local: { enabled: false, reenableAt: null }, live: true });
    await chrome.advance(5000);
    expect(chrome.sockets).toEqual([]);
    expect(chrome.toolbar.at(-1)?.title).toBe('GitSpace is off in this Chrome');
  });

  it('refuses a time off with on, or out of range', async () => {
    const chrome = await installed();
    expect(await chrome.popup({ setEnabled: { enabled: true, minutes: 60 } })).toEqual({ error: 'Invalid time off' });
    expect(await chrome.popup({ setEnabled: { enabled: false, minutes: 0 } })).toEqual({ error: 'Invalid time off' });
    expect(chrome.local.has('enabled')).toBe(false);
  });
});

describe('the toolbar icon', () => {
  it('shows connecting as needing you, on, the workspaces an agent acts on with their count, and off', async () => {
    const chrome = await installed({ live: true });
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: 'GitSpace is connecting to account.gitspace.test', badge: '!' });
    const attention = chrome.toolbar.at(-1)?.icon;
    await chrome.relay();
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: 'GitSpace is on · account.gitspace.test', badge: '' });
    const idle = chrome.toolbar.at(-1)?.icon;
    const first = await chrome.begin();
    await chrome.begin();
    // Two scripts on one workspace group: one workspace acting.
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: 'GitSpace is running 2 scripts in this Chrome', badge: '1' });
    const working = chrome.toolbar.at(-1)?.icon;
    await chrome.execute({ operation: 'release', attemptId: first });
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: 'GitSpace is running 1 script in this Chrome', badge: '1' });
    await chrome.popup({ setEnabled: { enabled: false } });
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: 'GitSpace is off in this Chrome', badge: '' });
    const off = chrome.toolbar.at(-1)?.icon;
    // One image per state, at both toolbar sizes.
    for (const icon of [attention, idle, working, off]) expect(Object.keys(icon ?? {})).toEqual(['16', '32']);
    expect(new Set([attention, idle, working, off].map(icon => JSON.stringify(icon?.[16]?.colors))).size).toBe(4);
  });

  it('asks for an update when the account refuses this extension', async () => {
    const chrome = await installed({ live: true });
    await chrome.relay(1);
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: 'GitSpace needs an update in this Chrome', badge: '!' });
  });
});

describe('the in-page overlay on a tab the agent uses', () => {
  it('shows the group running a script, draws the cursor before each mouse event, and leaves before the debugger', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    // The overlay draws after the tab is open, without holding up the script.
    await settle();
    expect(chrome.overlays('target-1')).toEqual([{ show: { mode: 'run', workspace: 'Checkout', agent: 'main', doing: 'Running a script', binding: '__gitspaceStop', capture: 'none', recording: null } }]);
    await chrome.execute(command(attemptId, 'target-1', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 }));
    const methods = chrome.commands.filter(({ targetId }) => targetId === 'target-1').map(({ method, params }) => method === 'Runtime.callFunctionOn' ? JSON.stringify(Array.isArray(params.arguments) ? params.arguments[0]?.value?.cursor : null) : method);
    expect(methods.slice(-2)).toEqual([JSON.stringify({ x: 40, y: 60, type: 'mousePressed' }), 'Input.dispatchMouseEvent']);
    await chrome.execute({ operation: 'release', attemptId });
    expect(chrome.overlays('target-1').at(-1)).toEqual({ remove: true });
    expect(chrome.detached).toEqual(['target-1']);
  });

  it('hides from a script’s own screenshot', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.execute(command(attemptId, 'target-1', 'Page.captureScreenshot', { format: 'png' }));
    const sequence = chrome.commands.filter(({ targetId }) => targetId === 'target-1').map(({ method, params }) => method === 'Runtime.callFunctionOn' ? `conceal:${Array.isArray(params.arguments) ? params.arguments[0]?.value?.conceal : ''}` : method);
    expect(sequence.slice(-3)).toEqual(['conceal:true', 'Page.captureScreenshot', 'conceal:false']);
  });

  it('Stop there ends that group’s scripts; a call from another world does nothing and the session never hears it', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await settle();
    const binding = chrome.commands.find(({ method }) => method === 'Runtime.addBinding')?.params;
    expect(binding).toEqual({ name: '__gitspaceStop', executionContextId: 50 });
    await chrome.pageEvent('target-1', 'Runtime.bindingCalled', { name: '__gitspaceStop', payload: 'stop', executionContextId: 7 });
    await chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }));
    await chrome.pageEvent('target-1', 'Runtime.bindingCalled', { name: '__gitspaceStop', payload: 'stop', executionContextId: 50 });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '2' }))).rejects.toThrow('You stopped this script in Chrome');
    expect(chrome.detached).toEqual(['target-1']);
    expect(chrome.sent.some(message => 'method' in message && message.method === 'Runtime.bindingCalled')).toBe(false);
  });
});

describe('the popup', () => {
  it('shows the workspace group of this tab, which the tab can leave, and brings a group’s first tab to the front', async () => {
    const chrome = await installed();
    const state = await chrome.popup({ popupState: true });
    expect(state).toMatchObject({ account: 'account.gitspace.test', activeTab: { tabId: 1, groupId: chrome.grant.body.groupId, name: 'Checkout', color: '#1a73e8' } });
    await chrome.popup({ ungroupTab: 1 });
    expect(chrome.ungrouped).toEqual([1]);
    await chrome.popup({ focusGroup: chrome.grant.body.groupId });
    expect(chrome.focused).toEqual([{ tabId: 1, windowId: 1 }]);
  });

  it('never removes a tab outside every workspace group', async () => {
    const chrome = await installed();
    chrome.tabs.set(9, { id: 9, groupId: -1, url: 'https://elsewhere.example/', index: 9, windowId: 1 });
    expect(await chrome.popup({ ungroupTab: 9 })).toEqual({ error: 'This tab is not in a workspace group' });
    expect(chrome.ungrouped).toEqual([]);
  });

  it('names this Chrome, the projects that approved it and each group’s project as the account says', async () => {
    const chrome = await installed({ live: true });
    await chrome.relay();
    // The hello says this extension takes the account's notices about this Chrome.
    expect(chrome.sent.find(message => message.hello)).toMatchObject({ chromeInfo: true, extension: '5.7.0' });
    await chrome.fromRelay({ operation: 'chromeInfo', name: 'Studio desktop', projects: ['GitSpace', 'ToneTempo'], groups: [{ groupId: chrome.grant.body.groupId, project: 'GitSpace' }] });
    expect(await chrome.popup({ popupState: true })).toMatchObject({ chrome: 'Studio desktop', projects: ['GitSpace', 'ToneTempo'], groups: [{ groupId: chrome.grant.body.groupId, project: 'GitSpace' }] });
    // A notice gets no answer.
    expect(chrome.sent.some(message => 'error' in message || 'result' in message)).toBe(false);
    const popup = await chrome.openPopup();
    expect(popup.document.body.textContent).toContain('account.gitspace.test · Studio desktop');
    expect(popup.document.body.textContent).toContain('Connected · approved in GitSpace and ToneTempo');
    expect(popup.document.body.textContent).toContain('Checkout · GitSpace');
    await popup.close();
  });
});

describe('what the agent is doing', () => {
  it('names the element a step clicks or fills by the name the agent read, and never says what it types', async () => {
    const chrome = await installed();
    chrome.answer(({ method }) => method === 'Accessibility.getFullAXTree' ? { nodes: [{ nodeId: '1', backendDOMNodeId: 12, name: { type: 'computedString', value: 'Medium' } }, { nodeId: '2', backendDOMNodeId: 13, name: { type: 'computedString', value: 'Customer name:' } }] } : undefined);
    const step = async (args: RuntimeBrowserArguments) => {
      await chrome.authorize({ type: 'execute', args, grant: chrome.grant }, 'browser');
      await chrome.execute({ operation: 'open', grant: chrome.grant });
    };
    await step({ action: 'observe', source: 'relay', targetId: 'target-1', screenshot: false, offset: 0, limit: 400 });
    await chrome.execute({ operation: 'command', targetId: 'target-1', method: 'Accessibility.getFullAXTree', params: { depth: 32 } });
    await step({ action: 'act', source: 'relay', targetId: 'target-1', ref: '0:12', operation: 'click' });
    expect((await chrome.popup({ popupState: true })).groups).toMatchObject([{ acting: { agent: 'main', doing: 'Clicking “Medium”' } }]);
    await step({ action: 'act', source: 'relay', targetId: 'target-1', ref: '0:13', operation: 'fill', value: 'Ada Lovelace' });
    const state = await chrome.popup({ popupState: true });
    expect(state.groups).toMatchObject([{ acting: { agent: 'main', doing: 'Typing in “Customer name”' } }]);
    expect(JSON.stringify(state)).not.toContain('Ada Lovelace');
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'step', agent: 'main', doing: 'Typing in “Customer name”' } });
    // The toolbar counts the workspace while the step's authority lasts.
    expect(chrome.toolbar.at(-1)).toMatchObject({ badge: '1' });
  });

  it('names a script’s click by what is at its point, and says only that it types', async () => {
    const chrome = await installed();
    chrome.answer(({ method }) => method === 'DOM.getNodeForLocation' ? { backendNodeId: 40 } : method === 'Accessibility.getPartialAXTree' ? { nodes: [{ nodeId: 'text', backendDOMNodeId: 40, ignored: true, parentId: 'button' }, { nodeId: 'button', backendDOMNodeId: 41, name: { type: 'computedString', value: 'Submit order' } }] } : undefined);
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.execute(command(attemptId, 'target-1', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 }));
    expect((await chrome.popup({ popupState: true })).groups).toMatchObject([{ acting: { agent: 'main', doing: 'Clicking “Submit order”' } }]);
    await chrome.execute(command(attemptId, 'target-1', 'Input.insertText', { text: 'hunter2' }));
    const state = await chrome.popup({ popupState: true });
    expect(state.groups).toMatchObject([{ acting: { doing: 'Typing' } }]);
    expect(JSON.stringify(state)).not.toContain('hunter2');
  });
});
