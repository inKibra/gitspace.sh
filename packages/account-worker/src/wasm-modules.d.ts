// The worker build uploads each imported `.wasm` file as a precompiled module; workerd forbids compiling bytes at runtime.
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

// ast-grep's wasm-bindgen glue, instantiated by hand because a Worker imports a module, not its instance.
declare module '@ast-grep/wasm/wasm_bg.js' {
  export * from '@ast-grep/wasm';
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
