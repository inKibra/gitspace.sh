/**
 * Fuzzy matching algorithm
 * Matches query against candidates and returns scored results
 */

import type { FuzzyMatch, WorkspaceCandidate } from '../types/workspace-fuzzy.js';

/**
 * Perform fuzzy matching on workspace candidates
 *
 * Algorithm:
 * 1. For each candidate, calculate match score
 * 2. Filter out scores below threshold (30)
 * 3. Sort by score descending
 *
 * @param query Search string
 * @param candidates List of workspace candidates
 * @returns Sorted array of matches with scores
 */
export function fuzzyMatch(
  query: string,
  candidates: WorkspaceCandidate[]
): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];

  for (const candidate of candidates) {
    const result = calculateMatchScore(query, candidate.name);

    if (result.score >= 30) {  // Minimum threshold
      matches.push({
        item: candidate,
        score: result.score,
        matchedIndices: result.matchedIndices,
      });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  return matches;
}

/**
 * Calculate fuzzy match score between query and candidate
 *
 * Scoring rules:
 * - All query characters must exist in order: otherwise score = 0
 * - Consecutive character matches: +10 points per consecutive char
 * - Word boundary matches: +5 points (e.g., "fb" matches "feature-branch")
 * - Exact case match: +2 points per char
 * - Start of string match: +15 points
 * - Character proximity: -1 point per gap
 * - Base score: 50 points if all chars match
 *
 * @param query Search string
 * @param candidate String to match against
 * @returns Object with score and matched character indices
 */
function calculateMatchScore(
  query: string,
  candidate: string
): { score: number; matchedIndices: number[] } {
  if (!query || !candidate) {
    return { score: 0, matchedIndices: [] };
  }

  const queryLower = query.toLowerCase();
  const candidateLower = candidate.toLowerCase();

  // Find all query characters in candidate
  const matchedIndices: number[] = [];
  let candidateIndex = 0;

  for (let i = 0; i < queryLower.length; i++) {
    const queryChar = queryLower[i];
    const foundIndex = candidateLower.indexOf(queryChar, candidateIndex);

    if (foundIndex === -1) {
      // Character not found - no match
      return { score: 0, matchedIndices: [] };
    }

    matchedIndices.push(foundIndex);
    candidateIndex = foundIndex + 1;
  }

  // All characters matched - start with base score
  let score = 50;

  // Bonus: Start of string match
  if (matchedIndices[0] === 0) {
    score += 15;
  }

  // Calculate bonuses for consecutive matches, word boundaries, and case
  for (let i = 0; i < matchedIndices.length; i++) {
    const index = matchedIndices[i];
    const queryChar = query[i];
    const candidateChar = candidate[index];

    // Consecutive match bonus
    if (i > 0 && matchedIndices[i] === matchedIndices[i - 1] + 1) {
      score += 10;
    }

    // Word boundary bonus (after -, _, /, or at start)
    if (index === 0 || ['-', '_', '/'].includes(candidate[index - 1])) {
      score += 5;
    }

    // Exact case match bonus
    if (queryChar === candidateChar) {
      score += 2;
    }

    // Proximity penalty (gap between matched characters)
    if (i > 0) {
      const gap = matchedIndices[i] - matchedIndices[i - 1] - 1;
      score -= gap;  // -1 point per character gap
    }
  }

  return { score, matchedIndices };
}
