# ghostty-opentui Tab/Space Bug Report

## Summary

`ptyToJson()` and `getJson()` span output strips spaces from tab expansion, while `ptyToText()` and `getText()` work correctly.

## Reproduction

```typescript
import { ptyToJson, ptyToText } from 'ghostty-opentui';

const input = 'a\tb\tc';  // 'a', tab, 'b', tab, 'c'

// ❌ BROKEN: spans have no spaces
const jsonOutput = ptyToJson(input, { cols: 80, rows: 1 });
const spanText = jsonOutput.lines[0]?.spans.map(s => s.text).join('');
console.log(spanText);  // "abc" - missing 14 spaces!

// ✅ WORKS: text has correct spacing
const textOutput = ptyToText(input, { cols: 80, rows: 1 });
console.log(textOutput);  // "a       b       c" - correct!
```

## Expected vs Actual

| Function | Expected Output | Actual Output |
|----------|-----------------|---------------|
| `ptyToText()` | `"a       b       c"` (17 chars) | ✅ `"a       b       c"` |
| `getText()` | `"a       b       c"` (17 chars) | ✅ `"a       b       c"` |
| `ptyToJson()` spans | `"a       b       c"` (17 chars) | ❌ `"abc"` (3 chars) |
| `getJson()` spans | `"a       b       c"` (17 chars) | ❌ `"abc"` (3 chars) |

## Root Cause

In `lib.zig` around line 192-212, the span extraction code skips cells with codepoint 0:

```zig
const cp = cell.codepoint();
const is_null = cp == 0;

if (is_null) {
    // Flush current span if any...
    current_style = null;
    continue;  // <-- BUG: Skips cell entirely!
}
```

When tabs are processed, the terminal moves the cursor but cells in between remain as "null" (codepoint 0). These should be output as space characters in spans, but they're skipped entirely.

Meanwhile, `ptyToText()` uses Ghostty's built-in `TerminalFormatter` with `.plain` format, which correctly handles null cells by outputting spaces.

## Impact

This bug affects any TUI application using `ghostty-opentui` for terminal rendering:
- `ls` output has no column spacing
- Any tab-separated content appears concatenated
- Tab-based alignment is completely broken

## Suggested Fix

In the span extraction code, treat null codepoints (0) as space characters (32) within the active rendering area:

```zig
if (is_null) {
    // Instead of skipping, treat as space
    const style = getStyleFromCell(cell, pin, palette, terminal_bg);
    // ... add space character to current span ...
}
```

Or alternatively, emit a span of spaces when encountering consecutive null cells.

## Test Script

Run: `bun scripts/test-tabs-minimal.ts`

## Workaround

Pre-expand tabs before feeding to ghostty (only works for controlled input, not real PTY streams):

```typescript
function expandTabs(input: string, tabWidth = 8): string {
  let result = '', col = 0;
  for (const char of input) {
    if (char === '\t') {
      const spaces = tabWidth - (col % tabWidth);
      result += ' '.repeat(spaces);
      col += spaces;
    } else if (char === '\n' || char === '\r') {
      result += char;
      col = 0;
    } else {
      result += char;
      col++;
    }
  }
  return result;
}
```

## Environment

- ghostty-opentui: 1.3.11
- @opentui/core: 0.1.72
- bun: 1.3.5
- macOS Darwin 25.1.0
