import { describe, expect, it } from 'vitest';
import { segmentMagicKeywords } from './magic-keywords.js';

describe('magic keyword highlighting', () => {
  it('highlights only standalone lowercase OMP keywords', () => {
    expect(segmentMagicKeywords('please ultrathink and orchestrate this with workflowz')).toEqual([
      { text: 'please ' },
      { text: 'ultrathink', keyword: 'ultrathink' },
      { text: ' and ' },
      { text: 'orchestrate', keyword: 'orchestrate' },
      { text: ' this with ' },
      { text: 'workflowz', keyword: 'workflowz' },
    ]);
    expect(segmentMagicKeywords('Ultrathink workflowz.ts workflowzed')).toEqual([{ text: 'Ultrathink workflowz.ts workflowzed' }]);
  });
});
