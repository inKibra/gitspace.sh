export interface ProofRecord { id: string; state: "ready" | "blocked"; evidence: string[]; }

export function ready(record: ProofRecord): boolean {
  return record.state === "ready" && record.evidence.length > 0;
}
