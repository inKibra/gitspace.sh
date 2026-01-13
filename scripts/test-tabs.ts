#!/usr/bin/env bun
/**
 * Test script to investigate tab/space rendering in ghostty-opentui
 *
 * Run with: bun scripts/test-tabs.ts
 */

import { ptyToJson, ptyToText, PersistentTerminal, hasPersistentTerminalSupport } from 'ghostty-opentui';

// ANSI escape codes for colors (to make output clearer)
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function visualizeWhitespace(str: string): string {
  return str
    .replace(/ /g, '·')  // Show spaces as middle dot
    .replace(/\t/g, '→\t'); // Show tabs with arrow
}

function hexDump(str: string): string {
  return [...str].map(c => {
    const code = c.charCodeAt(0);
    if (code === 32) return `${DIM}SP${RESET}`;
    if (code === 9) return `${RED}TAB${RESET}`;
    if (code < 32) return `${YELLOW}\\x${code.toString(16).padStart(2, '0')}${RESET}`;
    return c;
  }).join(' ');
}

console.log(`${CYAN}=== Ghostty-OpenTUI Tab/Space Test ===${RESET}\n`);
console.log(`Persistent terminal support: ${hasPersistentTerminalSupport() ? GREEN + 'YES' : RED + 'NO'}${RESET}\n`);

// Test 1: Simple tab character
console.log(`${YELLOW}Test 1: Simple tab character${RESET}`);
const test1Input = 'hello\tworld';
console.log(`Input (raw): "${test1Input}"`);
console.log(`Input (hex): ${hexDump(test1Input)}`);

const test1Result = ptyToJson(test1Input, { cols: 80, rows: 24 });
console.log(`Output lines: ${test1Result.lines.length}`);
for (const line of test1Result.lines) {
  for (const span of line.spans) {
    console.log(`  Span: "${visualizeWhitespace(span.text)}" (len=${span.text.length}, width=${span.width})`);
    console.log(`  Hex:  ${hexDump(span.text)}`);
  }
}
console.log();

// Test 2: Multiple tabs (like ls output)
console.log(`${YELLOW}Test 2: Multiple tabs (simulating ls -la style)${RESET}`);
const test2Input = 'drwxr-xr-x\t5\tuser\tstaff\t160\tJan 10 12:00\tDocuments';
console.log(`Input (raw): "${test2Input}"`);
console.log(`Input (hex): ${hexDump(test2Input)}`);

const test2Result = ptyToJson(test2Input, { cols: 120, rows: 24 });
console.log(`Output lines: ${test2Result.lines.length}`);
for (const line of test2Result.lines) {
  const fullText = line.spans.map(s => s.text).join('');
  console.log(`  Full line: "${visualizeWhitespace(fullText)}" (len=${fullText.length})`);
  console.log(`  Spans: ${line.spans.length}`);
  for (let i = 0; i < line.spans.length; i++) {
    const span = line.spans[i];
    console.log(`    [${i}] "${visualizeWhitespace(span.text)}" len=${span.text.length} width=${span.width}`);
  }
}
console.log();

// Test 3: Actual ls command output
console.log(`${YELLOW}Test 3: Actual ls command output${RESET}`);
const proc = Bun.spawnSync(['ls', '-la'], {
  cwd: process.cwd(),
  stdout: 'pipe',
  stderr: 'pipe',
});
const lsOutput = proc.stdout.toString();
console.log(`Raw ls output first 200 chars hex: ${hexDump(lsOutput.slice(0, 200))}`);
console.log();

const test3Result = ptyToJson(lsOutput, { cols: 120, rows: 50 });
console.log(`Processed ${test3Result.lines.length} lines from ls output`);
// Show first 5 lines
for (let i = 0; i < Math.min(5, test3Result.lines.length); i++) {
  const line = test3Result.lines[i];
  const fullText = line.spans.map(s => s.text).join('');
  console.log(`  Line ${i}: "${visualizeWhitespace(fullText.slice(0, 80))}..."`);
}
console.log();

// Test 4: Using PersistentTerminal (like the TUI does)
console.log(`${YELLOW}Test 4: PersistentTerminal (streaming mode)${RESET}`);
if (hasPersistentTerminalSupport()) {
  const term = new PersistentTerminal({ cols: 80, rows: 24 });

  // Feed tab-containing content
  term.feed('file1.txt\tfile2.txt\tfile3.txt\r\n');
  term.feed('another\trow\there\r\n');

  const data = term.getJson();
  console.log(`Lines: ${data.lines.length}`);
  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i];
    const fullText = line.spans.map(s => s.text).join('');
    console.log(`  Line ${i}: "${visualizeWhitespace(fullText)}" (len=${fullText.length})`);
    // Check for spaces
    const spaceCount = (fullText.match(/ /g) || []).length;
    const tabCount = (fullText.match(/\t/g) || []).length;
    console.log(`    Spaces: ${spaceCount}, Tabs: ${tabCount}`);
  }

  // Also get plain text
  const plainText = term.getText();
  console.log(`\n  Plain text output:`);
  console.log(`  "${visualizeWhitespace(plainText)}"`);

  term.destroy();
} else {
  console.log(`${RED}PersistentTerminal not available${RESET}`);
}
console.log();

// Test 5: Tab stops at different positions
console.log(`${YELLOW}Test 5: Tab stops at column positions${RESET}`);
// Tabs should align to columns 8, 16, 24, etc.
const tabTests = [
  'a\tb',        // 'a' at 0, tab to 8, 'b' at 8
  'ab\tc',       // 'ab' at 0-1, tab to 8, 'c' at 8
  'abcdefg\th',  // 'abcdefg' at 0-6, tab to 8, 'h' at 8
  'abcdefgh\ti', // 'abcdefgh' at 0-7, tab to 16, 'i' at 16
  '12345678\t9', // exactly 8 chars, tab to 16, '9' at 16
];

for (const input of tabTests) {
  const result = ptyToJson(input, { cols: 80, rows: 1 });
  const line = result.lines[0];
  const fullText = line.spans.map(s => s.text).join('');
  const expectedTabPos = Math.ceil((input.indexOf('\t') + 1) / 8) * 8;
  console.log(`  Input: "${input.replace('\t', '\\t')}" -> Output: "${visualizeWhitespace(fullText)}" (len=${fullText.length})`);
  console.log(`    Tab should expand to column ${expectedTabPos}, actual len after first word: ${fullText.indexOf(input.split('\t')[1])}`);
}
console.log();

// Test 6: ptyToText output (plain text extraction)
console.log(`${YELLOW}Test 6: ptyToText (strips ANSI, keeps spacing)${RESET}`);
const test6Input = '\x1b[32mgreen\x1b[0m\ttext\there';
console.log(`Input with ANSI: "${test6Input.replace(/\x1b/g, '\\e')}"`);
const test6Text = ptyToText(test6Input, { cols: 80, rows: 1 });
console.log(`ptyToText output: "${visualizeWhitespace(test6Text)}"`);
console.log(`Length: ${test6Text.length}`);
console.log();

// Summary
console.log(`${CYAN}=== Summary ===${RESET}`);
const summaryTest = ptyToJson('a\tb\tc', { cols: 80, rows: 1 });
const summaryText = summaryTest.lines[0]?.spans.map(s => s.text).join('') || '';
const hasSpaces = summaryText.includes(' ');
const hasTabs = summaryText.includes('\t');

if (hasSpaces && !hasTabs) {
  console.log(`${GREEN}✓ Tabs are being expanded to spaces correctly${RESET}`);
} else if (hasTabs) {
  console.log(`${RED}✗ Tabs are NOT being expanded (still literal \\t in output)${RESET}`);
} else if (!hasSpaces && !hasTabs) {
  console.log(`${RED}✗ Neither spaces nor tabs - whitespace is being stripped!${RESET}`);
}

console.log(`\nTest string "a\\tb\\tc" becomes: "${visualizeWhitespace(summaryText)}"`);
console.log(`Expected: "a·······b·······c" (with · representing spaces to tab stops)`);
