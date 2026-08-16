import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { NativeComposer } from '../NativeComposer.web.js';

beforeAll(() => {
  setupTestDom();
  // The composer reads/writes drafts via the bare `localStorage` global; the
  // happy-dom Window provides one but setup-dom does not lift it onto
  // globalThis. Text state is seeded through the draft store because React's
  // controlled-input onChange does not fire under happy-dom (see the skipped
  // suite below).
  (globalThis as Record<string, unknown>).localStorage =
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage;
});
afterAll(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  teardownTestDom();
});

const DRAFT_KEY = 'gssh:agent-composer-draft:test';

function renderComposerWithDraft(onSubmit: Parameters<typeof NativeComposer>[0]['onSubmit'], draft: string) {
  localStorage.setItem(DRAFT_KEY, draft);
  const view = render(
    <NativeComposer onSubmit={onSubmit} draftStorageKey={DRAFT_KEY} placeholder="Message agent..." />,
  );
  const textarea = view.container.getElementsByTagName('textarea')[0] as HTMLTextAreaElement;
  const sendButton = (Array.from(view.container.getElementsByTagName('button')) as HTMLButtonElement[])
    .find((button) => button.getAttribute('title') === 'Send (Enter)') as HTMLButtonElement;
  return { view, textarea, sendButton };
}

describe('NativeComposer failed-submit retention', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps the composer text when onSubmit returns false (failed send)', async () => {
    const onSubmit = mock(async () => false as const);
    const { textarea, sendButton } = renderComposerWithDraft(onSubmit, 'important prompt');

    expect(textarea.value).toBe('important prompt');
    expect(sendButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton);
    });

    expect(onSubmit).toHaveBeenCalledWith('important prompt', [], [], 'send');
    // Failed send → the draft is preserved, not cleared.
    expect(textarea.value).toBe('important prompt');
    expect(localStorage.getItem(DRAFT_KEY)).toBe('important prompt');
  });

  it('clears the composer text when onSubmit resolves without a preserve signal', async () => {
    const onSubmit = mock(async () => undefined);
    const { textarea, sendButton } = renderComposerWithDraft(onSubmit, 'send me');

    await act(async () => {
      fireEvent.click(sendButton);
    });

    expect(onSubmit).toHaveBeenCalledWith('send me', [], [], 'send');
    expect(textarea.value).toBe('');
    expect(localStorage.getItem(DRAFT_KEY)).toBe(null);
  });

  it('replaces the composer text when onSubmit returns a string (slash command output)', async () => {
    const onSubmit = mock(async () => 'Output from `space context`');
    const { textarea, sendButton } = renderComposerWithDraft(onSubmit, '/space context');

    await act(async () => {
      fireEvent.click(sendButton);
    });

    expect(onSubmit).toHaveBeenCalledWith('/space context', [], [], 'send');
    expect(textarea.value).toBe('Output from `space context`');
  });
});

// Skipped: fireEvent.change does not drive React controlled-input state under
// happy-dom (React's onChange never fires), so typing cannot be simulated here.
// The retention suite above seeds text through the draft store instead.
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
