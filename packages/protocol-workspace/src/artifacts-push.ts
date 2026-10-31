/**
 * How Artifacts' receive-pack refuses a push that a differently built one passes, shared by both pushers: the cloud's
 * (smart HTTP from a Worker, `runtime-workspace-do`) and the machine's (git, `account-machine`). A refusal either pusher
 * learns about is named here once.
 */
export type ArtifactsPushRefusal =
  /** One push may carry at most 64 MiB (`artifacts_git_receive_pack_request_too_large`; a 96.1 MiB base-branch
   * import, 2026-10-31). The same history sent in smaller pushes passes. */
  | 'too-large'
  /** A pack Artifacts cannot unpack although its objects are sound: deltas (HTTP 500 with djmc, 2026-10-19; "delta base
   * is missing", 2026-10-28; "OFS_DELTA base not found", since 2026-10-23), or history below a boundary it holds that
   * git counted as present ("reachable object is missing"). Sent as whole objects with the remote's boundaries, it
   * passes. */
  | 'pack';

const TOO_LARGE = /artifacts_git_receive_pack_request_too_large|\b(?:HTTP|error:) 413\b/u;
const PACK = /\bHTTP 500\b|delta base is missing|OFS_DELTA base not found|reachable object is missing|missing necessary objects/u;

/** The refusal a push failure's message reports, or null for any other failure. */
export function artifactsPushRefusal(message: string): ArtifactsPushRefusal | null {
  if (TOO_LARGE.test(message)) return 'too-large';
  if (PACK.test(message)) return 'pack';
  return null;
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
