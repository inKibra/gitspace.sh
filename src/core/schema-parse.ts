import { z } from 'zod';
import { SpacesError } from '../types/errors.js';

/**
 * One parse boundary shape for every persisted record.
 *
 * The repo grew ten places where JSON came off disk (or off the wire) as a
 * `JSON.parse` plus an `as` cast, while a stricter validator sat somewhere
 * downstream — usually a Zod schema at render time. The agent got "ok", the
 * user got "invalid". Parsing at ingest with a single canonical schema is what
 * closes that gap, and this module is the shared machinery for doing it:
 *
 *   - `formatIssues` gives every surface the same `path: message` diagnostic
 *     (matching `validateBlock` in src/blocks/registry.ts).
 *   - `parseWith` / `parseJsonWith` are the tolerant readers: they return
 *     issues instead of throwing, so a UI can render a loud row for one bad
 *     record without losing the rest of the list.
 *   - `parseOrThrow` is the strict writer/CLI path: a `SpacesError` carrying
 *     the field-level issues, so the agent that authored the file is told
 *     exactly which field is wrong.
 */

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: string[] };

/** Zod issues as `path: message` lines; `(root)` for a top-level failure. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** Parse an already-decoded value. Never throws. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): ParseResult<z.infer<S>> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}

/**
 * Parse JSON text. A syntax error and a schema violation both come back as
 * issues, so callers have one failure path rather than a try/catch plus a
 * validity check. The two stay distinguishable in the message: "unreadable"
 * means the bytes are not JSON at all, which is a different fix for the author
 * than a field being the wrong shape.
 */
export function parseJsonWith<S extends z.ZodType>(schema: S, raw: string): ParseResult<z.infer<S>> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, issues: [`(root): unreadable JSON — ${error instanceof Error ? error.message : String(error)}`] };
  }
  return parseWith(schema, value);
}

/**
 * Strict parse for write and CLI paths. Throws a USER_ERROR naming `label` and
 * listing every field-level issue — the actionable form for whoever authored
 * the record.
 */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const result = parseWith(schema, value);
  if (result.ok) {
    return result.data;
  }
  throw new SpacesError(
    `Invalid ${label}:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`,
    'USER_ERROR',
    1,
  );
}

/** Strict JSON parse for write and CLI paths. See {@link parseOrThrow}. */
export function parseJsonOrThrow<S extends z.ZodType>(schema: S, raw: string, label: string): z.infer<S> {
  const result = parseJsonWith(schema, raw);
  if (result.ok) {
    return result.data;
  }
  throw new SpacesError(
    `Invalid ${label}:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`,
    'USER_ERROR',
    1,
  );
}
