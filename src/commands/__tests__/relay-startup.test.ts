import { describe, expect, mock, test } from 'bun:test';
import { selectRelaySubdomain } from '../relay.js';

describe('selectRelaySubdomain', () => {
  test('returns null when no account hosts exist', async () => {
    await expect(selectRelaySubdomain([], { interactive: true })).resolves.toBeNull();
  });

  test('auto-selects first subdomain in non-interactive mode', async () => {
    await expect(
      selectRelaySubdomain(['alpha', 'bravo'], { interactive: false }),
    ).resolves.toBe('alpha');
  });

  test('prompts in interactive mode when multiple hosts are available', async () => {
    const select = mock(async () => 'bravo') as unknown as <T>(
      options: { label: string; value: T; description?: string }[],
      message: string,
    ) => Promise<T | null>;

    await expect(
      selectRelaySubdomain(['alpha', 'bravo'], {
        interactive: true,
        primarySubdomain: 'alpha',
        select,
      }),
    ).resolves.toBe('bravo');

    expect(select).toHaveBeenCalledTimes(1);
  });

  test('throws when interactive selection is cancelled', async () => {
    const select = mock(async () => null) as unknown as <T>(
      options: { label: string; value: T; description?: string }[],
      message: string,
    ) => Promise<T | null>;

    await expect(
      selectRelaySubdomain(['alpha', 'bravo'], {
        interactive: true,
        select,
      }),
    ).rejects.toThrow(/Cancelled/);
  });
});
