import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import { useCommandPaletteState } from '../useCommandPaletteState.js';

const domWindow = new Window();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow;
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});


describe('useCommandPaletteState', () => {
  it('selectCurrent uses the most recently clicked index immediately', () => {
    const onSelect = mock(() => undefined);

    const { result } = renderHook(() =>
      useCommandPaletteState({
        commands: [
          { id: 'first', label: 'First' },
          { id: 'second', label: 'Second' },
        ],
        onSelect,
      }),
    );

    act(() => {
      result.current.open();
      result.current.setSelectedIndex(1);
      result.current.selectCurrent();
    });

    expect(onSelect).toHaveBeenCalledWith('second');
  });
});
