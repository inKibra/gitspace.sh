import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { useCommandPaletteState } from '../useCommandPaletteState.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());


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
