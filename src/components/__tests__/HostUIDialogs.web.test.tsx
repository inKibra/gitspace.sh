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
