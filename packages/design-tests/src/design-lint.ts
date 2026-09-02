import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

type GovernedProperty = 'color' | 'box-shadow' | 'border-radius' | 'motion' | 'typography';
interface BaselineEntry { rule: string; path: string; reason: string; properties?: Partial<Record<GovernedProperty, number>> }
interface Baseline { version: number; maximumEntries: number; entries: BaselineEntry[] }
interface Violation { rule: string; path: string; line: number; property: string; detail: string }

const root = resolve(import.meta.dir, '../../..');
const baseline = JSON.parse(await readFile(resolve(import.meta.dir, '../design-lint-baseline.json'), 'utf8')) as Baseline;
const baselineCeiling = 7;
const baselineViolationCeiling = 264;
const baselineViolationCount = baseline.entries.reduce((count, entry) => count + (entry.rule === 'direct-base-ui' ? 1 : Object.values(entry.properties ?? {}).reduce((sum, value) => sum + value, 0)), 0);
if (baseline.version !== 1) throw new Error(`Unsupported design lint baseline version ${baseline.version}`);
if (baseline.maximumEntries !== baselineCeiling || baseline.entries.length > baselineCeiling) throw new Error(`Design baseline may only shrink from ${baselineCeiling}; found ceiling ${baseline.maximumEntries} with ${baseline.entries.length} entries`);
if (baselineViolationCount > baselineViolationCeiling) throw new Error(`Design debt grew to ${baselineViolationCount}; ceiling is ${baselineViolationCeiling}`);
if (new Set(baseline.entries.map((entry) => `${entry.rule}:${entry.path}`)).size !== baseline.entries.length) throw new Error('Design baseline contains duplicate entries');
if (baseline.entries.some((entry) => entry.reason.trim().length < 16)) throw new Error('Every design baseline entry requires a specific reason');

const legacyStyleByPath = Object.fromEntries(baseline.entries.filter((entry) => entry.rule === 'legacy-stylesheet').map((entry) => [entry.path, entry])) as Record<string, BaselineEntry>;
const approvedBaseImports = new Set(baseline.entries.filter((entry) => entry.rule === 'direct-base-ui').map((entry) => entry.path));
const violations: Violation[] = [];

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'styled-system').map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? collect(path) : Promise.resolve([path]);
  }));
  return paths.flat();
}

function report(rule: string, path: string, source: string, index: number, property: string, detail: string): void {
  violations.push({ rule, path, line: source.slice(0, index).split('\n').length, property, detail });
}

const files = (await Promise.all([collect(resolve(root, 'packages/web/src')), collect(resolve(root, 'packages/ui/src'))])).flat();
for (const absolutePath of files) {
  const path = relative(root, absolutePath).replaceAll('\\', '/');
  const extension = extname(path);
  if (!['.css', '.ts', '.tsx'].includes(extension)) continue;
  const source = await readFile(absolutePath, 'utf8');

  if ((extension === '.ts' || extension === '.tsx') && !path.startsWith('packages/ui/')) {
    for (const match of source.matchAll(/from\s+['"](@base-ui\/react(?:\/[^'"]+)?)['"]/g)) {
      if (!approvedBaseImports.has(path)) report('direct-base-ui', path, source, match.index, 'import', `Import ${match[1]} through @gitspace/ui`);
    }
    for (const match of source.matchAll(/style=\{\{([^}]+)\}\}/g)) {
      const body = match[1] ?? '';
      const dynamicGeometry = /(?:width|height|top|left|right|bottom)(?:\s*:|(?=\s*(?:,|$)))/.test(body);
      const customProperty = /['"]--[\w-]+['"]\s*:/.test(body);
      const tokenVariable = /var\(--|STATUS_COLOR/.test(body);
      if (!dynamicGeometry && !customProperty && !tokenVariable) report('token-bypassing-inline-style', path, source, match.index, 'style', 'Move product styling to a token-backed class');
    }
  }

  if (extension === '.css' && path !== 'packages/ui/src/styles.css' && path !== 'packages/ui/src/fluid-theme.css') {
    const checks: Array<[GovernedProperty, RegExp, string]> = [
      ['color', /(?:^|[\s:(,])(?:#[0-9a-f]{3,8}|rgba?\()/gim, 'Use a semantic color token'],
      ['box-shadow', /box-shadow\s*:\s*(?![^;\n]*var\()[^;\n]+/gim, 'Use a shadow token'],
      ['border-radius', /border-radius\s*:\s*(?![^;\n]*var\()[^;\n]+/gim, 'Use a radius token'],
      ['motion', /transition(?:-duration)?\s*:\s*(?![^;\n]*var\()[^;\n]+/gim, 'Use exact transition properties and motion tokens'],
      ['typography', /(?:font-size\s*:\s*(?![^;\n]*var\()[^;\n]+|font\s*:(?!\s*inherit)(?![^;\n]*var\(--text-)\s*[^;\n]+)/gim, 'Use a semantic typography role'],
    ];
    for (const [property, pattern, detail] of checks) {
      const matches = [...source.matchAll(pattern)];
      const allowance = legacyStyleByPath[path]?.properties?.[property] ?? 0;
      for (const match of matches.slice(allowance)) report('literal-product-style', path, source, match.index, property, detail);
      if (matches.length < allowance) violations.push({ rule: 'stale-baseline', path, line: 1, property, detail: `Lower the paid-down allowance from ${allowance} to ${matches.length}` });
    }
  }
}

for (const entry of baseline.entries) {
  try { await readFile(resolve(root, entry.path), 'utf8'); } catch { violations.push({ rule: 'stale-baseline', path: entry.path, line: 1, property: entry.rule, detail: 'Remove the baseline entry because the file no longer exists' }); }
}
for (const path of approvedBaseImports) {
  const source = await readFile(resolve(root, path), 'utf8');
  if (!source.includes('@base-ui/react')) violations.push({ rule: 'stale-baseline', path, line: 1, property: 'import', detail: 'Remove this paid-down direct Base UI baseline entry' });
}

if (violations.length) {
  for (const violation of violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) console.error(`${violation.path}:${violation.line} [${violation.rule}] ${violation.property}: ${violation.detail}`);
  process.exitCode = 1;
} else {
  console.log(`Design lint passed. Legacy baseline: ${baselineViolationCount} violations across ${baseline.entries.length} entries.`);
}
