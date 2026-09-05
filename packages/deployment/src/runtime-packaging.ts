import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

interface RuntimePackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export async function installedPackageRoot(name: string, from: string): Promise<string> {
  // Inspect the actual installed graph, not Bun's module cache or its built-in native-addon shims.
  // A release build can follow a dependency/patch install performed after this builder process started.
  let directory = await realpath(from);
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    const manifest = await lstat(join(candidate, 'package.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifest?.isFile()) return realpath(candidate);
    const parent = dirname(directory);
    if (parent === directory) throw Object.assign(new Error(`Cannot locate installed package ${name} from ${from}`), { code: 'MODULE_NOT_FOUND' });
    directory = parent;
  }
}

/** Preserve the installed dependency graph, hoisting only identical package instances. No symlinks escape the artifact. */
class RuntimeGraphCopier {
  private readonly destinations = new Map<string, string>();

  constructor(private readonly destination: string) {}

  async copy(name: string, from: string, parent = this.destination, optional = false): Promise<void> {
    let source: string;
    try {
      source = await installedPackageRoot(name, from);
    } catch (error) {
      if (optional && ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    let destination = join(this.destination, 'node_modules', name);
    for (let ancestor = parent;; ancestor = dirname(ancestor)) {
      const inherited = this.destinations.get(join(ancestor, 'node_modules', name));
      if (inherited === source) return;
      if (inherited) {
        destination = join(parent, 'node_modules', name);
        break;
      }
      if (ancestor === this.destination) break;
      if (dirname(ancestor) === ancestor) throw new Error(`Executable dependency ${name} escaped its package tree`);
    }
    const existing = this.destinations.get(destination);
    if (existing && existing !== source) throw new Error(`Conflicting executable dependency ${name} at ${destination}`);
    this.destinations.set(destination, source);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as RuntimePackage;
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const parts = relative(source, path).split(sep);
        if (parts.includes('node_modules')) return false;
        // onnxruntime-node publishes several host binaries in one package.
        if (name === 'onnxruntime-node' && parts[0] === 'bin' && parts[1]?.startsWith('napi-v')) {
          if (parts[2] && parts[2] !== process.platform) return false;
          if (parts[3] && parts[3] !== process.arch) return false;
        }
        return true;
      },
    });
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      const optionalDependency = manifest.optionalDependencies?.[dependency] !== undefined || manifest.peerDependenciesMeta?.[dependency]?.optional === true;
      await this.copy(dependency, source, destination, optionalDependency);
    }
  }
}

async function packageCudaProviders(outDir: string): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const transformerRoot = await installedPackageRoot('@huggingface/transformers', outDir);
  const onnxRoot = await installedPackageRoot('onnxruntime-node', transformerRoot);
  const binaryRoot = join(onnxRoot, 'bin/napi-v6/linux/x64');
  const providers = ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_shared.so', 'libonnxruntime_providers_tensorrt.so'];
  const present = async () => (await Promise.all(providers.map((name) => lstat(join(binaryRoot, name)).then(
    (metadata) => metadata.isFile(),
    (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; },
  )))).every(Boolean);
  if (await present()) return;
  // These are executable provider libraries, not model weights. Use this exact installed ORT release's official installer.
  const install = Bun.spawn([process.execPath, join(onnxRoot, 'script/install.js')], {
    cwd: onnxRoot,
    env: { ...process.env, BUN_BE_BUN: '1', ONNXRUNTIME_NODE_INSTALL: 'cuda12' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
  if (code !== 0 || !await present()) throw new Error(`Cannot package ONNX CUDA provider libraries: ${stdout}\n${stderr}`);
}

function pinnedVersion(value: string | undefined, label: string): string {
  if (!value || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(value)) throw new Error(`${label} has no exact upstream executable dependency version: ${value}`);
  return value;
}

function exportedLiteral(source: string, name: string): string {
  const match = new RegExp(`^export const ${name} = ("[^"\\n]+");$`, 'mu').exec(source);
  if (!match) throw new Error(`Upstream executable runtime pin ${name} is not a string literal`);
  return JSON.parse(match[1]!) as string;
}

async function installRuntime(path: string, dependencies: Record<string, string>, overrides?: Record<string, string>): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({
    private: true, type: 'module', dependencies, overrides,
    trustedDependencies: ['onnxruntime-node', 'sharp'],
  }));
  // This generated manifest contains no devDependencies. Production mode would suppress the provenance lockfile.
  const install = Bun.spawn([process.execPath, 'install', '--linker=hoisted', '--save-text-lockfile'], {
    cwd: path,
    env: { ...process.env, BUN_BE_BUN: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Executable side-runtime install failed: ${stdout}\n${stderr}`);
}

export interface PackagedOmpRuntime {
  agentRoot: string;
  legacyPlugin: Bun.BunPlugin;
  plugins: Bun.BunPlugin[];
  external: string[];
  define: Record<string, string>;
}

/** Build-time closure of optional executable code; model weights remain ordinary runtime data. */
export async function packageOmpRuntime(root: string, outDir: string): Promise<PackagedOmpRuntime> {
  const resolutionRoot = join(root, 'packages/account-omp');
  const agentRoot = await installedPackageRoot('@oh-my-pi/pi-coding-agent', resolutionRoot);
  const packageRoots: Record<string, string> = {};
  const canonicalPackageRoots: Record<string, string> = {};
  for (const [key, name] of Object.entries({ agent: 'pi-agent-core', ai: 'pi-ai', 'coding-agent': 'pi-coding-agent', natives: 'pi-natives', tui: 'pi-tui', utils: 'pi-utils' })) {
    packageRoots[key] = await installedPackageRoot(`@oh-my-pi/${name}`, resolutionRoot);
    canonicalPackageRoots[`@oh-my-pi/${name}`] = packageRoots[key]!;
  }
  const legacyScript = join(agentRoot, 'scripts/legacy-pi-virtual-module.ts');
  if (!(await readFile(legacyScript, 'utf8')).includes('collectBundledPiEntries(packageRoots:')) {
    throw new Error('Installed OMP lacks the executable packaging patch; run bun install --frozen-lockfile in the source workspace');
  }
  // This module belongs to the runtime-selected source workspace, not to the builder process's OMP graph.
  const { createLegacyPiVirtualModulePlugin } = await import(pathToFileURL(legacyScript).href);
  const legacyPlugin: Bun.BunPlugin = await createLegacyPiVirtualModulePlugin(packageRoots);
  const graph = new RuntimeGraphCopier(outDir);
  for (const dependency of ['@huggingface/transformers', 'sherpa-onnx-node', 'puppeteer-core', '@babel/parser']) await graph.copy(dependency, agentRoot);
  await packageCudaProviders(outDir);
  const mnemopiRoot = await installedPackageRoot('@oh-my-pi/pi-mnemopi', agentRoot);
  for (const asset of ['package.json', 'CHANGELOG.md', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'examples']) {
    await cp(join(agentRoot, asset), join(outDir, asset), { recursive: true, dereference: true });
  }
  const memoryManifest = JSON.parse(await readFile(join(mnemopiRoot, 'package.json'), 'utf8')) as RuntimePackage;
  const fastembedVersion = pinnedVersion(memoryManifest.peerDependencies?.fastembed, 'fastembed');
  const ttsSource = await readFile(join(agentRoot, 'src/tts/runtime.ts'), 'utf8');
  const kokoroPackage = exportedLiteral(ttsSource, 'KOKORO_PACKAGE');
  const kokoroVersion = pinnedVersion(exportedLiteral(ttsSource, 'KOKORO_VERSION'), kokoroPackage);
  const onnxPackage = exportedLiteral(ttsSource, 'ONNXRUNTIME_NODE_PACKAGE');
  const onnxVersion = pinnedVersion(exportedLiteral(ttsSource, 'ONNXRUNTIME_NODE_VERSION'), onnxPackage);
  const scratch = await mkdtemp(`${outDir}.runtime-build-`);
  try {
    const memorySource = join(scratch, 'memory');
    await installRuntime(memorySource, { fastembed: fastembedVersion });
    await graph.copy('fastembed', memorySource);
    const ttsRoot = join(outDir, 'runtime/tts');
    const ttsInstall = join(scratch, 'tts');
    await installRuntime(ttsInstall, { [kokoroPackage]: kokoroVersion }, { [onnxPackage]: onnxVersion });
    const ttsGraph = new RuntimeGraphCopier(ttsRoot);
    await ttsGraph.copy(kokoroPackage, ttsInstall);
    await writeFile(join(ttsRoot, 'package.json'), await readFile(join(ttsInstall, 'package.json')));
    await cp(join(ttsInstall, 'bun.lock'), join(ttsRoot, 'bun.lock'));
    await writeFile(join(outDir, 'runtime-dependencies.json'), JSON.stringify({ fastembed: fastembedVersion, [kokoroPackage]: kokoroVersion, ttsOnnxRuntime: onnxVersion }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const docs = await readFile(join(agentRoot, 'dist/docs-index.generated.txt'), 'utf8');
  if (!docs.includes('\n')) throw new Error('Installed OMP docs corpus is missing or malformed');
  // Dynamic require() dependencies remain genuine installed packages, with their native/wasm/data files beside them.
  const external = ['@huggingface/transformers', 'onnxruntime-node', 'fastembed', 'sherpa-onnx-node', 'puppeteer-core', '@babel/parser'];
  const plugins: Bun.BunPlugin[] = [{
    name: 'gitspace-packaged-omp-runtime',
    setup(build) {
      // Virtual-module resolveDir is not sufficient to select an isolated workspace dependency graph.
      // Keep canonical imports on the same installed sources that supplied the authenticated registry.
      build.onResolve({ filter: /^@oh-my-pi\//u }, ({ path: specifier }) => {
        const separator = specifier.indexOf('/', '@oh-my-pi/'.length);
        const name = separator === -1 ? specifier : specifier.slice(0, separator);
        const packageRoot = canonicalPackageRoots[name];
        if (!packageRoot) return;
        return { path: Bun.resolveSync(specifier, packageRoot) };
      });
      build.onLoad({ filter: /[/\\]pi-coding-agent[/\\]src[/\\]extensibility[/\\]plugins[/\\]legacy-pi-compat\.ts$/u }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const original = 'const IS_COMPILED_BINARY = isCompiledBinary();';
        if (!source.includes(original)) throw new Error('Unsupported OMP legacy-module selection contract');
        return { loader: 'ts', contents: source.replace(original, 'const IS_COMPILED_BINARY = true;') };
      });
      build.onLoad({ filter: /[/\\]pi-utils[/\\]src[/\\]runtime-install\.ts$/u }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const original = 'export async function ensureRuntimeInstalled(options: EnsureRuntimeInstalledOptions): Promise<string> {';
        if (!source.includes(original)) throw new Error('Unsupported OMP side-runtime installer contract');
        return { loader: 'ts', contents: source.replace(original, `${original}
  const packaged = options.install.dependencies;
  if (Object.keys(packaged).length === 1 && packaged.fastembed === ${JSON.stringify(fastembedVersion)}) return import.meta.dir;
  if (Object.keys(packaged).length === 1 && packaged[${JSON.stringify(kokoroPackage)}] === ${JSON.stringify(kokoroVersion)}) return path.join(import.meta.dir, 'runtime', 'tts');`) };
      });
      build.onLoad({ filter: /[/\\]pi-coding-agent[/\\]src[/\\]tts[/\\]runtime\.ts$/u }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const original = 'return path.join(path.dirname(getTinyModelsCacheDir()), "tts-runtime", `kokoro-${runtimeKey}`);';
        if (!source.includes(original)) throw new Error('Unsupported OMP TTS runtime directory contract');
        return { loader: 'ts', contents: source.replace(original, "return path.join(import.meta.dir, 'runtime', 'tts');") };
      });
      build.onLoad({ filter: /[/\\]pi-coding-agent[/\\]src[/\\]subprocess[/\\]worker-runtime\.ts$/u }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const original = 'const sharpStub = path.join(runtimeDir, "omp-sharp-stub.cjs");\n\tawait Bun.write(sharpStub, "module.exports = {};\\n");\n\tinstallRuntimeModuleResolver({ runtimeNodeModules: nodeModules, stubs: { sharp: sharpStub } });';
        if (!source.includes(original)) throw new Error('Unsupported OMP inference module resolver contract');
        // The real sharp dependency graph is shipped, so there is no stub and no write into the immutable artifact.
        return { loader: 'ts', contents: source.replace(original, 'installRuntimeModuleResolver({ runtimeNodeModules: nodeModules });') };
      });
    },
  }];
  return { agentRoot, legacyPlugin, plugins, external, define: { 'process.env.PI_DOCS_EMBED': JSON.stringify(docs) } };
}
