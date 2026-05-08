import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { NativeComposer } from '../NativeComposer.web.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

describe.skip('NativeComposer slash command submit behavior', () => {
  it('preserves returned slash command output in the composer', async () => {
    const onSubmit = mock(async () => 'Output from `space context` in the current workspace:\n\nProject: demo\nWorkspace: ws-1');

    const view = render(
      <NativeComposer
        onSubmit={onSubmit}
        placeholder="Message agent..."
      />,
    );

    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '/space context', selectionStart: 14 } });
    });

    const buttons = Array.from(view.container.querySelectorAll('button')) as HTMLButtonElement[];
    const sendButton = buttons.find((button) => button.getAttribute('title') === 'Send (Enter)') as HTMLButtonElement;
    expect(textarea).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(sendButton);
    });

    expect(onSubmit).toHaveBeenCalledWith('/space context', [], [], 'send');
    expect(textarea.value).toContain('Output from `space context`');
    expect(textarea.value).toContain('Project: demo');
  });
});
