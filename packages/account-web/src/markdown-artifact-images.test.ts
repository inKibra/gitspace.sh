import { describe, expect, it } from 'vitest';
import { artifactImageUrl, markdownImageSources } from './markdown-artifact-images.js';

describe('artifact image references', () => {
  it('resolves relative, parent, and absolute artifact paths against the Markdown artifact', () => {
    const document = 'local://workspace/plans/accounts-plan.md';
    expect(artifactImageUrl('accounts.svg', document)).toBe('local://workspace/plans/accounts.svg');
    expect(artifactImageUrl('./diagrams/accounts%20v2.svg', document)).toBe('local://workspace/plans/diagrams/accounts v2.svg');
    expect(artifactImageUrl('../accounts.png', document)).toBe('local://workspace/accounts.png');
    expect(artifactImageUrl('local://base/shared.png', document)).toBe('local://base/shared.png');
  });

  it('leaves web, data, protocol-relative, and anchor sources to normal hardening', () => {
    const document = 'local://workspace/plan.md';
    for (const src of ['https://example.com/a.png', 'data:image/png;base64,AA', '//example.com/a.png', '#figure']) {
      expect(artifactImageUrl(src, document)).toBeNull();
    }
  });

  it('finds Markdown and inline HTML image sources once each', () => {
    expect(markdownImageSources('![a](one.png) ![b](<two.svg>) <img alt="c" src="three.png"> ![again](one.png)')).toEqual(['one.png', 'two.svg', 'three.png']);
  });
});
