import { type ReactElement } from 'react';
import { File } from '@pierre/diffs/react';
import type { SupportedLanguages } from '@pierre/diffs';

// Syntax-highlighted code via @pierre/diffs (shiki), pierre-dark theme — shared
// by the `code`/`code-ref` blocks and markdown fenced-code rendering. Kept free
// of the registry so it can't form an import cycle
// (registry → markdown → code → registry).
export function Highlighted({ text, lang, name = 'snippet' }: { text: string; lang?: string; name?: string }): ReactElement {
  return (
    <File
      file={{ name, contents: text, lang: lang as SupportedLanguages | undefined }}
      options={{ theme: 'pierre-dark', disableFileHeader: true }}
    />
  );
}
