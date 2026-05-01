// Ambient declaration for .wasm imports. Wrangler's `CompiledWasm` rule
// (see wrangler.jsonc) compiles these into `WebAssembly.Module` at build
// time and exposes them as the default export of the module specifier.
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
