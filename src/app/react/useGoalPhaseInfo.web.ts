/**
 * Requirements ⇄ phase-journal join (web loader).
 *
 * One `get_review_guide_state` request per pane load (the executor reads the
 * journal dir once) → a map of requirement id → journal phases in which the
 * requirement advanced (from each entry's delta.requirementsAdvanced).
 * Null while loading or when the workspace has no backend/journal.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';

export type SendReviewRequestFn = (operation: ReviewOperation) => Promise<ReviewResult>;

export interface GoalPhaseInfo {
  /** requirement id → journal phases in which it advanced (deduped, journal order). */
  advancedPhases: Record<string, string[]>;
}

export function useGoalPhaseInfo(
  sendReviewRequest: SendReviewRequestFn | null | undefined,
  projectName: string | null | undefined,
  workspaceName: string | null | undefined,
): GoalPhaseInfo | null {
  const [info, setInfo] = useState<GoalPhaseInfo | null>(null);
  // Ref keeps effect deps to project/workspace only — callers may pass a
  // fresh arrow per render, and this must stay one fetch per pane load.
  const sendRef = useRef(sendReviewRequest);
  sendRef.current = sendReviewRequest;

  useEffect(() => {
    // Functional reset: skips the render entirely when already null (mount).
    setInfo((prev) => (prev === null ? prev : null));
    const send = sendRef.current;
    if (!send || !projectName || !workspaceName) return;
    let alive = true;
    void send({ op: 'get_review_guide_state', projectName, workspaceName })
      .then((r) => {
        if (!alive || r.op !== 'review_guide_state') return;
        const advancedPhases: Record<string, string[]> = {};
        for (const entry of r.journal ?? []) {
          for (const adv of entry.requirementsAdvanced) {
            const list = (advancedPhases[adv.id] ??= []);
            if (!list.includes(entry.phase)) list.push(entry.phase);
          }
        }
        setInfo({ advancedPhases });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [projectName, workspaceName]);

  return info;
}
