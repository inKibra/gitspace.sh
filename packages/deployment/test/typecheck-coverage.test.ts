import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTypecheckCoverage, workspaceDirectories } from '../../../scripts/check-typecheck-coverage';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-coverage-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    workspaces: ['modules/*'],
    scripts: { typecheck: 'bun run typecheck:packages', 'typecheck:packages': 'bun run --workspaces --if-present typecheck' },
  }));
  const cwd = join(root, 'modules', 'catalog');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsgo --noEmit -p tsconfig.json' } }));
  writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src/index.ts'] }));
  writeFileSync(join(cwd, 'src', 'index.ts'), 'export const included = true;');
  return root;
}

test('uses the root workspace scope and catches source, test, script and configuration omissions', () => {
  const root = fixture();
  const cwd = join(root, 'modules', 'catalog');
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'scripts', 'forgotten.ts'), 'export const script = true;');
  writeFileSync(join(cwd, 'build.config.ts'), 'export const config = true;');
  writeFileSync(join(cwd, 'src', 'forgotten.ts'), 'export const source = true;');
  writeFileSync(join(cwd, 'test', 'forgotten.test.ts'), 'export const test = true;');
  // A config which is never invoked must not grant coverage.
  writeFileSync(join(cwd, 'tsconfig.test.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['test/**/*.ts'] }));
  expect(workspaceDirectories(root)).toEqual([cwd]);
  expect(checkTypecheckCoverage(root).unchecked).toEqual([
    'modules/catalog/build.config.ts',
    'modules/catalog/scripts/forgotten.ts',
    'modules/catalog/src/forgotten.ts',
    'modules/catalog/test/forgotten.test.ts',
  ]);
  writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src/**/*.ts', 'scripts/**/*.ts', '*.ts'] }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsgo --noEmit -p tsconfig.json && tsgo --noEmit -p tsconfig.test.json' } }));
  expect(checkTypecheckCoverage(root).unchecked).toEqual([]);
});

test('rejects a workspace without typecheck even though bun uses if-present', () => {
  const root = fixture();
  writeFileSync(join(root, 'modules/catalog/package.json'), '{}');
  expect(() => checkTypecheckCoverage(root)).toThrow('has no typecheck command');
});

test('rejects a root command narrowed to a runtime-only filter', () => {
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['modules/*'], scripts: { typecheck: "bun run --filter './packages/runtime-*' --if-present typecheck" } }));
  expect(() => checkTypecheckCoverage(root)).toThrow('must invoke bun run --workspaces');
});
