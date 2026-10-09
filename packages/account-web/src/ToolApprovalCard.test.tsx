// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolApprovalCard } from './ToolApprovalCard.js';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function button(label: string) { const result = [...container.querySelectorAll('button')].find(item => item.textContent === label); if (!result) throw new Error(`Missing ${label}`); return result; }
const content = 'import json\n\ndef load(path):\n    return json.loads(open(path).read())\n';

it('renders a write as its path and line count with the content collapsed instead of escaped JSON', async () => {
  await act(() => root.render(<ToolApprovalCard tool={{ name: 'write', args: { path: 'pantry.py', content } }} machines={[]} connected onAnswer={async () => {}} />));
  expect(container.querySelector('h2')?.textContent).toBe('Write pantry.py');
  expect(container.textContent).toContain('4 lines');
  const preview = container.querySelector('details');
  expect(preview?.open).toBe(false);
  expect(preview?.querySelector('summary')?.textContent).toContain('Show content');
  expect(preview?.textContent).toContain('def load(path):');
  expect(container.textContent).not.toContain('"content"');
  expect(container.textContent).not.toContain('\\n');
});

it('renders a bash command in a code block with its directory and machine', async () => {
  await act(() => root.render(<ToolApprovalCard tool={{ name: 'bash', args: { command: 'python3 -m unittest -v', cwd: 'services/api', on: 'machine-1' } }} machines={[{ id: 'machine-1', label: 'Studio workstation' }]} connected onAnswer={async () => {}} />));
  expect(container.querySelector('h2')?.textContent).toBe('Run command');
  expect(container.querySelector('pre')?.textContent).toContain('python3 -m unittest -v');
  expect(container.textContent).toContain('services/api');
  expect(container.textContent).toContain('Studio workstation');
  expect(container.textContent).not.toContain('{"command"');
});

it('renders an apply_patch as an edit of the patched paths with the patch as a diff', async () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+export {};\n*** End Patch';
  await act(() => root.render(<ToolApprovalCard tool={{ name: 'apply_patch', args: { patch } }} machines={[]} connected onAnswer={async () => {}} />));
  expect(container.querySelector('h2')?.textContent).toBe('Edit src/a.ts, src/b.ts');
  expect(container.querySelector('pre')?.textContent).toContain('+new');
});

it('falls back to the tool name with collapsed pretty-printed arguments for other tools', async () => {
  await act(() => root.render(<ToolApprovalCard tool={{ name: 'environment', args: { method: 'put', key: 'A' } }} machines={[]} connected onAnswer={async () => {}} />));
  expect(container.querySelector('h2')?.textContent).toBe('Use environment');
  const details = container.querySelector('details');
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain('"method": "put"');
});

it('answers Approve as true and Reject as false from buttons and the 1/2 shortcuts', async () => {
  const answer = vi.fn(async (_approved: boolean) => {});
  await act(() => root.render(<ToolApprovalCard tool={{ name: 'bash', args: { command: 'pwd' } }} machines={[]} connected onAnswer={answer} />));
  await act(() => button('Approve').click());
  await act(() => button('Reject').click());
  await act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); });
  await act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })); });
  const input = document.createElement('textarea');
  document.body.append(input);
  await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); });
  input.remove();
  expect(answer.mock.calls).toEqual([[true], [false], [true], [false]]);
});

it('blocks answers while disconnected and surfaces a failed answer for retry', async () => {
  const answer = vi.fn(async (_approved: boolean): Promise<void> => { throw new Error('Approval service unavailable'); });
  const tool = { name: 'write', args: { path: 'a.txt', content: 'a' } };
  await act(() => root.render(<ToolApprovalCard tool={tool} machines={[]} connected={false} onAnswer={answer} />));
  expect(button('Approve').disabled).toBe(true);
  expect(button('Reject').disabled).toBe(true);
  await act(() => root.render(<ToolApprovalCard tool={tool} machines={[]} connected onAnswer={answer} />));
  await act(() => button('Approve').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Approval service unavailable');
  expect(button('Approve').disabled).toBe(false);
});
