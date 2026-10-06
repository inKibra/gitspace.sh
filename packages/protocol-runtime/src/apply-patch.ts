export type PatchChange = { path: string; destination?: string; before: string | null; after: string | null };
export type PatchFiles = { read(path: string): Promise<string>; exists(path: string): Promise<boolean> };

/** Parse and validate every operation before modifying any file. Context is exact and unambiguous. */
export async function prepareV4APatch(patch: string, files: PatchFiles): Promise<PatchChange[]> {
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Expected V4A Begin/End Patch envelope');
  const changes: PatchChange[] = [];
  const paths = new Set<string>();
  let cursor = 0;
  while (cursor < lines.length) {
    const header = lines[cursor++]!;
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/u.exec(header);
    if (!match) throw new Error(`Invalid patch operation: ${header}`);
    const [, operation, path] = match;
    if (!path || paths.has(path)) throw new Error('A patch may modify each path only once');
    paths.add(path);
    if (operation === 'Add') {
      if (await files.exists(path)) throw new Error(`File already exists: ${path}`);
      const added: string[] = [];
      while (cursor < lines.length && !lines[cursor]!.startsWith('*** ')) {
        const line = lines[cursor++]!;
        if (!line.startsWith('+')) throw new Error('Added file lines must begin with +');
        added.push(line.slice(1));
      }
      changes.push({ path, before: null, after: added.join('\n') + '\n' });
      continue;
    }
    const before = await files.read(path);
    if (operation === 'Delete') { changes.push({ path, before, after: null }); continue; }
    let destination: string | undefined;
    if (lines[cursor]?.startsWith('*** Move to: ')) {
      destination = lines[cursor++]!.slice('*** Move to: '.length);
      if (!destination || paths.has(destination) || await files.exists(destination)) throw new Error('Patch move destination already exists or is repeated');
      paths.add(destination);
    }
    const ending = before.includes('\r\n') ? '\r\n' : '\n';
    const original = before.replaceAll('\r\n', '\n').split('\n');
    const hadFinalNewline = original.at(-1) === '';
    if (hadFinalNewline) original.pop();
    let position = 0;
    const result: string[] = [];
    let hunks = 0;
    while (cursor < lines.length && (!lines[cursor]!.startsWith('*** ') || lines[cursor] === '*** End of File')) {
      const start = lines[cursor++]!;
      if (start !== '@@' && !start.startsWith('@@ ')) throw new Error(`Expected hunk header, received: ${start}`);
      if (start.startsWith('@@ ')) {
        const anchor = start.slice(3);
        const index = original.indexOf(anchor, position);
        if (index < 0) throw new Error(`Hunk anchor not found: ${anchor}`);
        result.push(...original.slice(position, index + 1)); position = index + 1;
      }
      const oldLines: string[] = [], newLines: string[] = [];
      let endOfFile = false;
      while (cursor < lines.length) {
        const line = lines[cursor]!;
        if (line === '*** End of File') { endOfFile = true; cursor++; break; }
        if (line.startsWith('*** ') || line === '@@' || line.startsWith('@@ ')) break;
        cursor++;
        if (![' ', '+', '-'].includes(line[0] ?? '')) throw new Error('Hunk lines require context, + or - prefix');
        if (line[0] !== '+') oldLines.push(line.slice(1));
        if (line[0] !== '-') newLines.push(line.slice(1));
      }
      const matches: number[] = [];
      if (oldLines.length === 0) matches.push(endOfFile ? original.length : position);
      for (let at = position; oldLines.length > 0 && at <= original.length - oldLines.length; at++) {
        if (endOfFile && at + oldLines.length !== original.length) continue;
        if (oldLines.every((line, offset) => original[at + offset] === line)) matches.push(at);
      }
      if (matches.length !== 1) throw new Error(`Patch context ${matches.length ? 'is ambiguous' : 'does not match'} in ${path}`);
      const at = matches[0]!;
      result.push(...original.slice(position, at), ...newLines);
      position = at + oldLines.length; hunks++;
    }
    if (!hunks) throw new Error(`No update hunks for ${path}`);
    result.push(...original.slice(position));
    changes.push({ path, ...(destination ? { destination } : {}), before, after: result.join(ending) + (hadFinalNewline ? ending : '') });
  }
  if (!changes.length) throw new Error('Empty patch');
  return changes;
}
