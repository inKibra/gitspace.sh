import { expect, test } from 'vitest';
import type { TextContent } from '@earendil-works/pi-ai';
import { invalidBlocksNotice } from './block-notices.js';

const fence = '```';
const text = (value: string): TextContent => ({ type: 'text', text: value });
const emptyMermaid = `${fence}mermaid\n\n${fence}`;

test('an invalid block names its number, each failing path and message, and points at skill://gitspace-ui', () => {
  const spec = '{"root":"t","elements":{"t":{"type":"Text","props":{"text":"hi"},"children":["x"]}}}';
  expect(invalidBlocksNotice([text(`Status:\n${emptyMermaid}\nThen:\n${fence}gitspace-ui\n${spec}\n${fence}\n`)])).toBe([
    'Block 1 in your last message is invalid: the Mermaid source is empty',
    'Block 2 in your last message is invalid: /elements/t/children/0: no element "x" in elements; /elements/t/children: Text takes no children',
    'The chat shows an error in place of those blocks. Check the failing paths against skill://gitspace-ui and send corrected blocks in a new message.',
  ].join('\n'));
});

test('blocks are numbered through the message, and only invalid ones are named', () => {
  const svg = `${fence}svg\n<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>\n${fence}`;
  expect(invalidBlocksNotice([text(`Drawn:\n${svg}`), { type: 'toolCall', id: 'call', name: 'read', arguments: {} }, text(`And:\n${emptyMermaid}`)])).toBe([
    'Block 2 in your last message is invalid: the Mermaid source is empty',
    'The chat shows an error in place of that block. Check the failing paths against skill://gitspace-ui and send a corrected block in a new message.',
  ].join('\n'));
});

test('the first 8 issues are listed and the rest counted', () => {
  const notice = invalidBlocksNotice([text(Array.from({ length: 10 }, () => emptyMermaid).join('\n'))]);
  expect(notice?.split('\n')).toEqual([
    ...Array.from({ length: 8 }, (_, index) => `Block ${index + 1} in your last message is invalid: the Mermaid source is empty`),
    '…and 2 more issues.',
    'The chat shows an error in place of those blocks. Check the failing paths against skill://gitspace-ui and send corrected blocks in a new message.',
  ]);
});

test('a message whose blocks are valid, or that has none, gets no notice', () => {
  const spec = '{"root":"t","elements":{"t":{"type":"Text","props":{"text":"hi"},"children":[]}}}';
  expect(invalidBlocksNotice([text(`${fence}gitspace-ui\n${spec}\n${fence}\n${fence}mermaid\ngraph TD; A-->B\n${fence}`)])).toBeNull();
  expect(invalidBlocksNotice([text(`Plain reply with code:\n${fence}ts\nconst x = {"root":\n${fence}`)])).toBeNull();
  expect(invalidBlocksNotice([{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }])).toBeNull();
});
