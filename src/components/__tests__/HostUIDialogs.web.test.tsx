import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import React from 'react';
import { render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { HostUIDialogOverlay } from '../HostUIDialogs.web.js';
import type { HostUIDialogRequest } from '../../lib/tmux-lite/agents/host-ui-bridge.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

describe('HostUIDialogOverlay render safety (BUG A)', () => {
  it('renders a well-formed select dialog', () => {
    const request: HostUIDialogRequest = {
      type: 'select', id: 'dlg-ok', sessionId: 's1', title: 'Pick', options: ['red', 'green'],
    };
    const view = render(<HostUIDialogOverlay request={request} onResponse={() => {}} />);
    expect(document.body.textContent).toContain('Pick');
    expect(document.body.textContent).toContain('green');
    view.unmount();
  });

  it('renders select options that are {label, description} objects (SDK shape) without crashing', () => {
    // The SDK's ask tool passes ExtensionUISelectItem objects, not strings —
    // rendering the raw object was a React "Objects are not valid as a child" crash.
    const request: HostUIDialogRequest = {
      type: 'select', id: 'dlg-obj', sessionId: 's1', title: 'Pick a color',
      options: [
        { label: 'Green', description: 'go' },
        { label: 'Red', description: 'stop' },
      ],
    };
    let picked: unknown = null;
    const view = render(<HostUIDialogOverlay request={request} onResponse={(r) => { picked = r; }} />);
    expect(document.body.textContent).toContain('Green');
    expect(document.body.textContent).toContain('go'); // description shown
    // Clicking sends the LABEL string (what the ask tool matches on), not the object.
    const greenBtn = Array.from(document.getElementsByTagName('button')).find((b) => b.textContent?.includes('Green'));
    (greenBtn as HTMLButtonElement).click();
    expect(picked).toEqual({ type: 'select', id: 'dlg-obj', value: 'Green' });
    view.unmount();
  });

  it('does not throw on a malformed ask-form request (question missing options)', () => {
    // A dialog request for a background/other session can arrive misshapen; the
    // render must never take down the pane. Cast past the type to model the wire
    // shape that a strict compiler would otherwise forbid.
    const bad = {
      type: 'ask-form', id: 'dlg-bad', sessionId: 's-bg', title: 'Q',
      questions: [{ id: 'q1', question: 'Which?' /* options MISSING */ }],
    } as unknown as HostUIDialogRequest;
    let view: ReturnType<typeof render> | null = null;
    expect(() => { view = render(<HostUIDialogOverlay request={bad} onResponse={() => {}} />); }).not.toThrow();
    // Unrenderable request is dropped — no dialog shell in the DOM.
    expect(document.body.textContent).not.toContain('Which?');
    view?.unmount();
  });

  it('does not throw on a select request whose options are missing', () => {
    const bad = { type: 'select', id: 'dlg-bad2', sessionId: 's-bg', title: 'Nope' } as unknown as HostUIDialogRequest;
    let view: ReturnType<typeof render> | null = null;
    expect(() => { view = render(<HostUIDialogOverlay request={bad} onResponse={() => {}} />); }).not.toThrow();
    view?.unmount();
  });
});
