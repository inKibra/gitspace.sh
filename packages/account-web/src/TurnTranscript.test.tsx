import type { TurnBlock } from '@gitspace/blocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnTranscript } from './TurnTranscript.js';

describe('TurnTranscript', () => {
  it('identifies the admitted Chrome for each persisted relay action', () => {
    const turns: TurnBlock[] = [{
      id: 'chrome-turn', type: 'turn', status: 'done', sideAgents: [],
      items: [
        { id: 'a', type: 'tool-call', toolCallId: 'a', tool: 'browser', status: 'done', details: { browser: { pairingId: '00000000-0000-4000-8000-000000000001', name: 'Staging admin Chrome' } } },
        { id: 'b', type: 'tool-call', toolCallId: 'b', tool: 'browser', status: 'done', details: { browser: { pairingId: '00000000-0000-4000-8000-000000000002', name: 'Customer account Chrome' } } },
      ],
    }];
    const html = renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />);
    expect(html).toContain('Staging admin Chrome');
    expect(html).toContain('Customer account Chrome');
  });
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
  it('shows the tabs a sent message connected as chips of their site and Chrome, not as the text the agent reads', () => {
    const turns: TurnBlock[] = [{
      id: 'turn-tab', type: 'turn', status: 'done', sideAgents: [], items: [],
      user: { id: 'turn-tab:user', type: 'message', role: 'user', text: '[Connected tab "Hacker News" (https://news.ycombinator.com/item?id=1) on Studio desktop, pairingId 00000000-0000-4000-8000-000000000001, targetId tab-a; use web_browser with source "relay" and this pairingId]\nCan you summarise the top comments?' },
    }];
    const html = renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />);
    expect(html).toContain('news.ycombinator.com</strong>');
    expect(html).toContain('· Studio desktop');
    expect(html).toContain('Can you summarise the top comments?');
    expect(html).not.toContain('Connected tab');
  });
  it('shows the captures a sent message mentions as chips, not the summaries the workspace added for the agent', () => {
    const captureId = '6f0c2a7e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
    const turns: TurnBlock[] = [{
      id: 'turn-capture', type: 'turn', status: 'done', sideAgents: [], items: [],
      user: { id: 'turn-capture:user', type: 'message', role: 'user', text: `capture://${captureId}\nMake a skill of it\n\n<capture-summary id="${captureId}" name="Order a &quot;large&quot; pizza">\nSteps (number, time on the capture, what):\n3. 0:02 fill getByLabel('Password') «secret»\n</capture-summary>` },
    }];
    const html = renderToStaticMarkup(<TurnTranscript turns={turns} transport={[]} />);
    expect(html).toContain('Order a &quot;large&quot; pizza</strong>');
    expect(html).toContain('Make a skill of it');
    expect(html).not.toContain('getByLabel');
    expect(html).not.toContain('capture://');
  });
});
