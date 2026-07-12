import type { DecodedExit } from "#wasm/exit.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";
import type { IsaDecodeReader } from "#x86/decoder/reader.js";

export type WasmCompiledBlockCodeMap = Readonly<{
  createReader(memory: WebAssembly.Memory): IsaDecodeReader;
}>;

export type CompiledBlockRun = Readonly<{
  exit: DecodedExit;
}>;

export type CompiledBlockHandle = Readonly<{
  run(): CompiledBlockRun;
}>;

export type CompiledBlockCache = Readonly<{
  getOrCompile(startEip: number, codeMap: WasmCompiledBlockCodeMap, memories: WasmHostMemories): CompiledBlockHandle | undefined;
}>;
