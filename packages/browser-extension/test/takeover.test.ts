import { describe, expect, it } from 'bun:test';
import { RuntimeBrowserGroupReportSchema, type RuntimeBrowserArguments } from '@gitspace/protocol-runtime';
import { SCRIPT_TAKEN_REFUSAL, TAB_HELD_REFUSAL } from '../src/index.js';
import { command, installed, settle } from './installed.js';

const observe = (targetId: string): RuntimeBrowserArguments => ({ action: 'observe', source: 'relay', targetId, screenshot: false, offset: 0, limit: 400 });
const readPage = (targetId: string) => ({ operation: 'command', targetId, method: 'Accessibility.getFullAXTree', params: { depth: 32 } });

/** The installed extension (`installed`), with what these tests do to it. */
async function chromeWith(options: { live?: boolean; activity?: boolean; takeover?: boolean }) {
  const chrome = await installed(options);
  return {
    chrome,
    /** The group reports the relay received, as it parses them (an unknown field refuses the report). */
    reports: () => chrome.sent.flatMap(message => 'group' in message ? [RuntimeBrowserGroupReportSchema.parse(message.group)] : []),
    /** A single step: the account authorizes it and binds its tab; the tab's overlay is drawn. */
    step: async (args: RuntimeBrowserArguments) => {
      await chrome.authorize({ type: 'execute', args, grant: chrome.grant }, 'browser');
      await chrome.execute({ operation: 'open', grant: chrome.grant });
      await settle();
    },
    /** The tab's overlay calls its binding from its own world: a button, or your input on the page (`take`). */
    press: (targetId: string, payload: string) => chrome.pageEvent(targetId, 'Runtime.bindingCalled', { name: '__gitspaceStop', payload, executionContextId: 50 }),
  };
}
describe('taking over a tab the agent uses', () => {
  it('your first input there makes you its holder: the account hears it at once, and the agent’s next step there is refused', async () => {
    const { chrome, reports, step, press } = await chromeWith({ activity: true, takeover: true });
    await step(observe('target-1'));
    await chrome.execute(readPage('target-1'));
    const before = reports().length;
    await press('target-1', 'take');
    // At once: no report timer ran.
    expect(reports()).toHaveLength(before + 1);
    expect(reports().at(-1)).toMatchObject({ held: [{ targetId: 'target-1', holder: 'you', since: expect.any(String), by: 'chrome', device: null }], agents: [{ tool: 'observe', targetId: 'target-1' }] });
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'you', agent: 'main' } });
    const sent = chrome.sentCommands().length;
    await expect(chrome.execute(readPage('target-1'))).rejects.toThrow(TAB_HELD_REFUSAL);
    await chrome.authorize({ type: 'execute', args: observe('target-1'), grant: chrome.grant }, 'browser');
    await expect(chrome.execute({ operation: 'open', grant: chrome.grant })).rejects.toThrow(TAB_HELD_REFUSAL);
    expect(chrome.sentCommands()).toHaveLength(sent);
    // Nothing of the tab you hold reaches the agent.
    chrome.sent.length = 0;
    await chrome.pageEvent('target-1', 'Page.loadEventFired', { timestamp: 1 });
    expect(chrome.sent.filter(message => 'method' in message)).toEqual([]);
  });

  it('is never the agent’s own input: a take while the agent’s Input is in flight or just ended is ignored', async () => {
    const { chrome, reports, step, press } = await chromeWith({ takeover: true });
    const pending = Promise.withResolvers<object>();
    chrome.answer(({ method }) => method === 'Input.dispatchMouseEvent' ? pending.promise : method === 'Accessibility.getFullAXTree' ? { nodes: [{ nodeId: '1', backendDOMNodeId: 12, name: { type: 'computedString', value: 'Medium' } }] } : method === 'DOM.getBoxModel' ? { model: { content: [0, 0, 10, 0, 10, 10, 0, 10], border: [0, 0, 10, 0, 10, 10, 0, 10] } } : undefined);
    const held = () => reports().some(report => report.held?.length);
    // A script's click: in flight, then just ended.
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await settle();
    const click = chrome.execute(command(attemptId, 'target-1', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 }));
    await settle();
    await press('target-1', 'take');
    pending.resolve({});
    await click;
    await press('target-1', 'take');
    expect(held()).toBe(false);
    await chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '1' }));
    await chrome.execute({ operation: 'release', attemptId });
    // A single step's click, just ended.
    await step(observe('target-2'));
    await chrome.execute(readPage('target-2'));
    await step({ action: 'act', source: 'relay', targetId: 'target-2', ref: '0:12', operation: 'click' });
    await chrome.execute({ operation: 'command', targetId: 'target-2', method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 } });
    await press('target-2', 'take');
    expect(held()).toBe(false);
    // Your input after that takes the tab.
    await chrome.advance(300);
    await press('target-2', 'take');
    expect(reports().at(-1)?.held).toMatchObject([{ targetId: 'target-2', by: 'chrome' }]);
  });

  it('Take over and Resume agent on the tab’s toolbar take it and hand it back, each heard at once; the agent works there again after', async () => {
    const { chrome, reports, step, press } = await chromeWith({ takeover: true });
    await step(observe('target-1'));
    await chrome.execute(readPage('target-1'));
    await press('target-1', 'takeover');
    expect(reports().at(-1)?.held).toMatchObject([{ targetId: 'target-1', holder: 'you', by: 'chrome', device: null }]);
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: "You're in control of a tab" });
    await expect(chrome.execute(readPage('target-1'))).rejects.toThrow(TAB_HELD_REFUSAL);
    await press('target-1', 'resume');
    expect(reports().at(-1)?.held).toEqual([]);
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'step' } });
    expect(await chrome.execute(readPage('target-1'))).toMatchObject({ gitspaceDocument: 0 });
    expect(chrome.toolbar.at(-1)?.title).not.toContain('in control');
  });

  it('ends a running script at its next command on that tab, while its commands to the group’s other tabs work until then', async () => {
    const { chrome, reports, step, press } = await chromeWith({ takeover: true });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-2' });
    await settle();
    await press('target-1', 'take');
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'you' } });
    chrome.sent.length = 0;
    await chrome.pageEvent('target-1', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'your secret' }] });
    await chrome.pageEvent('target-2', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'docs' }] });
    expect(chrome.sent.filter(message => 'method' in message).map(message => message.targetId)).toEqual(['target-2']);
    expect(await chrome.execute(command(attemptId, 'target-2', 'Runtime.evaluate', { expression: '1' }))).toEqual({});
    await expect(chrome.execute(command(attemptId, 'target-1', 'Runtime.evaluate', { expression: '2' }))).rejects.toThrow(SCRIPT_TAKEN_REFUSAL);
    await expect(chrome.execute(command(attemptId, 'target-2', 'Runtime.evaluate', { expression: '3' }))).rejects.toThrow(SCRIPT_TAKEN_REFUSAL);
    expect((await chrome.popup({ popupState: true })).log).toEqual([expect.objectContaining({ attemptId, endReason: 'taken' })]);
    // The tab you hold keeps its debugger for Resume agent; the script's other tab is let go.
    expect(chrome.detached).toEqual(['target-2']);
  });

  it('from GitSpace needs the signed take over or resume of that tab, and moves the device of a tab you hold', async () => {
    const { chrome, reports, step, press } = await chromeWith({ takeover: true });
    const groupId = chrome.grant.body.groupId;
    await expect(chrome.execute({ operation: 'takeOver', groupId, targetId: 'target-2', device: 'phone' })).rejects.toThrow('Signed take over required');
    await chrome.authorize({ type: 'manage', action: 'takeOver', groupId, targetId: 'target-2', device: 'phone' }, 'browser_control');
    await expect(chrome.execute({ operation: 'takeOver', groupId, targetId: 'target-2', device: 'laptop' })).rejects.toThrow('Signed take over required');
    await chrome.authorize({ type: 'manage', action: 'takeOver', groupId, targetId: 'target-2', device: 'phone' }, 'browser_control');
    expect(await chrome.execute({ operation: 'takeOver', groupId, targetId: 'target-2', device: 'phone' })).toEqual({});
    const [taken] = reports().at(-1)?.held ?? [];
    expect(taken).toMatchObject({ targetId: 'target-2', by: 'gitspace', device: 'phone' });
    // A tab the agent was not using gets the debugger, for its toolbar.
    expect(chrome.attached).toEqual(['target-2']);
    await settle();
    expect(chrome.overlays('target-2').at(-1)).toMatchObject({ show: { mode: 'you' } });
    await chrome.authorize({ type: 'manage', action: 'takeOver', groupId, targetId: 'target-2', device: 'laptop' }, 'browser_control');
    await chrome.execute({ operation: 'takeOver', groupId, targetId: 'target-2', device: 'laptop' });
    expect(reports().at(-1)?.held).toEqual([{ ...taken, device: 'laptop' }]);
    await expect(chrome.execute({ operation: 'resume', groupId, targetId: 'target-2' })).rejects.toThrow('Signed resume required');
    await chrome.authorize({ type: 'manage', action: 'resume', groupId, targetId: 'target-2' }, 'browser_control');
    expect(await chrome.execute({ operation: 'resume', groupId, targetId: 'target-2' })).toEqual({});
    expect(reports().at(-1)?.held).toEqual([]);
    expect(chrome.detached).toEqual(['target-2']);
  });

  it('survives a service-worker restart: the tab stays yours, and the popup and toolbar say so', async () => {
    const { chrome, reports, step, press } = await chromeWith({ takeover: true });
    await step(observe('target-1'));
    await press('target-1', 'take');
    const [held] = reports().at(-1)?.held ?? [];
    await chrome.restart();
    await chrome.authorize({ type: 'execute', args: observe('target-1'), grant: chrome.grant }, 'browser');
    await expect(chrome.execute({ operation: 'open', grant: chrome.grant })).rejects.toThrow(TAB_HELD_REFUSAL);
    await chrome.advance(300);
    expect(reports().at(-1)?.held).toEqual([held]);
    expect(chrome.overlays('target-1').at(-1)).toMatchObject({ show: { mode: 'you' } });
    expect(chrome.toolbar.at(-1)).toMatchObject({ title: "You're in control of a tab" });
    expect((await chrome.popup({ popupState: true })).groups).toMatchObject([{ groupId: chrome.grant.body.groupId, held: true }]);
    const popup = await chrome.openPopup();
    expect(popup.document.body.textContent).toContain("You're in control");
    await popup.close();
  });

  it('ends when the tab closes', async () => {
    const { chrome, reports, step, press } = await chromeWith({ takeover: true });
    await step(observe('target-1'));
    await press('target-1', 'take');
    await chrome.closeTab(1);
    expect(reports().at(-1)?.held).toEqual([]);
    expect(chrome.stored.get('holders')).toEqual([]);
  });

  it('is never reported to an account whose ready does not say takeover; the hello says this extension takes it', async () => {
    const { chrome, reports, step, press } = await chromeWith({ live: true });
    await chrome.relay(undefined, { groupActivity: true });
    expect(chrome.sent.find(message => message.hello)).toMatchObject({ takeover: true });
    const attemptId = await chrome.begin();
    await chrome.execute({ operation: 'open', attemptId, grant: chrome.grant, targetId: 'target-1' });
    await settle();
    await press('target-1', 'take');
    await chrome.advance(300);
    expect(reports().length).toBeGreaterThan(0);
    for (const report of reports()) {
      expect(report.held).toBeUndefined();
      for (const agent of report.agents ?? []) expect(agent.targetId).toBeUndefined();
    }
  });
});
