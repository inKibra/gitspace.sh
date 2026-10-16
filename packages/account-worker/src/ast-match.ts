/// <reference path="./wasm-modules.d.ts" />
import { Language, Parser } from 'web-tree-sitter';
import * as astGrep from '@ast-grep/wasm/wasm_bg.js';
import astGrepModule from '@ast-grep/wasm/wasm_bg.wasm';
import treeSitterModule from 'web-tree-sitter/web-tree-sitter.wasm';
import typescriptGrammar from 'tree-sitter-typescript/tree-sitter-typescript.wasm';
import tsxGrammar from 'tree-sitter-typescript/tree-sitter-tsx.wasm';

/** Grammars bundled into the Worker, by the name ast-grep registers them under; JavaScript parses as TypeScript. */
const grammars: Readonly<Record<string, WebAssembly.Module>> = { typescript: typescriptGrammar, tsx: tsxGrammar };
const languageByExtension: Readonly<Record<string, string>> = { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript', '.tsx': 'tsx', '.jsx': 'tsx' };

let ready: Promise<void> | undefined;
/**
 * Once per isolate. ast-grep asks web-tree-sitter to start and to load grammars by path; a Worker has neither files
 * nor runtime compilation, so both calls are pointed at the modules uploaded with the Worker.
 */
function initialize(): Promise<void> {
  ready ??= (async () => {
    const instance = new WebAssembly.Instance(astGrepModule, { './wasm_bg.js': astGrep });
    astGrep.__wbg_set_wasm(instance.exports);
    const start = instance.exports.__wbindgen_start;
    if (typeof start === 'function') start();
    const init = Parser.init.bind(Parser);
    Parser.init = () => init({ instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      const treeSitter = new WebAssembly.Instance(treeSitterModule, imports);
      done(treeSitter, treeSitterModule);
      return treeSitter.exports;
    } });
    const load = Language.load.bind(Language);
    Language.load = input => {
      const grammar = typeof input === 'string' ? grammars[input] : undefined;
      if (!grammar) throw new Error(`No bundled AST grammar ${String(input)}`);
      return load(grammar);
    };
    await astGrep.initializeTreeSitter();
    await astGrep.registerDynamicLanguage(Object.fromEntries(Object.keys(grammars).map(name => [name, { libraryPath: name }])));
  })();
  return ready;
}

/**
 * Whether any pattern matches `content` parsed as the language of any of `paths`. Paths in a language without a
 * bundled grammar are skipped; a pattern ast-grep cannot parse for that language is reported and skipped.
 */
export async function matchAstPatterns(content: string, paths: readonly string[], patterns: readonly string[]): Promise<boolean> {
  const languages = [...new Set(paths.flatMap(path => { const language = languageByExtension[/\.[^./]+$/u.exec(path.toLowerCase())?.[0] ?? '']; return language ? [language] : []; }))];
  if (!languages.length) return false;
  await initialize();
  for (const language of languages) {
    const root = astGrep.parse(language, content).root();
    for (const pattern of patterns) {
      try { if (root.find(pattern)) return true; }
      catch (error) { console.warn(`Unsupported AST rule pattern for ${language}: ${pattern}`, error); }
    }
  }
  return false;
}
