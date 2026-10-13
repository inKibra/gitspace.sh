type GitCommand = (repository: string, args: string[]) => Promise<string>;
export interface LegacySubmoduleRecovery { commit: string; repositoryPath: string }

/** Verifies retained child graphs without changing .gitmodules or contacting their origins. */
export class LegacySubmoduleVerifier {
  private readonly links = new Map<string, readonly string[]>();
  constructor(private readonly git: GitCommand) {}

  private async gitlinks(repository: string, commit: string): Promise<Set<string>> {
    const names = (await this.git(repository, ['rev-list', '--objects', '--filter=blob:none', '--no-object-names', commit])).split('\n').filter(Boolean);
    const missing = names.filter(name => !this.links.has(name));
    if (missing.length) {
      const child = Bun.spawn(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repository, 'cat-file', '--batch'], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        stdin: new Blob([`${missing.join('\n')}\n`]), stdout: 'pipe', stderr: 'ignore',
      });
      const reader = child.stdout.getReader();
      let pending: Uint8Array = new Uint8Array();
      let offset = 0;
      const refill = async () => {
        if (offset < pending.length) return;
        const next = await reader.read();
        if (next.done) throw new Error('Retained Git object stream ended prematurely');
        pending = next.value; offset = 0;
      };
      const take = async (length: number) => {
        const bytes = new Uint8Array(length);
        let written = 0;
        while (written < length) {
          await refill();
          const count = Math.min(length - written, pending.length - offset);
          bytes.set(pending.subarray(offset, offset + count), written);
          written += count; offset += count;
        }
        return bytes;
      };
      try {
        for (const expected of missing) {
          let header = '';
          for (;;) {
            await refill();
            const newline = pending.indexOf(10, offset);
            const end = newline < 0 ? pending.length : newline;
            header += new TextDecoder().decode(pending.subarray(offset, end)); offset = end;
            if (newline >= 0) { offset++; break; }
          }
          const match = /^([a-f0-9]{40}) (commit|tree) ([0-9]+)$/u.exec(header);
          if (!match || match[1] !== expected) throw new Error('Retained Git graph has invalid object metadata');
          const bytes = await take(Number(match[3]));
          if ((await take(1))[0] !== 10) throw new Error('Retained Git object has an invalid delimiter');
          const children: string[] = [];
          if (match[2] === 'tree') {
            let at = 0;
            while (at < bytes.length) {
              const space = bytes.indexOf(32, at), nul = bytes.indexOf(0, space);
              if (space < at || nul < space || nul + 21 > bytes.length) throw new Error('Retained Git tree is malformed');
              if (new TextDecoder().decode(bytes.subarray(at, space)) === '160000') children.push(Buffer.from(bytes.subarray(nul + 1, nul + 21)).toString('hex'));
              at = nul + 21;
            }
          }
          this.links.set(expected, children);
        }
        if (await child.exited !== 0) throw new Error('Retained Git graph could not be read');
      } finally {
        await reader.cancel();
        child.kill();
        await child.exited;
      }
    }
    return new Set(names.flatMap(name => this.links.get(name) ?? []));
  }

  async verify(repository: string, commit: string, sources: ReadonlyMap<string, string>): Promise<LegacySubmoduleRecovery[]> {
    const pending = [...await this.gitlinks(repository, commit)];
    const verified = new Map<string, LegacySubmoduleRecovery>();
    for (let index = 0; index < pending.length; index++) {
      const oid = pending[index]!;
      if (verified.has(oid)) continue;
      let found: { source: string; copy: string } | undefined;
      for (const [source, copy] of sources) {
        try { await this.git(copy, ['cat-file', '-e', `${oid}^{commit}`]); found = { source, copy }; break; }
        catch { /* Another retained child repository may own this commit. */ }
      }
      if (!found) throw new Error(`Missing retained submodule commit ${oid}; supply its complete repository in submoduleRepositories before migration`);
      verified.set(oid, { commit: oid, repositoryPath: found.source });
      pending.push(...await this.gitlinks(found.copy, oid));
    }
    return [...verified.values()].sort((left, right) => left.commit.localeCompare(right.commit));
  }
}
