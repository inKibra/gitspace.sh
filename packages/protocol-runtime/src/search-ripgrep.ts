import { z } from 'zod';
import { RuntimeGrepArgumentsSchema } from './tool-arguments.js';
import { searchPathFilter, type SearchFile } from './search-paths.js';

const DataText = z.union([z.object({ text: z.string() }), z.object({ bytes: z.string() })]);
const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('match'), data: z.object({ path: DataText, lines: DataText, line_number: z.number().int().positive() }) }),
  z.object({ type: z.literal('end'), data: z.object({ path: DataText, binary_offset: z.number().nullable() }) }),
  z.object({ type: z.literal('begin') }),
  z.object({ type: z.literal('summary') }),
]);
const decode = (data: z.infer<typeof DataText>) => 'text' in data ? data.text : new TextDecoder().decode(Uint8Array.from(atob(data.bytes), character => character.charCodeAt(0)));

/** No ambient rg config/global ignore files: only the current workspace snapshot determines results. */
export function searchRipgrepArguments(input: z.input<typeof RuntimeGrepArgumentsSchema>, path: string): string[] {
  const args = RuntimeGrepArgumentsSchema.parse(input);
  return ['--json', '--sort=path', '--encoding=utf-8', '--no-config', '--hidden', '--no-ignore', '--glob=!.git/**',
    ...(args.multiline ? ['--multiline'] : []), ...(args.caseSensitive ? ['--case-sensitive'] : ['--ignore-case']), '--', args.pattern, path];
}

export function searchRipgrepOutput(output: string, input: z.input<typeof RuntimeGrepArgumentsSchema>, root: string, ignoreFiles: readonly SearchFile[]): string {
  const args = RuntimeGrepArgumentsSchema.parse(input);
  const accepts = searchPathFilter(args, ignoreFiles);
  const matches: { path: string; line: number; text: string }[] = [];
  const binary = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const event = Event.parse(JSON.parse(line));
    if (event.type === 'begin' || event.type === 'summary') continue;
    const path = decode(event.data.path).replace(`${root.replace(/\/$/u, '')}/`, '').replace(/^\.\//u, '');
    if (event.type === 'end') { if (event.data.binary_offset !== null) binary.add(path); continue; }
    const lines = decode(event.data.lines).split('\n');
    if (lines.at(-1) === '') lines.pop();
    lines.forEach((text, offset) => matches.push({ path, line: event.data.line_number + offset, text }));
  }
  return matches.filter(match => !binary.has(match.path) && accepts(match.path)).slice(args.offset, args.offset + args.limit).map(match => `${match.path}:${match.line}:${match.text}`).join('\n');
}
