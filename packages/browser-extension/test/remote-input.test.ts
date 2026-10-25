import { describe, expect, it } from 'bun:test';
import { FRAME, installed } from './installed.js';

const viewport = (clientWidth: number, clientHeight: number) => ({ cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth, clientHeight } });

describe('your input from GitSpace’s Watch dialog', () => {
  it('reaches a tab you hold only from the device that took it, as CSS pixels of the viewport Chrome lays it out in', async () => {
    const chrome = await installed({ takeover: true });
    const groupId = chrome.grant.body.groupId;
    let layout = viewport(1000, 500);
    chrome.answer(({ method }) => method === 'Page.getLayoutMetrics' ? layout : undefined);
    const press = { type: 'mouse', event: 'down', x: 0.5, y: 0.25, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 };
    const input = (device: string, value: object = press) => chrome.execute({ operation: 'remoteInput', groupId, targetId: 'target-2', device, input: value });
    const dispatched = () => chrome.commands.filter(({ method }) => method.startsWith('Input.'));

    // The agent holds the tab: nothing of yours reaches it.
    await expect(input('phone')).rejects.toThrow('You do not hold this tab from this device');
    await chrome.authorize({ type: 'manage', action: 'takeOver', groupId, targetId: 'target-2', device: 'phone' }, 'browser_control');
    await chrome.execute({ operation: 'takeOver', groupId, targetId: 'target-2', device: 'phone' });
    // Another device of yours does not drive it either.
    await expect(input('laptop')).rejects.toThrow('You do not hold this tab from this device');
    expect(dispatched()).toEqual([]);

    expect(await input('phone')).toEqual({});
    await input('phone', { type: 'text', text: 'Ada' });
    expect(dispatched()).toEqual([
      { targetId: 'target-2', method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 500, y: 125, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 } },
      { targetId: 'target-2', method: 'Input.insertText', params: { text: 'Ada' } },
    ]);

    // The tab's screencast shows another size: its layout is read again.
    await chrome.execute({ operation: 'shareWatch', shareId: crypto.randomUUID(), targetId: 'target-2', maxWidth: 800, maxHeight: 600 });
    layout = viewport(400, 300);
    await chrome.pageEvent('target-2', 'Page.screencastFrame', { data: FRAME, sessionId: 1, metadata: { deviceWidth: 400, deviceHeight: 300 } });
    await input('phone', { ...press, event: 'up', x: 1, y: 1 });
    expect(dispatched().at(-1)?.params).toEqual({ type: 'mouseReleased', x: 399, y: 299, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });

    // Handed back: the agent's again.
    await chrome.authorize({ type: 'manage', action: 'resume', groupId, targetId: 'target-2' }, 'browser_control');
    await chrome.execute({ operation: 'resume', groupId, targetId: 'target-2' });
    await expect(input('phone')).rejects.toThrow('You do not hold this tab from this device');
    expect(dispatched()).toHaveLength(3);
  });
});
