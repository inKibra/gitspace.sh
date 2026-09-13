import type { TurnBlock } from '@gitspace/blocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnTranscript } from './TurnTranscript.js';

describe('TurnTranscript', () => {
  it('renders persisted user and tool image attachments', () => {
    const turns: TurnBlock[] = [{
      id: 'turn-1',
      type: 'turn',
      status: 'done',
      user: {
        id: 'turn-1:user',
        type: 'message',
        role: 'user',
        text: 'Inspect this image.',
        images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
      },
      items: [{
        id: 'turn-1:tool:read-1',
        type: 'tool-call',
        toolCallId: 'read-1',
        tool: 'read',
        target: 'screenshot.png',
        status: 'done',
        result: [{
          id: 'turn-1:tool:read-1:image:0',
          type: 'image',
          url: 'data:image/webp;base64,dG9vbA==',
          alt: 'Tool output image 1',
        }],
      }],
      sideAgents: [],
    }];

    const html = renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />);

    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(html).toContain('src="data:image/webp;base64,dG9vbA=="');
  });

  it('keeps completed thinking as a collapsed transcript block', () => {
    const turn = (status: TurnBlock['status']): TurnBlock => ({
      id: `turn-${status}`,
      type: 'turn',
      status,
      items: [{ id: `thinking-${status}`, type: 'thinking', text: 'Reasoning retained after reload.' }],
      sideAgents: [],
    });

    const completed = renderToStaticMarkup(<TurnTranscript turns={[turn('done')]} transport={[]} />);
    expect(completed).toContain('Reasoning retained after reload.');
    expect(completed).toContain('aria-expanded="false"');

    const running = renderToStaticMarkup(<TurnTranscript turns={[turn('running')]} transport={[]} />);
    expect(running).toContain('Reasoning');
    expect(running).toContain('reload.');
    expect(running).toContain('aria-expanded="true"');
    expect(running).toContain('role="status"');
  });

  it('renders the submitted answer beside every completed ask question', () => {
    const turns: TurnBlock[] = [{
      id: 'turn-ask',
      type: 'turn',
      status: 'done',
      items: [{
        id: 'ask-1',
        type: 'ask',
        toolCallId: 'ask-1',
        status: 'answered',
        questions: [
          { id: 'runtime', prompt: 'Choose a runtime', answer: 'Bun' },
          { id: 'checks', prompt: 'Which checks?', multiple: true, answer: ['Types', 'Browser'] },
          { id: 'optional', prompt: 'Anything else?' },
        ],
      }],
      sideAgents: [],
    }];

    const html = renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />);

    expect(html).toContain('Choose a runtime — Bun');
    expect(html).toContain('Which checks? — Types, Browser');
    expect(html).toContain('Anything else? — Skipped');
  });
});
