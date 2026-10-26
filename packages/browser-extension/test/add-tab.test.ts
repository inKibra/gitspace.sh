import { afterEach, describe, expect, it } from 'bun:test';
import type { Window } from 'happy-dom';
import { installed } from './installed.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); });

/** Your Chrome, connected to an account that adds tabs to workspaces (`addTab`), looking at a tab of yours in no
 * workspace group (tab 9). The account lists Checkout (whose group here is Chrome group 7), two workspaces of
 * ToneTempo, and one of a project that has not approved this Chrome. */
async function adding(ready: Record<string, unknown> = { addTab: true }) {
  const chrome = await installed({ live: true });
  await chrome.relay(undefined, ready);
  chrome.tabs.set(9, { id: 9, groupId: -1, url: 'https://elsewhere.example/', index: 9, windowId: 1, title: 'Elsewhere' });
  chrome.activate(9);
  chrome.workspaces.push(
    { projectId: 'project', project: 'Shop', workspaceId: 'workspace', name: 'Checkout', approved: true },
    { projectId: 'tone', project: 'ToneTempo', workspaceId: 'coach', name: 'Coach subscriptions', approved: true },
    { projectId: 'tone', project: 'ToneTempo', workspaceId: 'streaks', name: 'Challenges and streaks', approved: true },
    { projectId: 'core', project: 'inkibra core', workspaceId: 'schedules', name: 'Workflow schedules', approved: false },
  );
  return chrome;
}
type Popup = { window: Window; rendered(): Promise<void> };
/** The popup's search box. */
function searchBox({ window }: Popup) {
  const found = window.document.querySelector('input[aria-label="Find a workspace"]');
  if (!(found instanceof window.HTMLInputElement)) throw new Error('No workspace search box');
  return found;
}
/** You click into the search box and type `text`, as React hears it. */
async function search(popup: Popup, text: string) {
  const input = searchBox(popup);
  input.focus();
  Object.getOwnPropertyDescriptor(popup.window.HTMLInputElement.prototype, 'value')?.set?.call(input, text);
  input.dispatchEvent(new popup.window.Event('input', { bubbles: true }));
  await popup.rendered();
}
async function press(popup: Popup, key: string) {
  searchBox(popup).dispatchEvent(new popup.window.KeyboardEvent('keydown', { key, bubbles: true }));
  await popup.rendered();
}
/** The picker's list as it reads: its headings and its workspaces, the one the arrow keys are on marked. */
function rows({ window }: Popup) {
  return [...window.document.querySelectorAll('[role="listbox"] > p, [role="listbox"] > div > p, [role="option"]')].map(node => `${node.getAttribute('aria-selected') === 'true' ? '> ' : ''}${node.textContent}`);
}
function button({ window }: Popup, name: string) {
  const found = [...window.document.querySelectorAll('button')].find(node => node.textContent === name);
  if (!(found instanceof window.HTMLElement)) throw new Error(`No ${name} button`);
  return found;
}
const heading = ({ window }: Popup) => [...window.document.querySelectorAll('h3')].find(node => node.textContent?.startsWith('This tab'))?.textContent;

describe('adding a tab to a workspace from the popup', () => {
  it('lists the recent workspaces of approved projects, searches workspace and project names by project, and shows each one’s group here, that adding makes one, or that its project has not approved this Chrome', async () => {
    const chrome = await adding();
    const popup = await chrome.openPopup();
    closing.push(popup.close);
    // Until the tab is in a workspace, nobody comments on its link.
    expect(button(popup, 'comment')).toMatchObject({ disabled: true });
    expect(popup.document.body.textContent).toContain('Add the tab to a workspace to let people comment: their comments go to that workspace, and its agent can use the tab on its approved sites.');
    expect(chrome.workspaceRequests).toEqual([]);

    await search(popup, '');
    expect(chrome.workspaceRequests).toEqual([{ op: 'list' }]);
    expect(await chrome.authorizedAsRequired(chrome.requests.at(-1) ?? { method: '', pathname: '', header: null, body: new Uint8Array(0) })).toBe(true);
    expect(rows(popup)).toEqual(['Recent', '> Checkout · ShopIts group here · 3 tabs', 'Coach subscriptions · ToneTempoNo tab group here yet · adding makes one', 'Challenges and streaks · ToneTempoNo tab group here yet · adding makes one']);

    await search(popup, 'work');
    expect(rows(popup)).toEqual(['inkibra core', 'Workflow schedulesThis Chrome isn\'t approved in inkibra coreApprove…']);
    await search(popup, 'tone');
    expect(rows(popup)).toEqual(['ToneTempo', '> Coach subscriptionsNo tab group here yet · adding makes one', 'Challenges and streaksNo tab group here yet · adding makes one']);
    await press(popup, 'ArrowDown');
    await press(popup, 'ArrowDown');
    expect(rows(popup)).toEqual(['ToneTempo', 'Coach subscriptionsNo tab group here yet · adding makes one', '> Challenges and streaksNo tab group here yet · adding makes one']);
    await press(popup, 'ArrowUp');
    expect(rows(popup)[1]).toStartWith('> Coach subscriptions');
    await search(popup, 'nothing like it');
    expect(popup.document.body.textContent).toContain('No workspace matches “nothing like it”.');
    // The list came once, when the picker opened.
    expect(chrome.workspaceRequests).toEqual([{ op: 'list' }]);
  });

  it('choosing a workspace with its group here moves the tab into that group as if you dragged it in: people may comment, and its agent may use the tab on its site', async () => {
    const chrome = await adding();
    const popup = await chrome.openPopup();
    closing.push(popup.close);
    await search(popup, 'check');
    await press(popup, 'Enter');
    await chrome.waitFor(() => chrome.requests.filter(request => request.pathname === '/api/browser-relay/workspaces').length === 2);
    await popup.rendered();
    expect(chrome.workspaceRequests[1]).toEqual({ op: 'add', projectId: 'project', workspaceId: 'workspace', targetId: 'target-9' });
    expect(await chrome.authorizedAsRequired(chrome.requests.at(-1) ?? { method: '', pathname: '', header: null, body: new Uint8Array(0) })).toBe(true);
    expect(chrome.tabs.get(9)?.groupId).toBe(7);
    expect(heading(popup)).toBe('This tab · elsewhere.example · in Checkout');
    expect(popup.window.document.querySelector('input[aria-label="Find a workspace"]')).toBeNull();
    expect(button(popup, '✓ comment')).toMatchObject({ disabled: false });
    expect(button(popup, 'Remove from group')).toBeTruthy();
    // It is yours, consenting to the site it shows: the workspace's agent may use it there.
    await chrome.advance(300);
    expect(chrome.sent.filter(message => message.group).at(-1)).toMatchObject({ group: { tabs: expect.arrayContaining([expect.objectContaining({ targetId: 'target-9', addedBy: 'you', site: 'elsewhere.example' })]) } });
    const attemptId = await chrome.begin();
    expect(await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-9' })).toEqual({ targetId: 'target-9', sessionId: expect.any(String) });
  });

  it('choosing a workspace with no group here makes its group, in the workspace’s colour and titled as the agent’s are', async () => {
    const chrome = await adding();
    // Checkout's Chrome group was closed.
    chrome.groups.delete(7);
    for (const tab of chrome.tabs.values()) if (tab.groupId === 7) tab.groupId = -1;
    const popup = await chrome.openPopup();
    closing.push(popup.close);
    await search(popup, 'checkout');
    expect(rows(popup)).toEqual(['Shop', '> CheckoutNo tab group here yet · adding makes one']);
    const option = popup.window.document.querySelector('[role="option"]');
    if (!(option instanceof popup.window.HTMLElement)) throw new Error('No Checkout row');
    option.click();
    await chrome.waitFor(() => chrome.requests.filter(request => request.pathname === '/api/browser-relay/workspaces').length === 2);
    await popup.rendered();
    const groupId = chrome.tabs.get(9)?.groupId ?? -1;
    expect([-1, 7]).not.toContain(groupId);
    expect(chrome.groups.get(groupId)).toMatchObject({ title: 'Checkout', color: 'cyan' });
    expect(heading(popup)).toBe('This tab · elsewhere.example · in Checkout');
    expect(button(popup, '✓ comment')).toMatchObject({ disabled: false });
  });

  it('a workspace whose project has not approved this Chrome cannot be chosen; Approve… opens Manage Chrome for this Chrome in GitSpace; a refusal says why and leaves the tab where it is', async () => {
    const chrome = await adding();
    const popup = await chrome.openPopup();
    closing.push(popup.close);
    await search(popup, 'workflow');
    await press(popup, 'Enter');
    const option = popup.window.document.querySelector('[role="option"]');
    if (!(option instanceof popup.window.HTMLElement)) throw new Error('No Workflow schedules row');
    expect(option.getAttribute('aria-disabled')).toBe('true');
    option.click();
    await popup.rendered();
    expect(chrome.workspaceRequests).toEqual([{ op: 'list' }]);
    button(popup, 'Approve…').click();
    await popup.rendered();
    expect(chrome.opened).toEqual([`https://account.gitspace.test/plugins?tab=browsers&manage=${chrome.pairingId}`]);

    // The account refuses a workspace it no longer lists as approved.
    chrome.workspaces.splice(1, 1, { projectId: 'tone', project: 'ToneTempo', workspaceId: 'coach', name: 'Coach subscriptions', approved: false });
    await search(popup, 'coach');
    await press(popup, 'Enter');
    await chrome.waitFor(() => chrome.requests.filter(request => request.pathname === '/api/browser-relay/workspaces').length === 2);
    await popup.rendered();
    expect(popup.document.body.textContent).toContain('This Chrome isn\'t approved in ToneTempo');
    expect(chrome.tabs.get(9)?.groupId).toBe(-1);
  });

  it('says so in its hello; an account that does not add tabs to workspaces gets no picker', async () => {
    const chrome = await adding({});
    expect(chrome.sent.find(message => message.hello)).toMatchObject({ addTab: true });
    const popup = await chrome.openPopup();
    closing.push(popup.close);
    expect(heading(popup)).toBe('This tab · elsewhere.example');
    expect(popup.window.document.querySelector('input[aria-label="Find a workspace"]')).toBeNull();
    await expect(chrome.popup({ workspaceChoices: true })).resolves.toEqual({ error: 'Your GitSpace account does not add tabs to workspaces yet; update GitSpace' });
  });
});
