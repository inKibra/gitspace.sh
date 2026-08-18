import type { ReactNode } from "react";

/**
 * Minimal syntax highlighting for the two languages the docs actually use.
 *
 * Hand-rolled on purpose. Shiki or Prism would add hundreds of kilobytes to a
 * bundle that is already ~730KB, to colour shell one-liners and small JSON
 * objects. The grammar here is deliberately shallow: it colours the things a
 * reader scans for (which binary, which flags, which values) and leaves
 * everything else alone rather than guessing.
 *
 * Palette is borrowed from the fleet board so the docs read in the same
 * language as the product: green is the thing doing work, amber is a value you
 * supply, sky is a switch, dim is commentary.
 */

const CLS = {
  comment: "text-zinc-600",
  command: "text-green-400",
  flag: "text-sky-300",
  value: "text-amber-200",
  punct: "text-zinc-600",
  plain: "text-zinc-300",
} as const;

/** Binaries that appear in these docs. A known list beats guessing "first word". */
const BINARIES = ["gssh", "npm", "bun", "pnpm", "yarn", "gh", "git", "curl", "cd", "export", "sudo"];

const BASH_TOKEN = new RegExp(
  [
    "(#.*$)", // 1 comment
    "(\"[^\"]*\"|'[^']*')", // 2 quoted string
    "(<[^>]+>)", // 3 <placeholder>
    "(?:^|(?<=\\s))(--?[A-Za-z][\\w-]*)", // 4 flag
    `\\b(${BINARIES.join("|")})\\b`, // 5 binary
  ].join("|"),
  "g",
);

/** Colourise one line of shell. Returns plain text unchanged when nothing matches. */
export function highlightBash(line: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  BASH_TOKEN.lastIndex = 0;

  while ((m = BASH_TOKEN.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [, comment, str, placeholder, flag, binary] = m;
    const cls = comment
      ? CLS.comment
      : str || placeholder
        ? CLS.value
        : flag
          ? CLS.flag
          : CLS.command;
    out.push(
      <span key={`${m.index}-${out.length}`} className={cls}>
        {comment ?? str ?? placeholder ?? flag ?? binary}
      </span>,
    );
    last = m.index + m[0].length;
    // A zero-length match would spin forever; the lookbehind makes that possible.
    if (m[0].length === 0) BASH_TOKEN.lastIndex++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out.length ? out : line;
}

const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(\b-?\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)|([{}[\],])/g;

/** Colourise a JSON document: keys, string values, literals, punctuation. */
export function highlightJson(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  JSON_TOKEN.lastIndex = 0;

  while ((m = JSON_TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [full, key, colon, str, literal, punct] = m;
    if (key) {
      out.push(
        <span key={`${m.index}k`} className={CLS.flag}>
          {key}
        </span>,
        <span key={`${m.index}c`} className={CLS.punct}>
          {colon}
        </span>,
      );
    } else {
      out.push(
        <span
          key={`${m.index}-${out.length}`}
          className={str ? CLS.value : literal ? CLS.command : CLS.punct}
        >
          {str ?? literal ?? punct}
        </span>,
      );
    }
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : text;
}
