import { expect, it } from 'vitest';
import { userMessageMarkdown } from './RichContent.js';

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

it('shows a staged choice as its line alone and keeps a JSON block the person wrote', () => {
  const message = [
    'It already runs in production',
    'Decided: Postgres (Storage engine)\n~~~json\n{\n  "rationale": "fewer moving parts"\n}\n~~~\nAnswered: Weekly (How often?)\n~~~json\n{\n  "questionId": "cadence",\n  "answer": "weekly"\n}\n~~~',
    'My own config:\n~~~json\n{ "retries": 2 }\n~~~',
  ].join('\n\n');
  expect(userMessageMarkdown(message)).toBe([
    'It already runs in production',
    'Decided: Postgres (Storage engine)\nAnswered: Weekly (How often?)',
    'My own config:\n~~~json\n{ "retries": 2 }\n~~~',
  ].join('\n\n'));
});
