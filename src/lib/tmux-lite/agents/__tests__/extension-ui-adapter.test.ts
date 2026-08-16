import { describe, expect, it, mock } from 'bun:test';
import { createExtensionUIContext } from '../extension-ui-adapter.js';
import type { OmpHostUIContext } from '../omp-types.js';

function makeBridge(): OmpHostUIContext & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, ...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };

  return {
    calls,
    select: async (title, options, dialogOptions) => {
      record('select', title, options, dialogOptions);
      return 'chosen';
    },
    askForm: async () => undefined,
    confirm: async (title, message, dialogOptions) => {
      record('confirm', title, message, dialogOptions);
      return true;
    },
    input: async (title, placeholder, dialogOptions) => {
      record('input', title, placeholder, dialogOptions);
      return 'typed';
    },
    notify: (message, type) => record('notify', message, type),
    setStatus: (key, text) => record('setStatus', key, text),
    setWorkingMessage: (message) => record('setWorkingMessage', message),
    setWidget: (key, content) => record('setWidget', key, content),
    setEditorText: (text) => record('setEditorText', text),
    pasteToEditor: (text) => record('pasteToEditor', text),
    getEditorText: () => {
      record('getEditorText');
      return 'editor contents';
    },
    editor: async (title, prefill) => {
      record('editor', title, prefill);
      return 'edited';
    },
    setTitle: (title) => record('setTitle', title),
  };
}

describe('createExtensionUIContext', () => {
  it('degrades safely when no client UI is attached', async () => {
    const context = createExtensionUIContext(() => null);

    expect(await context.select('Pick', [{ label: 'A' }])).toBeUndefined();
    expect(await context.input('Name', 'placeholder')).toBeUndefined();
    expect(await context.editor('Edit', 'prefill')).toBeUndefined();
    expect(await context.confirm('Continue?', 'Proceed')).toBe(false);
    expect(context.getEditorText()).toBe('');

    expect(() => {
      context.notify('hello', 'info');
      context.setStatus('status', 'working');
      context.setWorkingMessage('working');
      context.setWidget('widget', ['line']);
      context.setTitle('title');
      context.setEditorText('text');
      context.pasteToEditor('paste');
    }).not.toThrow();
  });

  it('forwards calls through a late-bound bridge and preserves widget content rules', async () => {
    let delegate: OmpHostUIContext | null = null;
    const context = createExtensionUIContext(() => delegate);
    const bridge = makeBridge();
    const dialogOptions = { helpText: 'answer' };

    delegate = bridge;

    expect(await context.select('Pick', [{ label: 'A', description: 'first' }], dialogOptions)).toBe('chosen');
    expect(await context.confirm('Continue?', 'Proceed', dialogOptions)).toBe(true);
    expect(await context.input('Name', 'placeholder', dialogOptions)).toBe('typed');
    expect(await context.editor('Edit', 'prefill')).toBe('edited');
    context.notify('hello', 'warning');
    context.setStatus('status', undefined);
    context.setWorkingMessage();
    context.setTitle('title');
    context.setEditorText('text');
    context.pasteToEditor('paste');
    expect(context.getEditorText()).toBe('editor contents');

    context.setWidget('lines', ['one', 'two']);
    context.setWidget('component', (() => undefined) as never);

    expect(bridge.calls.select).toEqual([['Pick', [{ label: 'A', description: 'first' }], dialogOptions]]);
    expect(bridge.calls.confirm).toEqual([['Continue?', 'Proceed', dialogOptions]]);
    expect(bridge.calls.input).toEqual([['Name', 'placeholder', dialogOptions]]);
    expect(bridge.calls.editor).toEqual([['Edit', 'prefill']]);
    expect(bridge.calls.notify).toEqual([['hello', 'warning']]);
    expect(bridge.calls.setStatus).toEqual([['status', undefined]]);
    expect(bridge.calls.setWorkingMessage).toEqual([[undefined]]);
    expect(bridge.calls.setTitle).toEqual([['title']]);
    expect(bridge.calls.setEditorText).toEqual([['text']]);
    expect(bridge.calls.pasteToEditor).toEqual([['paste']]);
    expect(bridge.calls.getEditorText).toEqual([[]]);
    expect(bridge.calls.setWidget).toEqual([
      ['lines', ['one', 'two']],
      ['component', undefined],
    ]);
  });

  it('rejects custom terminal components instead of waiting forever', async () => {
    const context = createExtensionUIContext(() => null);

    await expect(context.custom(() => undefined as never)).rejects.toThrow(
      'Extension custom UI components require a terminal',
    );
  });

  it('returns a callable no-op unsubscribe for terminal input handlers', () => {
    const context = createExtensionUIContext(() => null);

    const unsubscribe = context.onTerminalInput(mock((data: string) => {
      void data;
      return undefined;
    }));

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
