import { expect, it } from 'vitest';
import { userMessageMarkdown } from './TurnTranscript.js';

it('links an uploaded attachment to its drive file and fences an inline text attachment', () => {
  const message = [
    'Please review these.',
    '<attachment name="report [final].pdf" url="drive://workspace/uploads/report%20%5Bfinal%5D.pdf" type="application/pdf" size="2313" />',
    '<attachment name="notes.txt">\nfirst\n~~~\nlast\n</attachment>',
  ].join('\n\n');
  expect(userMessageMarkdown(message)).toBe([
    'Please review these.',
    '📎 [report \\[final\\].pdf](drive://workspace/uploads/report%20%5Bfinal%5D.pdf)',
    '📎 **notes.txt**\n\n~~~~\nfirst\n~~~\nlast\n~~~~',
  ].join('\n\n'));
});
