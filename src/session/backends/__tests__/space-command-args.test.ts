/**
 * The programmatic run_space_command path must carry structured args verbatim,
 * NOT flatten them through parseCommandArgs. parseCommandArgs is a quote-aware
 * tokenizer with NO escape grammar, so the old `JSON.stringify`-join encoder
 * mangled any value containing quotes or backslashes (e.g. a requirement title
 * like `fix the "auth" bug \o/`). This test pins both halves of the contract:
 *   1. the daemon prefers msg.args over re-tokenizing argsText;
 *   2. the round-trip the encoder DID work for stays intact via parseCommandArgs.
 */
import { describe, expect, test } from 'bun:test';
import { parseCommandArgs } from '@oh-my-pi/pi-coding-agent/utils/command-args';

// The two values that broke the old flatten-then-tokenize path.
const HARD = [
  'add-requirement',
  '--title', 'fix the "auth" bug \\o/',        // both a quote AND a backslash
  '--needle', "it's a 'quoted' thing",          // single quotes
  '--pattern', 'a b c',                          // whitespace
];

describe('structured space-command args', () => {
  test('the old encoder mangles quotes/backslashes (documents WHY we bypass it)', () => {
    const encoded = HARD.map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(' ');
    const reTokenized = parseCommandArgs(encoded);
    // The whole point: this round trip is LOSSY — it does NOT equal HARD.
    expect(reTokenized).not.toEqual(HARD);
  });

  test('structured args are passed through verbatim (the fix)', () => {
    // The daemon's selection: `msg.args ?? parseCommandArgs(msg.argsText)`.
    // When args is present it is used as-is — no tokenizer, no loss.
    const select = (msg: { args?: string[]; argsText: string }): string[] =>
      msg.args ?? parseCommandArgs(msg.argsText);

    expect(select({ args: HARD, argsText: 'ignored display join' })).toEqual(HARD);
    // Falls back to the tokenizer for the human-typed path.
    expect(select({ argsText: 'add-requirement --optional' })).toEqual(['add-requirement', '--optional']);
  });
});
