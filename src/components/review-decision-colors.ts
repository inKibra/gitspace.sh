import type { HunkDecision } from '../types/review.js';

export const REVIEW_DECISION_COLORS: Record<HunkDecision, string> = {
  approved: '#22c55e',
  rejected: '#f85149',
  pending: '#d29922',
};

export function getReviewDecisionColor(decision: HunkDecision): string {
  return REVIEW_DECISION_COLORS[decision];
}
