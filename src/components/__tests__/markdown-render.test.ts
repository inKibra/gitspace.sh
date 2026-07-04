/**
 * renderMarkdownHtml — focused on GFM table support (added for chat) plus a few
 * sanity checks that existing block handling still works.
 */
import { describe, expect, it } from 'bun:test';
import { renderMarkdownHtml } from '../markdown-render.js';

describe('renderMarkdownHtml tables', () => {
  const table = [
    '| Name | Count |',
    '|:-----|------:|',
    '| a | 1 |',
    '| b | 2 |',
  ].join('\n');

  it('renders a GFM table with header + body rows', () => {
    const html = renderMarkdownHtml(table);
    expect(html).toContain('<table');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th');
    expect(html).toContain('Name');
    expect(html).toContain('Count');
    expect((html.match(/<tr>/g) ?? []).length).toBe(3); // 1 header + 2 body
    expect((html.match(/<td/g) ?? []).length).toBe(4); // 2 cols × 2 rows
  });

  it('honors column alignment from the separator row', () => {
    const html = renderMarkdownHtml(table);
    expect(html).toContain('text-align:left'); // :-----
    expect(html).toContain('text-align:right'); // ------:
  });

  it('applies configured table classes', () => {
    const html = renderMarkdownHtml(table, {
      tableClassName: 'tbl',
      tableHeadCellClassName: 'th',
      tableCellClassName: 'td',
    });
    expect(html).toContain('<table class="tbl"');
    expect(html).toContain('<th class="th"');
    expect(html).toContain('<td class="td"');
  });

  it('inline formatting works inside cells', () => {
    const html = renderMarkdownHtml('| A | B |\n|--|--|\n| **bold** | `code` |');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code');
  });

  it('a lone pipe line without a separator is NOT a table', () => {
    const html = renderMarkdownHtml('this | that is just prose');
    expect(html).not.toContain('<table');
    expect(html).toContain('<p');
  });

  it('pads short rows to the header column count', () => {
    const html = renderMarkdownHtml('| A | B | C |\n|--|--|--|\n| only-one |');
    expect((html.match(/<td/g) ?? []).length).toBe(3); // padded to 3 columns
  });
});
