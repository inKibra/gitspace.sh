import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { textPage } from '@gitspace/runtime-workspace-do';
import { createDocumentMarkdown } from '../src/document-markdown.js';

const converted = (data: string) => [{ id: 'x', name: 'file', mimeType: 'application/pdf', format: 'markdown' as const, tokens: 1, data }];

describe('document Markdown', () => {
  it('converts a document once per content, and gives null for a file that is not a document', async () => {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`documents-${crypto.randomUUID()}`), async (_instance, state) => {
      const toMarkdown = vi.fn(async () => converted('# report.pdf\n## Metadata\n- PDFFormatVersion=1.4\n## Contents\n### Page 1\nRevenue was 42 million.\n'));
      const markdown = createDocumentMarkdown(state.storage, { toMarkdown } as unknown as Ai);
      const bytes = new TextEncoder().encode('%PDF-1.4 report');
      expect(await markdown('report.pdf', bytes)).toContain('Revenue was 42 million.');
      expect(await markdown('copy-of-report.pdf', new Uint8Array(bytes))).toContain('Revenue was 42 million.');
      expect(toMarkdown).toHaveBeenCalledOnce();
      expect(await markdown('notes.bin', bytes)).toBeNull();
    });
  });

  it('says a scanned document has no text layer instead of reading it as empty', async () => {
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`documents-${crypto.randomUUID()}`), async (_instance, state) => {
      const markdown = createDocumentMarkdown(state.storage, { toMarkdown: async () => converted('# scan.pdf\n## Metadata\n- PDFFormatVersion=1.4\n## Contents\n### Page 1\n\n\n### Page 2\n\n') } as unknown as Ai);
      await expect(markdown('scan.pdf', new TextEncoder().encode('%PDF-1.4 scan'))).rejects.toThrow('has no text layer');
    });
  });

  it('pages a long document within the tool output limit and names where the rest starts', () => {
    const text = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join('\n');
    const first = textPage(text);
    expect(first.split('\n')[1_999]).toBe('line 2000');
    expect(first).toContain('[500 more lines; read again with offset 2001]');
    expect(textPage(text, 2_001)).toBe(Array.from({ length: 500 }, (_, index) => `line ${index + 2_001}`).join('\n'));
    const wide = Array.from({ length: 2_000 }, (_, index) => `${'x'.repeat(99)}${index + 1}`).join('\n');
    const page = textPage(wide);
    expect(page.length).toBeLessThan(41_000);
    expect(page).toMatch(/\[\d+ more lines; read again with offset \d+\]$/u);
    expect(textPage(wide, 1, 2_000).split('\n')).toHaveLength(2_000);
  });
});
