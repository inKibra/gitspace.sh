// The worker build uploads each imported `.wasm` file as a precompiled module; workerd forbids compiling bytes at runtime.
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
