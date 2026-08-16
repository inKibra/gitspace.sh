import { describe, expect, it } from 'bun:test';
import { extractRuleActivations } from '../system-reminder.js';

// Verbatim shape from a real session file: the reminder is an extra text part
// the harness puts AHEAD of the tool's own output.
const REAL = `<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions.md">
A user-defined rule matched this tool call's arguments. The tool ran because the rule is configured not to interrupt.

## Why

- One-line wrappers hide no real behavior.
</system-reminder>
[file.ts#AD30]
15:import { thing } from './thing.js';`;

describe('extractRuleActivations', () => {
  it('lifts a rule activation out and leaves the tool output behind', () => {
    const { activations, rest } = extractRuleActivations(REAL);

    expect(activations).toHaveLength(1);
    expect(activations[0]!.rule).toBe('ts-no-tiny-functions');
    expect(activations[0]!.reason).toBe('rule_violation');
    expect(activations[0]!.path).toBe('builtin-defaults:ts-no-tiny-functions.md');
    expect(activations[0]!.body).toContain('One-line wrappers hide no real behavior.');
    // The real output survives, and no XML debris is left in it.
    expect(rest).toBe("[file.ts#AD30]\n15:import { thing } from './thing.js';");
    expect(rest).not.toContain('system-reminder');
  });

  it('extracts every activation when a call trips more than one rule', () => {
    const { activations, rest } = extractRuleActivations(
      '<system-reminder rule="a">first</system-reminder>output<system-reminder rule="b">second</system-reminder>',
    );

    expect(activations.map((a) => a.rule)).toEqual(['a', 'b']);
    expect(rest).toBe('output');
  });

  it('leaves non-rule system reminders in the text', () => {
    // These are prose addressed to the agent, not rule activations. Swallowing
    // them would silently drop context a reader may need.
    const text = '<system-reminder>Your todo list is empty.</system-reminder>';
    const { activations, rest } = extractRuleActivations(text);

    expect(activations).toEqual([]);
    expect(rest).toBe(text);
  });

  it('returns ordinary output untouched', () => {
    const { activations, rest } = extractRuleActivations('a.ts\nb.ts');

    expect(activations).toEqual([]);
    expect(rest).toBe('a.ts\nb.ts');
  });

  it('does not mangle output that merely mentions the tag', () => {
    // A grep hit or a doc quoting the tag has no closing tag to match; the text
    // must survive byte-for-byte rather than being partly eaten.
    const text = 'the harness emits <system-reminder ...> around rules';
    const { activations, rest } = extractRuleActivations(text);

    expect(activations).toEqual([]);
    expect(rest).toBe(text);
  });

  it('marks a system-interrupt as interrupted, and a reminder as not', () => {
    // Verbatim wrapper from a persisted ttsr-injection custom_message. The two
    // tags are different events: an interrupt means generation was aborted and
    // retried, a reminder just rides along with a tool result.
    const { activations } = extractRuleActivations(
      '<system-interrupt reason="rule_violation" rule="ts-no-return-type" path="builtin-defaults:ts-no-return-type.md">\nYour output was interrupted by a rule.\n</system-interrupt>',
    );

    expect(activations).toHaveLength(1);
    expect(activations[0]!.rule).toBe('ts-no-return-type');
    expect(activations[0]!.interrupted).toBe(true);

    const advisory = extractRuleActivations('<system-reminder rule="a">body</system-reminder>');
    expect(advisory.activations[0]!.interrupted).toBe(false);
  });

  it('does not pair mismatched open and close tags', () => {
    // The two wrappers are distinct; treating </system-interrupt> as a valid
    // close for <system-reminder> would swallow arbitrary text between them.
    const text = '<system-reminder rule="a">body</system-interrupt>';
    const { activations, rest } = extractRuleActivations(text);

    expect(activations).toEqual([]);
    expect(rest).toBe(text);
  });
});
