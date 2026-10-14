import ignore from 'ignore';
import picomatch from 'picomatch';
import type { z } from 'zod';
import { RuntimeGrepArgumentsSchema } from './tool-arguments.js';

export type SearchArguments = z.input<typeof RuntimeGrepArgumentsSchema>;
export type SearchFile = { path: string; content: string };
export type SearchIgnoreRules = readonly { directory: string; name: string; matcher: ignore.Ignore }[];

/** Parse every .gitignore/.ignore once; each search over the same files reuses the result. */
export function compileSearchIgnores(files: readonly SearchFile[]): SearchIgnoreRules {
  return files.filter(file => /(^|\/)(\.gitignore|\.ignore)$/u.test(file.path)).map(file => ({
    directory: file.path.slice(0, file.path.lastIndexOf('/') + 1),
    name: file.path.endsWith('.gitignore') ? '.gitignore' : '.ignore',
    matcher: ignore().add(file.content),
  })).sort((a, b) => a.directory.length - b.directory.length || a.name.localeCompare(b.name));
}

/** The checkout-relative file or directory a search is confined to; '' is the whole checkout. */
export function searchRoot(path: string): string {
  const root = path.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (root.startsWith('/') || root.split('/').some(part => part === '..' || part === '.git')) throw new Error('Search path must remain inside the workspace checkout');
  return root === '.' ? '' : root;
}

export function searchPathFilter(input: SearchArguments, ignores: SearchIgnoreRules) {
  const args = RuntimeGrepArgumentsSchema.parse(input);
  const root = searchRoot(args.path);
  const glob = args.glob ? picomatch(args.glob.startsWith('!') ? args.glob.slice(1) : args.glob, { dot: true, basename: !args.glob.includes('/'), nonegate: true, noext: true }) : undefined;
  return (path: string) => {
    if (path.split('/').includes('.git')) return false;
    if (root && path !== root && !path.startsWith(`${root}/`)) return false;
    if (glob && (args.glob?.startsWith('!') ? glob(path) : !glob(path))) return false;
    // Explicit files and positive glob overrides follow ripgrep's whitelist semantics.
    if (path === root || (glob && !args.glob?.startsWith('!'))) return true;
    if (!args.hidden && path.split('/').some(part => part.startsWith('.'))) return false;
    if (!args.gitignore) return true;
    let ignored = false;
    for (const rule of ignores) {
      if (!path.startsWith(rule.directory)) continue;
      const match = rule.matcher.test(path.slice(rule.directory.length));
      if (match.ignored) ignored = true;
      else if (match.unignored) ignored = false;
    }
    return !ignored;
  };
}
