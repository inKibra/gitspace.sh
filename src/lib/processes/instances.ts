/**
 * Normalize configured process instance count.
 *
 * Semantics:
 * - undefined/null => 1
 * - 0 => disabled process definition
 * - positive integers => exact instance count
 * - invalid/non-integer values => 1 (defensive fallback)
 */
export function normalizeProcessInstanceCount(instances?: number): number {
  if (instances === undefined || instances === null) {
    return 1;
  }

  if (!Number.isInteger(instances)) {
    return 1;
  }

  return Math.max(0, instances);
}
