import { deepStrictEqual, strictEqual } from "node:assert";

import { decodeIsaBlock } from "#core/decoder/decode-block.js";
import type { RunResult } from "#driver/results.js";
import { readWasmCpuState, type WasmCpuStateField } from "#test/support/cpu-state.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { UnsupportedWasmCodegenError } from "#wasm/errors.js";
import { decodeExit } from "#wasm/exit.js";
import { encodeInterpreterModule } from "#engines/interpreter/module.js";
import type { CompiledBlockCache } from "#engines/jit/compiled-blocks/block-cache.js";
import { WasmBlocksEngine } from "#runtime/engines/wasm-blocks.js";
import { WasmInterpreterEngine, type WasmInterpreter } from "#runtime/engines/wasm-interpreter.js";
import { engineUnavailable, type RuntimeEngineResult } from "#runtime/execution/engine-result.js";
import type { RuntimeEngines } from "#runtime/execution/runner.js";
import { RuntimeCodeMap } from "#runtime/program/code-map.js";
import { loadProgramRegions } from "#runtime/program/loader.js";
import { codeRegionsFromProgram, type RuntimeProgramRegion } from "#runtime/program/regions.js";
import { compileActionWasmBlockHandle } from "#engines/jit/block-handle.js";
import type { WasmHostMemories } from "#wasm/host/memories.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { readBackingByte, writeBackingBytes } from "#memory/bytes.js";
import { engineFixtureStartAddress } from "./programs.js";
import type { EngineFixture, MemoryPatch } from "./types.js";

export type PreparedEngineFixture = Readonly<{
  codeMap: RuntimeCodeMap;
  memories: WasmHostMemories;
}>;

let interpreterModule: WebAssembly.Module | undefined;

export function prepareEngineFixture(fixture: EngineFixture): PreparedEngineFixture {
  const memories = createWasmHostMemories();
  const programRegion: RuntimeProgramRegion = {
    baseAddress: engineFixtureStartAddress,
    bytes: fixture.bytes
  };

  writeMemoryPatches(memories, fixture.initialMemory ?? []);

  const fault = loadProgramRegions(memories.guestMemory, [programRegion]);

  if (fault !== undefined) {
    throw new Error(`failed to load fixture code at 0x${fault.toString(16)}`);
  }

  memories.cpuState.load(fixture.initialState);

  return {
    codeMap: new RuntimeCodeMap(codeRegionsFromProgram([programRegion])),
    memories
  };
}

export function instantiateFixtureWasmInterpreter(memories: WasmHostMemories): WasmInterpreter {
  interpreterModule ??= new WebAssembly.Module(encodeInterpreterModule().bytes);

  const instance = new WebAssembly.Instance(interpreterModule, {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: memories.cpuStateMemory,
      [wasmImport.guestMemoryName]: memories.guestMemory
    }
  });
  const run = instance.exports[wasmBlockExportName];

  if (typeof run !== "function") {
    throw new Error(`expected exported function '${wasmBlockExportName}'`);
  }

  return {
    run(fuel) {
      return decodeExit((run as (fuel: number) => bigint)(fuel));
    }
  };
}

export function createFixtureCompiledBlockCache(): CompiledBlockCache {
  return {
    getOrCompile(startEip, codeMap, memories) {
      const block = decodeIsaBlock(codeMap.createReader(memories.guestMemory), startEip, {
        maxInstructions: 1024
      });

      if (block.instructions.length === 0) {
        return undefined;
      }

      try {
        return compileActionWasmBlockHandle([block], {
          cpuStateMemory: memories.cpuStateMemory,
          guestMemory: memories.guestMemory,
          blockKey: startEip
        });
      } catch (error: unknown) {
        if (error instanceof UnsupportedWasmCodegenError) {
          return undefined;
        }

        throw error;
      }
    }
  };
}

export function createFixtureRuntimeEngines(memories: WasmHostMemories): RuntimeEngines {
  return {
    interpreter: new WasmInterpreterEngine(instantiateFixtureWasmInterpreter(memories)),
    compiledBlocks: new WasmBlocksEngine(createFixtureCompiledBlockCache())
  };
}

export function createFixtureInterpreterOnlyEngines(memories: WasmHostMemories): RuntimeEngines {
  return {
    interpreter: new WasmInterpreterEngine(instantiateFixtureWasmInterpreter(memories)),
    compiledBlocks: {
      run() {
        throw new Error("compiled-blocks engine should not run in interpreter mode");
      }
    }
  };
}

export function createFixtureCompiledOnlyEngines(_memories: WasmHostMemories): RuntimeEngines {
  return {
    interpreter: {
      run() {
        throw new Error("compiled-blocks fixture unexpectedly fell back to the interpreter");
      }
    },
    compiledBlocks: new WasmBlocksEngine(createFixtureCompiledBlockCache())
  };
}

export function createFixtureFallbackEngines(memories: WasmHostMemories): RuntimeEngines {
  return {
    interpreter: new WasmInterpreterEngine(instantiateFixtureWasmInterpreter(memories)),
    compiledBlocks: {
      run() {
        return engineUnavailable("unsupported-block");
      }
    }
  };
}

export function assertEngineFixtureResult(
  fixture: EngineFixture,
  result: RuntimeEngineResult,
  memories: WasmHostMemories
): void {
  strictEqual(result.kind, "done");

  if (result.kind !== "done") {
    return;
  }

  assertResultFields(fixture, result.result);
  assertStateFields(fixture, memories);
  assertMemoryPatches(memories, fixture.expected.memory ?? []);
}

function assertResultFields(fixture: EngineFixture, actual: RunResult): void {
  for (const [field, expected] of Object.entries(fixture.expected.result)) {
    deepStrictEqual(
      actual[field as keyof typeof actual],
      expected,
      `${fixture.name}: expected result.${field}`
    );
  }
}

function assertStateFields(fixture: EngineFixture, memories: WasmHostMemories): void {
  const actual = readWasmCpuState(memories.cpuState);

  for (const [field, expected] of Object.entries(fixture.expected.state)) {
    strictEqual(
      actual[field as WasmCpuStateField],
      expected,
      `${fixture.name}: expected state.${field}`
    );
  }
}

function assertMemoryPatches(memories: WasmHostMemories, patches: readonly MemoryPatch[]): void {
  for (const patch of patches) {
    for (let index = 0; index < patch.bytes.length; index += 1) {
      const address = patch.address + index;
      const read = readBackingByte(memories.guestMemory, address);
      strictEqual(read, patch.bytes[index] ?? 0, `expected memory byte at 0x${address.toString(16)}`);
    }
  }
}

function writeMemoryPatches(memories: WasmHostMemories, patches: readonly MemoryPatch[]): void {
  for (const patch of patches) {
    const fault = writeBackingBytes(memories.guestMemory, patch.address, patch.bytes);
    if (fault !== undefined) {
      throw new Error(`failed to write fixture memory at 0x${fault.toString(16)}`);
    }
  }
}
