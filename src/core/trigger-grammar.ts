/**
 * Trigger schedule grammar — pure (no node imports) so the web form, the
 * registry (saveTrigger), and the scheduler all validate with ONE matcher.
 * An unparseable cron `when` must be impossible to save: before this module,
 * "Mon 09:00" saved fine, toasted success, showed "armed", and silently
 * never fired.
 */

/** `every 5m` / `every 2 hours` / `every 1d` → milliseconds; anything else → null. */
export function parseCronWhen(when: string): number | null {
  const m = when.trim().toLowerCase().match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]![0];
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * ms;
}

export const CRON_WHEN_HELP = "cron schedules are 'every N minutes/hours/days' — e.g. 'every 5m', 'every 6h', 'every 1d'";

/** Human-readable rejection for a trigger's schedule, or null when valid.
 *  Only cron kinds carry a schedule; event triggers have no engine yet and
 *  manual triggers only run on demand. */
export function validateTriggerWhen(kind: 'cron' | 'event' | 'manual', when: string): string | null {
  if (kind !== 'cron') return null;
  if (parseCronWhen(when) === null) {
    return `'${when.trim() || '(empty)'}' will never fire — ${CRON_WHEN_HELP}`;
  }
  return null;
}

/** Next-fire estimate for display: 'within 1m' (never run), 'in ~Nm/Nh', or 'due now'. */
export function describeNextRun(when: string, lastRunAtIso: string | null): string | null {
  const interval = parseCronWhen(when);
  if (interval === null) return null;
  if (!lastRunAtIso) return 'within 1m';
  const at = Date.parse(lastRunAtIso);
  if (Number.isNaN(at)) return 'within 1m';
  const remaining = at + interval - Date.now();
  if (remaining <= 0) return 'due now';
  if (remaining < 90_000) return 'in ~1m';
  if (remaining < 3_600_000) return `in ~${Math.round(remaining / 60_000)}m`;
  if (remaining < 86_400_000) return `in ~${Math.round(remaining / 3_600_000)}h`;
  return `in ~${Math.round(remaining / 86_400_000)}d`;
}
