import { describe, expect, it } from 'bun:test';
import type { RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { command, installed } from './installed.js';

const READ_ONLY = 'news.example is read-only for agents in this workspace: you may open, observe and screenshot it, not click or type';
const CLICK = { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 };

describe('a site at read on your Chrome', () => {
  it('lets a single step look at a tab on it, never click, type or run page JavaScript there, and lets the tab take the level of the site it goes to', async () => {
    const chrome = await installed();
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://news.example/', index: 1, windowId: 1, title: 'Page' });
    chrome.answer(({ method }) => method === 'Accessibility.getFullAXTree' ? { nodes: [{ nodeId: '1', backendDOMNodeId: 12, name: { type: 'computedString', value: 'Subscribe' } }] } : undefined);
    const step = async (args: RuntimeBrowserArguments) => {
      await chrome.authorize({ type: 'execute', args, grant: chrome.grant }, 'browser');
      await chrome.execute({ operation: 'open', grant: chrome.grant });
    };
    await step({ action: 'observe', source: 'relay', targetId: 'target-1', screenshot: false, offset: 0, limit: 400 });
    expect(await chrome.execute({ operation: 'command', targetId: 'target-1', method: 'Accessibility.getFullAXTree', params: { depth: 32 } })).toMatchObject({ nodes: [{ backendDOMNodeId: 12 }] });
    await step({ action: 'act', source: 'relay', targetId: 'target-1', ref: '0:12', operation: 'click' });
    await expect(chrome.execute({ operation: 'command', targetId: 'target-1', method: 'Input.dispatchMouseEvent', params: CLICK })).rejects.toThrow(READ_ONLY);
    await step({ action: 'act', source: 'relay', targetId: 'target-1', ref: '0:12', operation: 'fill', value: 'ada@example.com' });
    await expect(chrome.execute({ operation: 'command', targetId: 'target-1', method: 'DOM.focus', params: { backendNodeId: 12 } })).rejects.toThrow(READ_ONLY);
    await step({ action: 'evaluate', source: 'relay', targetId: 'target-1', expression: 'document.title' });
    const evaluate = { operation: 'command', targetId: 'target-1', method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true, awaitPromise: true } };
    await expect(chrome.execute(evaluate)).rejects.toThrow(READ_ONLY);
    expect(chrome.sentCommands().filter(method => method.startsWith('Input.') || method === 'DOM.focus' || method === 'Runtime.evaluate')).toEqual([]);
    // The tab goes on to app.example, at full: the step's page JavaScript runs there.
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://app.example/', index: 1, windowId: 1, title: 'Page' });
    await chrome.execute(evaluate);
    expect(chrome.sentCommands()).toContain('Runtime.evaluate');
  });

  it('never takes a script, and a script allowed on other sites cannot drive a tab that goes to it', async () => {
    const chrome = await installed();
    await expect(chrome.begin(['news.example'])).rejects.toThrow(READ_ONLY);
    const attemptId = await chrome.begin();
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, url: 'https://news.example/' })).rejects.toThrow(READ_ONLY);
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.execute(command(attemptId, 'target-1', 'Input.dispatchMouseEvent', CLICK));
    expect(chrome.sentCommands().filter(method => method === 'Input.dispatchMouseEvent')).toHaveLength(1);
    // You take the script's tab to the read site: its next click there is refused and never reaches the page.
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://news.example/', index: 1, windowId: 1, title: 'Page' });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Input.dispatchMouseEvent', CLICK))).rejects.toThrow(READ_ONLY);
    expect(chrome.sentCommands().filter(method => method === 'Input.dispatchMouseEvent')).toHaveLength(1);
  });
});
