// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planQuestions, type AskBlock } from '@gitspace/blocks';
import { AskBlockView } from './TurnTranscript.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

function render(item: AskBlock): void { act(() => root.render(<AskBlockView item={item} />)); }
function row(text: string): Element {
  const found = [...container.querySelectorAll('li')].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`No row ${text}`);
  return found;
}

describe('an answered ask', () => {
  it('stays as its card, read only: the options picked are marked, written answers shown, a skipped question says so', () => {
    render({ id: 'ask-1', type: 'ask', toolCallId: 'ask-1', status: 'answered', questions: [
      { id: 'runtime', prompt: 'Choose a runtime', options: [{ id: 'Bun', title: 'Bun' }, { id: 'Node', title: 'Node' }], answer: 'Bun' },
      { id: 'checks', prompt: 'Which checks?', multiple: true, options: [{ id: 'Types', title: 'Types' }], answer: ['Types', 'Browser smoke'] },
      { id: 'anything', prompt: 'Anything else?' },
    ] });
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Questions, answered');
    expect(row('Bun').querySelector('[aria-label="Chosen"]')).not.toBeNull();
    expect(row('Node').querySelector('[aria-label="Chosen"]')).toBeNull();
    expect(row('Types').querySelector('[aria-label="Chosen"]')).not.toBeNull();
    expect(row('Browser smoke').querySelector('[aria-label="Chosen"]')).not.toBeNull();
    expect(row('Skipped')).toBeDefined();
    expect(container.querySelector('textarea, input, button')).toBeNull();
  });

  it('shows a plan with its decision and note, and leaves out a note that was skipped', () => {
    const questions = planQuestions('## Streaks\n\nMark a day per completed session.');
    render({ id: 'plan', type: 'ask', kind: 'plan', toolCallId: 'plan', status: 'answered', questions: questions.map((question) => question.id === 'decision' ? { ...question, answer: 'Reject' } : { ...question, answer: 'Keep the badge behind the flag.' }) });
    expect(container.textContent).toContain('Plan approval · answered');
    expect(container.textContent).toContain('Rejected');
    expect(container.querySelector('h2')?.textContent).toBe('Streaks');
    expect(row('Reject').querySelector('[aria-label="Chosen"]')).not.toBeNull();
    expect(row('Approve').querySelector('[aria-label="Chosen"]')).toBeNull();
    expect(row('Keep the badge behind the flag.').querySelector('[aria-label="Chosen"]')).not.toBeNull();

    render({ id: 'plan', type: 'ask', kind: 'plan', toolCallId: 'plan', status: 'answered', questions: questions.map((question) => question.id === 'decision' ? { ...question, answer: 'Approve' } : question) });
    expect(container.textContent).toContain('Approved');
    expect(container.textContent).not.toContain('Anything to add?');
  });
});
