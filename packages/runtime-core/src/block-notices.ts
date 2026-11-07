import type { AssistantMessage } from '@earendil-works/pi-ai';
import { extractBlocks, validateMarkdownBlocks } from '@gitspace/protocol/gitspace-ui';

/** Issues one notice lists; the rest are counted. */
const LISTED_ISSUES = 8;
/** `validateMarkdownBlocks` prefixes each path of a one-block Markdown with this. */
const FIRST_BLOCK = 'block 1';

/**
 * The agent's notice for the ```gitspace-ui, ```svg and ```mermaid blocks of its message that do not validate, or null
 * when every block does. Blocks are numbered through the message's text parts in order, from 1; one line per block with
 * its issues, the first 8 issues listed and the rest counted.
 */
export function invalidBlocksNotice(content: AssistantMessage['content']): string | null {
  const issues: { block: number; path: string; message: string }[] = [];
  let block = 0;
  for (const part of content) {
    if (part.type !== 'text') continue;
    for (const found of extractBlocks(part.text)) {
      block++;
      for (const issue of validateMarkdownBlocks(part.text.slice(found.start, found.end))) issues.push({ block, path: issue.path.slice(FIRST_BLOCK.length), message: issue.message });
    }
  }
  if (issues.length === 0) return null;
  const listed = issues.slice(0, LISTED_ISSUES);
  const lines: string[] = [];
  for (const number of new Set(listed.map(issue => issue.block))) {
    const own = listed.filter(issue => issue.block === number).map(issue => issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`);
    lines.push(`Block ${number} in your last message is invalid: ${own.join('; ')}`);
  }
  const unlisted = issues.length - listed.length;
  if (unlisted > 0) lines.push(`…and ${unlisted} more ${unlisted === 1 ? 'issue' : 'issues'}.`);
  const invalid = new Set(issues.map(issue => issue.block)).size;
  lines.push(invalid === 1
    ? 'The chat shows an error in place of that block; send a corrected block in a new message.'
    : 'The chat shows an error in place of those blocks; send corrected blocks in a new message.');
  return lines.join('\n');
}
