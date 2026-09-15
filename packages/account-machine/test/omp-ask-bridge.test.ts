import { describe, expect, it } from 'bun:test';
import { OmpAskBridge } from '../../account-omp/src/ask-bridge.js';

describe('OmpAskBridge', () => {
  it('publishes one rich ask and resolves every answer', async () => {
    const changes: unknown[] = [];
    const bridge = new OmpAskBridge((pending) => changes.push(pending));
    const context = bridge.context() as { askDialog(questions: unknown[]): Promise<unknown> };
    const resultPromise = context.askDialog([
      { id: 'runtime', question: 'Choose a runtime', header: 'Runtime', options: [{ label: 'Bun', description: 'Fast', preview: 'bun test' }], recommended: 0 },
      { id: 'checks', question: 'Which checks?', options: [{ label: 'Types' }, { label: 'Browser' }], multi: true },
    ]);

    const pending = bridge.current();
    expect(pending?.questions).toHaveLength(2);
    expect(pending?.questions[0]).toMatchObject({ header: 'Runtime', recommended: 0, options: [{ label: 'Bun', description: 'Fast', preview: 'bun test' }] });
    expect(bridge.answer(pending!.id, [
      { id: 'runtime', selectedOptions: ['Bun'], customInput: null },
      { id: 'checks', selectedOptions: ['Types', 'Browser'], customInput: 'Smoke test' },
    ])).toBe(true);
    expect(await resultPromise).toEqual({
      kind: 'submit',
      results: [
        { id: 'runtime', question: 'Choose a runtime', options: ['Bun'], multi: false, selectedOptions: ['Bun'] },
        { id: 'checks', question: 'Which checks?', options: ['Types', 'Browser'], multi: true, selectedOptions: ['Types', 'Browser'], customInput: 'Smoke test' },
      ],
    });
    expect(changes.at(-1)).toBeNull();
  });

  it('clears a pending ask when the tool signal aborts', async () => {
    const controller = new AbortController();
    const bridge = new OmpAskBridge(() => undefined);
    const context = bridge.context() as { askDialog(questions: unknown[], options: { signal: AbortSignal }): Promise<unknown> };
    const resultPromise = context.askDialog([{ id: 'name', question: 'Name?', options: [] }], { signal: controller.signal });
    controller.abort();
    expect(await resultPromise).toBeUndefined();
    expect(bridge.current()).toBeNull();
  });
});
