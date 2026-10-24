import { describe, expect, it } from 'bun:test';
import { command, installed } from './installed.js';

describe('a script on your Chrome', () => {
  it('cannot open, list or drive a tab on a site that allows single steps only', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, url: 'https://bank.example/transfer' })).rejects.toThrow('bank.example allows single steps only, not scripts');
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-3' })).rejects.toThrow('bank.example allows single steps only, not scripts');
    expect(await chrome.execute({ operation: 'tabs', attemptId, groupId: chrome.grant.body.groupId })).toEqual([
      { targetId: 'target-1', title: 'Page', url: 'https://app.example/', addedBy: 'agent' },
      { targetId: 'target-2', title: 'Page', url: 'https://a.docs.example/', addedBy: 'agent' },
    ]);
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    // Opening it starts the screencast that keeps a background tab painting.
    expect(chrome.sentCommands()).toEqual(['Page.startScreencast']);
    await chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }));
    expect(chrome.sentCommands()).toEqual(['Page.startScreencast', 'Runtime.evaluate']);
    await chrome.pageEvent('target-1', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'cart' }] });
    expect(chrome.sent).toContainEqual(expect.objectContaining({ targetId: 'target-1', method: 'Runtime.consoleAPICalled' }));
    // You take the tab to the bank: the script's next command there is refused, and it hears nothing from the page.
    chrome.tabs.set(1, { id: 1, groupId: 7, url: 'https://bank.example/', index: 1, windowId: 1 });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: 'document.body.innerText' }))).rejects.toThrow('bank.example allows single steps only, not scripts');
    expect(chrome.sentCommands()).toEqual(['Page.startScreencast', 'Runtime.evaluate']);
    chrome.sent.length = 0;
    await chrome.pageEvent('target-1', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'balance' }] });
    expect(chrome.sent).toEqual([]);
  });

  it('sees and reaches only the sites it names', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin(['app.example']);
    expect(await chrome.execute({ operation: 'tabs', attemptId, groupId: chrome.grant.body.groupId })).toEqual([{ targetId: 'target-1', title: 'Page', url: 'https://app.example/', addedBy: 'agent' }]);
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-2' })).rejects.toThrow('outside the sites of this script');
    await expect(chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, url: 'https://a.docs.example/' })).rejects.toThrow('outside the sites of this script');
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Page.navigate', { url: 'https://a.docs.example/' }))).rejects.toThrow('outside the sites of this script');
    expect(chrome.sentCommands()).toEqual(['Page.startScreencast']);
  });

  it('is refused a site its grant does not hold or one that allows single steps only', async () => {
    const chrome = await installed();
    await expect(chrome.begin(['elsewhere.example'])).rejects.toThrow('elsewhere.example is not a site of this workspace group');
    await expect(chrome.begin(['bank.example'])).rejects.toThrow('bank.example allows single steps only, not scripts');
  });

  it('marks its group while it runs and stops with Stop in the popup: commands refused, tabs let go, run logged', async () => {
    const chrome = await installed();
    const attemptId = await chrome.begin();
    expect(chrome.group.title).toBe('▶ Checkout');
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }));
    await expect(chrome.execute(command(attemptId, 'target-1', 'Storage.getCookies'))).rejects.toThrow();
    expect(await chrome.popup({ popupState: true })).toMatchObject({ groups: [{ groupId: chrome.grant.body.groupId, name: 'Checkout', running: 1, tabs: 3 }], log: [] });

    const stopped = await chrome.popup({ stopGroup: chrome.grant.body.groupId });
    expect(stopped).toMatchObject({ groups: [{ running: 0 }], log: [expect.objectContaining({ attemptId, endReason: 'stopped', commands: 3, refused: 1 })] });
    expect(chrome.group.title).toBe('Checkout');
    expect(chrome.detached).toEqual(['target-1']);
    expect(chrome.sent).toContainEqual({ targetId: 'target-1', fenced: true });
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '2' }))).rejects.toThrow('You stopped this script in Chrome');
    await expect(chrome.execute({ operation: 'tabs', attemptId, groupId: chrome.grant.body.groupId })).rejects.toThrow('You stopped this script in Chrome');
  });

  it('keeps its group marked until the last script on it ends', async () => {
    const chrome = await installed();
    const first = await chrome.begin();
    const second = await chrome.begin();
    await chrome.execute({ operation: 'release', attemptId: first });
    expect(chrome.group.title).toBe('▶ Checkout');
    await chrome.execute({ operation: 'release', attemptId: second });
    expect(chrome.titles).toEqual(['▶ Checkout', 'Checkout']);
    expect((await chrome.popup({ popupState: true })).log).toEqual([expect.objectContaining({ endReason: 'released' }), expect.objectContaining({ endReason: 'released' })]);
  });
});
