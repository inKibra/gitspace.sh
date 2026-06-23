import { describe, expect, it } from 'bun:test';
import {
  runVirtualInteractiveInputLoop,
  type RunVirtualInteractiveInputLoopOptions,
} from '../virtual-interactive-mode.js';

function createOptions(overrides: Partial<RunVirtualInteractiveInputLoopOptions> = {}) {
  let running = true;
  const options: RunVirtualInteractiveInputLoopOptions = {
    controller: {
      isRunning: () => running,
      stop: () => {
        running = false;
      },
    },
    onCrash: (error) => {
      throw error;
    },
    ...overrides,
  };
  return {
    options,
    stop: () => {
      running = false;
    },
  };
}

describe('runVirtualInteractiveInputLoop', () => {
  it('backs off between cancelled inputs so cancellation cannot busy-spin', async () => {
    let inputCalls = 0;
    const sleepCalls: number[] = [];
    const { options, stop } = createOptions({
      cancelledInputBackoffMs: 7,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        if (sleepCalls.length === 3) stop();
      },
    });

    await runVirtualInteractiveInputLoop(
      {
        isInitialized: true,
        getUserInput: async () => {
          inputCalls += 1;
          return { text: '', images: [], cancelled: true, started: false };
        },
      } as any,
      {} as any,
      async () => {
        throw new Error('cancelled input must not be submitted');
      },
      options,
    );

    expect(inputCalls).toBe(3);
    expect(sleepCalls).toEqual([7, 7, 7]);
  });

  it('submits non-cancelled input', async () => {
    const submitted: unknown[] = [];
    const { options, stop } = createOptions();

    await runVirtualInteractiveInputLoop(
      {
        isInitialized: true,
        getUserInput: async () => ({ text: 'hello', images: [], cancelled: false, started: false }),
      } as any,
      {} as any,
      async (_mode, _session, input) => {
        submitted.push(input);
        stop();
      },
      options,
    );

    expect(submitted).toEqual([{ text: 'hello', images: [], cancelled: false, started: false }]);
  });

  it('rejects invalid cancellation backoff values', async () => {
    const { options } = createOptions({ cancelledInputBackoffMs: 0 });

    await expect(runVirtualInteractiveInputLoop(
      {
        isInitialized: true,
        getUserInput: async () => ({ text: '', images: [], cancelled: true, started: false }),
      } as any,
      {} as any,
      async () => {},
      options,
    )).rejects.toThrow('cancelledInputBackoffMs must be a positive finite number');
  });
});
