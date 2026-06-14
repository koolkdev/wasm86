import type { DecodedExit } from "#wasm/exit.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";
import type { RegionedDecodeReader } from "#x86/decoder/guest-memory-reader.js";
import type { GuestMemory } from "#x86/memory/guest-memory.js";

export type WasmCompiledBlockCodeMap = Readonly<{
  createReader(memory: GuestMemory): RegionedDecodeReader;
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
