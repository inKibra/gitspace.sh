#!/usr/bin/env bun
/**
 * Test potential workarounds for the ghostty-opentui tab bug
 *
 * Run: bun scripts/test-tabs-workaround.ts
 */

import { ptyToJson, PersistentTerminal } from 'ghostty-opentui';

console.log('=== Tab Bug Workaround Tests ===\n');

/**
 * Workaround 1: Expand tabs BEFORE feeding to ghostty
 * This is tricky because we'd need to track cursor position
 */
function expandTabs(input: string | Buffer, tabWidth: number = 8): Buffer {
  const str = typeof input === 'string' ? input : input.toString('utf-8');
  let result = '';
  let col = 0;

  for (const char of str) {
    if (char === '\t') {
      const spacesToNextTab = tabWidth - (col % tabWidth);
      result += ' '.repeat(spacesToNextTab);
      col += spacesToNextTab;
    } else if (char === '\n' || char === '\r') {
      result += char;
      col = 0;
    } else {
      result += char;
      col++;
    }
  }

  return Buffer.from(result);
}

// Test the workaround
const input = 'a\tb\tc';
const expanded = expandTabs(input);
console.log(`Workaround 1: Pre-expand tabs`);
console.log(`  Input:    "${input.replace(/\t/g, '\\t')}"`);
console.log(`  Expanded: "${expanded.toString()}"`);

const result = ptyToJson(expanded, { cols: 80, rows: 1 });
const spanText = result.lines[0]?.spans.map(s => s.text).join('') || '';
console.log(`  JSON spans: "${spanText}"`);
console.log(`  Length: ${spanText.length}`);
console.log(`  Spaces: ${(spanText.match(/ /g) || []).length}`);
console.log();

/**
 * Workaround 2: Post-process spans to restore spacing using width info
 * Each span has a 'width' field - we could use cursor positions
 */
console.log(`Workaround 2: Check if width field helps`);
const rawResult = ptyToJson('a\tb', { cols: 80, rows: 1 });
console.log(`  Spans: ${JSON.stringify(rawResult.lines[0]?.spans)}`);
console.log(`  Note: width only reflects the text, not the cell position`);
console.log();

/**
 * Workaround 3: Use ANSI cursor movement to fill with spaces?
 * Not really practical
 */

// Test with a more realistic ls-like output
console.log(`Test with ls-style input:`);
const lsInput = 'drwxr-xr-x\t24\tbradleat\tstaff\t768\tJan 12\tDocuments';
const lsExpanded = expandTabs(lsInput);
console.log(`  Input:    "${lsInput.replace(/\t/g, '\\t')}"`);
console.log(`  Expanded: "${lsExpanded.toString()}"`);

const lsResult = ptyToJson(lsExpanded, { cols: 120, rows: 1 });
const lsSpanText = lsResult.lines[0]?.spans.map(s => s.text).join('') || '';
console.log(`  JSON spans: "${lsSpanText}"`);
console.log();

// Test with PersistentTerminal
console.log(`Test with PersistentTerminal + pre-expanded tabs:`);
const term = new PersistentTerminal({ cols: 80, rows: 24 });
term.feed(expandTabs('file1.txt\tfile2.txt\tfile3.txt\r\n'));
const termData = term.getJson();
const termSpanText = termData.lines[0]?.spans.map(s => s.text).join('') || '';
console.log(`  JSON spans: "${termSpanText}"`);
console.log(`  Length: ${termSpanText.length}`);
console.log(`  getText(): "${term.getText().split('\n')[0]}"`);
term.destroy();
console.log();

console.log('=== Conclusion ===');
console.log('Workaround 1 (pre-expand tabs) works but requires tracking cursor position');
console.log('This is complex for full ANSI streams with cursor movements');
console.log('');
console.log('Better solution: Fix ghostty-opentui to emit spaces for null cells in spans');
