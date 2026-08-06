/**
 * Pull harness-injected `<system-reminder>` blocks out of transcript text.
 *
 * A rule activation arrives as an EXTRA text part on a `toolResult` message,
 * ahead of the tool's real output:
 *
 *   <system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="…">
 *   A user-defined rule matched this tool call's arguments. …
 *   </system-reminder>
 *
 * Rendered as-is it is escaped into a paragraph of literal XML buried in the
 * collapsed tool output, so the rule name — the only part worth scanning for —
 * survives only as text inside an attribute. Extracting it here lets the
 * transcript attribute it properly instead of showing the agent quoting angle
 * brackets at itself.
 *
 * Only reminders carrying a `rule` attribute are extracted. Other system
 * reminders stay in the text: they are prose addressed to the agent, and
 * silently swallowing them would hide context a reader may need.
 */

export interface ExtractedRuleActivation {
  rule: string;
  reason?: string;
  path?: string;
  body: string;
}

export interface ExtractedReminders {
  activations: ExtractedRuleActivation[];
  /** The input with the extracted reminders removed. */
  rest: string;
}

const REMINDER_PATTERN = /<system-reminder\b([^>]*)>([\s\S]*?)<\/system-reminder>/g;
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/g;

export function extractRuleActivations(text: string): ExtractedReminders {
  // Cheap bail-out: the overwhelming majority of tool output has no reminder,
  // and this runs over every result block on every transcript render.
  if (!text.includes('<system-reminder')) return { activations: [], rest: text };

  const activations: ExtractedRuleActivation[] = [];
  const rest = text.replace(REMINDER_PATTERN, (match, rawAttributes: string, body: string) => {
    const attributes: Record<string, string> = {};
    for (const [, name, value] of rawAttributes.matchAll(ATTRIBUTE_PATTERN)) {
      attributes[name!] = value!;
    }
    const rule = attributes.rule;
    if (rule === undefined || rule === '') return match;
    activations.push({
      rule,
      reason: attributes.reason,
      path: attributes.path,
      body: body.trim(),
    });
    return '';
  });

  return { activations, rest: activations.length > 0 ? rest.trim() : text };
}
