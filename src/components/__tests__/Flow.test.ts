import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { useFlow } from '../Flow.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

describe('useFlow', () => {
  it('returns a stable object across inert rerenders', () => {
    const { result, rerender } = renderHook(() => useFlow());

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
    expect(result.current.showMessage).toBe(first.showMessage);
    expect(result.current.handleConfirm).toBe(first.handleConfirm);
  });

  describe('searchable select', () => {
    it('filters options and confirms using the filtered selection', async () => {
      const onSelect = mock(async () => {});
      const { result } = renderHook(() => useFlow());

      act(() => {
        result.current.showSelect({
          title: 'Create Workspace From',
          searchable: true,
          options: [
            { label: 'GitHub Branch', value: 'branch' },
            { label: 'Linear Issue', value: 'linear' },
            { label: 'Manual Name', value: 'manual' },
          ],
          onSelect,
        });
      });

      act(() => {
        result.current.updateSelectQuery('lin');
      });

      expect(result.current.flow.type).toBe('select');
      if (result.current.flow.type === 'select') {
        expect(result.current.flow.searchQuery).toBe('lin');
        expect(result.current.flow.selectedIndex).toBe(1);
      }

      await act(async () => {
        await result.current.handleConfirm();
      });

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith('linear', 1);
    });

    it('clamps navigation to filtered result count', () => {
      const { result } = renderHook(() => useFlow());

      act(() => {
        result.current.showSelect({
          title: 'Select Branch',
          searchable: true,
          options: [
            { label: 'alpha', value: 'alpha' },
            { label: 'beta', value: 'beta' },
            { label: 'gamma', value: 'gamma' },
          ],
          onSelect: () => {},
        });
      });

      act(() => {
        result.current.updateSelectQuery('ga');
      });

      act(() => {
        result.current.moveDown();
      });

      expect(result.current.flow.type).toBe('select');
      if (result.current.flow.type === 'select') {
        expect(result.current.flow.selectedIndex).toBe(2);
      }

      act(() => {
        result.current.updateSelectQuery('');
      });

      act(() => {
        result.current.moveDown();
      });

      if (result.current.flow.type === 'select') {
        expect(result.current.flow.selectedIndex).toBe(2);
      }
    });
  });
});
