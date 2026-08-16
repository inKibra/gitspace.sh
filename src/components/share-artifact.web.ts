/**
 * Shared "share this artifact" action (docs/ARTIFACT-PROTOCOL.md Q3).
 *
 * One implementation behind every share affordance — the Project Home rail,
 * the workspace artifacts rail, and opened artifact panes — so they behave
 * identically: mint a signed public link, copy it, toast the outcome.
 * `workspaceSegment` is the workspace name, or '@base' for the project mount.
 */
import { toast } from '../lib/sonner.web.js';
import { formatArtifactUri } from '../core/artifact-cap.js';
import type { SessionBackend } from '../session/backend.js';

export async function shareArtifactToClipboard(
  backend: SessionBackend | null | undefined,
  projectName: string,
  workspaceSegment: string,
  relPath: string,
): Promise<void> {
  if (!backend?.mintArtifactShare) {
    toast.error('Sharing needs an active machine connection with serve running.');
    return;
  }
  try {
    const r = await backend.mintArtifactShare(formatArtifactUri(projectName, workspaceSegment, relPath));
    const copied = await navigator.clipboard.writeText(r.url).then(() => true).catch(() => false);
    toast.success(
      copied
        ? `Share link copied — anyone with it can read this file until ${new Date(r.expiresAt).toLocaleDateString()}.`
        : `Share link (copy failed, here it is): ${r.url}`,
    );
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to mint share link');
  }
}
