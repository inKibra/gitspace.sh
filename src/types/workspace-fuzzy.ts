/**
 * Type definitions for workspace fuzzy matching
 */

/**
 * A workspace candidate for fuzzy matching
 */
export interface WorkspaceCandidate {
  /** Workspace name */
  name: string;
  /** Absolute path to workspace */
  path: string;
  /** Current git branch */
  branch: string;
  /** Commits ahead of remote */
  ahead: number;
  /** Commits behind remote */
  behind: number;
  /** Number of uncommitted changes */
  uncommittedChanges: number;
  /** Last commit message */
  lastCommit: string;
}

/**
 * Result of fuzzy matching
 */
export interface FuzzyMatch {
  /** Original candidate item */
  item: WorkspaceCandidate;
  /** Match score (0-100, higher is better) */
  score: number;
  /** Indices of matched characters in item.name */
  matchedIndices: number[];
}

/**
 * Workspace with ranking information
 */
export interface RankedWorkspace {
  /** Workspace candidate */
  workspace: WorkspaceCandidate;
  /** Fuzzy match score */
  matchScore: number;
  /** Final ranking score (includes bonuses) */
  finalScore: number;
  /** Character indices that matched */
  matchedIndices: number[];
}
