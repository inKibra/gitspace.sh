/**
 * Pull harness-injected TTSR (Time Traveling Stream Rules) activations out of
 * transcript text. See omp://ttsr-injection-lifecycle.md.
 *
 * A rule reaches the transcript through one of two wrappers, and they mean
 * materially different things:
 *
 *   <system-reminder reason="rule_violation" rule="…" path="…">   advisory
 *   <system-interrupt reason="rule_violation" rule="…" path="…">  interrupted
 *
 * `system-reminder` is a NON-interrupting match: the harness prepends it as an
 * extra leading text part on the matched tool's `toolResult`, ahead of the
 * tool's own output, and the turn continues. `system-interrupt` is the harsher
 * path: generation was aborted mid-stream and retried, and the wrapper arrives
 * in a hidden `custom_message` (`customType: "ttsr-injection"`).
 *
 * Rendered as-is either one is escaped into a paragraph of literal XML, so the
 * rule name — the only part worth scanning for — survives only as text inside
 * an attribute. Extracting them here lets the transcript attribute them
 * properly instead of showing the agent quoting angle brackets at itself.
 *
 * Only wrappers carrying a `rule` attribute are extracted. Other system
 * reminders stay in the text: they are prose addressed to the agent, and
 * silently swallowing them would hide context a reader may need.
 */

export interface ExtractedRuleActivation {
  rule: string;
  reason?: string;
  path?: string;
  body: string;
  /** True when generation was aborted and retried, not merely advised. */
  interrupted: boolean;
}

export interface ExtractedReminders {
  activations: ExtractedRuleActivation[];
  /** The input with the extracted wrappers removed. */
  rest: string;
}

const ACTIVATION_PATTERN = /<system-(reminder|interrupt)\b([^>]*)>([\s\S]*?)<\/system-\1>/g;
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/g;

export function extractRuleActivations(text: string): ExtractedReminders {
  // Cheap bail-out: the overwhelming majority of tool output carries no
  // activation, and this runs over every result block on every render.
  if (!text.includes('<system-reminder') && !text.includes('<system-interrupt')) {
    return { activations: [], rest: text };
  }

  const activations: ExtractedRuleActivation[] = [];
  const rest = text.replace(ACTIVATION_PATTERN, (match, tag: string, rawAttributes: string, body: string) => {
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
      interrupted: tag === 'interrupt',
    });
    return '';
  });

  return { activations, rest: activations.length > 0 ? rest.trim() : text };
}
