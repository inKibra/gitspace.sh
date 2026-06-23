import type {
  GoalValidation,
  Readiness,
  ReadinessStatus,
  ReadinessTotals,
  Requirement,
} from '../../../types/goals.js';

function requirementCounts(requirements: Requirement[]): ReadinessTotals {
  return {
    total: requirements.length,
    missing: requirements.filter((r) => r.status === 'missing').length,
    review: requirements.filter((r) => r.status === 'review').length,
    accepted: requirements.filter((r) => r.status === 'accepted').length,
  };
}

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function computeReadiness(validation: GoalValidation): Readiness {
  const requirements = validation.reqOrder
    .map((id) => validation.requirements[id])
    .filter((r): r is Requirement => Boolean(r));
  const required = requirements.filter((r) => r.required);
  const totals = requirementCounts(required);
  const failed = required.filter((r) => {
    const last = r.reviews[r.reviews.length - 1];
    return last?.tone === 'red';
  }).length;

  let status: ReadinessStatus;
  let summary: string;
  if (totals.total === 0) {
    status = 'not-ready';
    summary = 'No required artifacts declared.';
    return {
      status,
      summary,
      detail: 'Open the Requirements tab to declare what evidence is needed before this goal can be accepted.',
      totals,
    };
  }
  if (totals.missing === 0 && totals.review === 0) {
    status = 'ready';
    summary = 'Ready: all required artifacts passed judgment.';
  } else if (failed > 0) {
    status = 'not-ready';
    summary = `${pluralize(failed, 'requirement')} failed review.`;
  } else if (totals.missing > 0) {
    status = 'not-ready';
    summary = `${pluralize(totals.missing, 'required artifact')} missing.`;
  } else {
    status = 'awaiting-review';
    summary = `${pluralize(totals.review, 'artifact')} attached but not judged.`;
  }

  const detailParts: string[] = [];
  if (totals.missing > 0) detailParts.push(`${pluralize(totals.missing, 'required artifact')} missing`);
  if (totals.review > 0) detailParts.push(`${pluralize(totals.review, 'artifact')} awaiting judgment`);
  if (failed > 0) detailParts.push(`${pluralize(failed, 'requirement')} failed review`);
  if (detailParts.length === 0) detailParts.push('All required evidence accepted.');

  return {
    status,
    summary,
    detail: detailParts.join(' · '),
    totals,
  };
}
