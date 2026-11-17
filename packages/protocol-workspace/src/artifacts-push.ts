/**
 * How Artifacts' receive-pack refuses a push that a differently built one passes, shared by both pushers: the cloud's
 * (smart HTTP from a Worker, `runtime-workspace-do`) and the machine's (git, `account-machine`). A refusal either pusher
 * learns about is named here once.
 */
export type ArtifactsPushRefusal =
  /** One push may carry at most 64 MiB (`artifacts_git_receive_pack_request_too_large`; a 96.1 MiB base-branch
   * import, 2026-10-31; the receive-pack status `push is 87.4 MiB, limit is 64.0 MiB`, 2026-11-16). The same history
   * sent in smaller pushes passes. */
  | 'too-large'
  /** A pack Artifacts cannot unpack although its objects are sound: deltas (HTTP 500 with djmc, 2026-10-19; "delta base
   * is missing", 2026-10-28; "OFS_DELTA base not found", since 2026-10-23), or history below a boundary it holds that
   * git counted as present ("reachable object is missing"). Sent as whole objects with the remote's boundaries, it
   * passes. */
  | 'pack';

/** The size wording of a too-large refusal, as Artifacts' receive-pack status reports it. */
const PUSH_SIZE = /push is (\d+(?:\.\d+)? ?[KMGT]i?B)[,;]? +(?:the )?limit is (\d+(?:\.\d+)? ?[KMGT]i?B)/iu;
const TOO_LARGE = new RegExp(`artifacts_git_receive_pack_request_too_large|\\b(?:HTTP|error:) 413\\b|${PUSH_SIZE.source}`, 'iu');
const PACK = /\bHTTP 500\b|delta base is missing|OFS_DELTA base not found|reachable object is missing|missing necessary objects/u;

/** The refusal a push failure's message reports, or null for any other failure. */
export function artifactsPushRefusal(message: string): ArtifactsPushRefusal | null {
  if (TOO_LARGE.test(message)) return 'too-large';
  if (PACK.test(message)) return 'pack';
  return null;
}

/** The refused push's size and the limit, as a too-large refusal's message words them, or null when it does not. */
export function artifactsPushSize(message: string): { size: string; limit: string } | null {
  const match = PUSH_SIZE.exec(message);
  return match ? { size: match[1]!, limit: match[2]! } : null;
}

/** Each push after a too-large refusal carries a quarter of the refused one. */
const SPLIT = 4;

/**
 * How much the next push carries after one carrying `size` was refused as too large: commits along first parents for
 * the machine, which holds the history, or history depth for the cloud, which streams it. Null once a single commit was
 * refused: no split makes it smaller.
 */
export function smallerArtifactsPush(size: number): number | null {
  return size <= 1 ? null : Math.ceil(size / SPLIT);
}
