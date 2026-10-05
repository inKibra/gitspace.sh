import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Workspace exports contain TypeScript and .js source specifiers. Transpile in
// memory under Node 24, without building files or relying on Bun's import.meta.main.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts') || !url.startsWith('file:')) return nextLoad(url, context);
    const source = readFileSync(new URL(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
      fileName: new URL(url).pathname,
    }).outputText };
  },
});
// Registration must precede loading the TypeScript module graph.
const { main } = await import('./run.ts');
await main();
