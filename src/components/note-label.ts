/** Derive a display title for a note body: first heading, else first
 *  non-empty line, capped at 56 chars. Shared by the notes modal-successors,
 *  rails and dock tabs. */
export function deriveNoteLabel(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => line.startsWith('#'));
  const raw = heading ? heading.replace(/^#+\s*/, '') : (lines[0] ?? 'Untitled note');
  return raw.length > 56 ? `${raw.slice(0, 56)}…` : raw;
}
