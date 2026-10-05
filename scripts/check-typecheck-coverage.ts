#!/usr/bin/env bun
/** Inventory the programs invoked by root typecheck, including package tests. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

interface Manifest {
  workspaces?: string[] | { packages: string[] };
  scripts?: Record<string, string>;
}

/** Fail closed if root typecheck stops invoking the entire workspace scope. */
function assertWorkspaceTypecheck(scripts: Record<string, string>, name = 'typecheck', seen = new Set<string>()): void {
  if (seen.has(name)) throw new Error(`Recursive root script: ${name}`);
  seen.add(name);
  const command = scripts[name];
  if (command === 'bun run --workspaces --if-present typecheck') return;
  const alias = command?.match(/^bun run ([\w:-]+)$/u);
  if (alias) return assertWorkspaceTypecheck(scripts, alias[1]!, seen);
  throw new Error(`Root ${name} must invoke bun run --workspaces --if-present typecheck`);
}

export function workspaceDirectories(root: string): string[] {
  const rootManifest: Manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertWorkspaceTypecheck(rootManifest.scripts ?? {});
  const patterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages;
  if (!patterns?.length) throw new Error('Root package.json has no workspace scope');
  const directories = new Set<string>();
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => new Bun.Glob(`${pattern.slice(1).replace(/\/$/u, '')}/package.json`));
  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    for (const file of new Bun.Glob(`${pattern.replace(/\/$/u, '')}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      if (!excluded.some(glob => glob.match(file))) directories.add(resolve(root, file, '..'));
    }
  }
  if (!directories.size) throw new Error('Root workspace scope contains no packages');
  return [...directories].sort();
}

function programFiles(cwd: string, command: string): Set<string> {
  const files = new Set<string>();
  for (const step of command.split(/\s*&&\s*/u)) {
    // Only actual compiler invocations count, not config names in arbitrary scripts.
    const match = step.match(/^(?:tsgo|tsc) --noEmit -p ([\w./-]+)$/u);
    if (!match) throw new Error(`Unsupported typecheck command in ${cwd}: ${step}`);
    const configPath = resolve(cwd, match[1]!);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, '..'), undefined, configPath);
    if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    for (const file of program.getSourceFiles()) files.add(resolve(file.fileName));
  }
  return files;
}

const sourceDirectories = new Set(['src', 'test', 'tests', 'smoke', 'scripts']);
function sourceFiles(dir: string, out: string[], packageRoot = false): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Content archives are not application inputs. Check code roots and root configs.
      if (!packageRoot || sourceDirectories.has(entry)) sourceFiles(full, out);
    }
    else if (/\.[cm]?tsx?$/u.test(entry) && !/\.d\.[cm]?ts$/u.test(entry)) out.push(full);
  }
}

export function checkTypecheckCoverage(root: string): { packages: number; files: number; unchecked: string[]; suppressed: string[] } {
  const packages = workspaceDirectories(root);
  const unchecked: string[] = [];
  const suppressed: string[] = [];
  let files = 0;
  for (const cwd of packages) {
    const all: string[] = [];
    sourceFiles(cwd, all, true);
    const packageManifest: Manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const command = packageManifest.scripts?.typecheck;
    if (!command) throw new Error(`${relative(root, cwd)} has no typecheck command`);
    const covered = programFiles(cwd, command);
    files += all.length;
    for (const file of all) {
      if (!covered.has(file)) unchecked.push(relative(root, file));
      if (readFileSync(file, 'utf8').includes('@ts-nocheck')) suppressed.push(relative(root, file));
    }
  }
  return { packages: packages.length, files, unchecked: unchecked.sort(), suppressed: suppressed.sort() };
}

if (import.meta.main) {
  const result = checkTypecheckCoverage(resolve(import.meta.dir, '..'));
  for (const [kind, files] of [['in NO invoked typecheck program', result.unchecked], ['disabling checking with @ts-nocheck', result.suppressed]] as const) {
    if (files.length) console.error(`\n${files.length} file(s) ${kind}:\n${files.map(file => `  ${file}`).join('\n')}`);
  }
  if (result.unchecked.length || result.suppressed.length) process.exit(1);
  console.log(`workspace typecheck coverage OK — ${result.packages} packages, ${result.files} TypeScript source, test, script, and configuration files`);
}
