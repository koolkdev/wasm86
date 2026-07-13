import { u32 } from "#core/numeric.js";
import { WasmInterpreterRuntime } from "#engines/interpreter/runtime.js";
import {
  WasmCompiledBlockCache,
  type WasmCompiledBlockCacheLike
} from "#engines/jit/compiled-blocks/wasm-cache.js";
import { WasmBlocksEngine } from "./engines/wasm-blocks.js";
import { WasmInterpreterEngine } from "./engines/wasm-interpreter.js";
import { createInstructionBudget } from "./execution/budget.js";
import type { RuntimeRunResult } from "./execution/engine-result.js";
import { RuntimeMode, type RuntimeMode as RuntimeModeValue } from "./execution/mode.js";
import { runRuntimeProgram, type RuntimeEngines } from "./execution/runner.js";
import { RuntimeCodeMap } from "./program/code-map.js";
import { loadProgramRegions } from "./program/loader.js";
import {
  codeRegionsFromProgram,
  normalizeProgramRegions,
  requiredProgramByteLength,
  type RuntimeProgramInput,
  type RuntimeProgramRegion
} from "./program/regions.js";
import { createWasmHostMemories, type WasmHostMemories } from "#wasm/host/memories.js";
import type { WasmCpuStateInit } from "#wasm/host/cpu-state.js";

export type RuntimeInstanceOptions = Readonly<{
  program?: RuntimeProgramInput;
  cpuState?: WasmCpuStateInit;
  memory?: RuntimeInstanceMemoryOptions;
  mode?: RuntimeModeValue;
  compiledBlocks?: WasmCompiledBlockCacheLike;
}>;

export type RuntimeInstanceMemoryOptions = Readonly<{
  guestBytes?: number;
  guest?: WebAssembly.Memory;
  cpuState?: WebAssembly.Memory;
}>;

export type RuntimeInstanceRunOptions = Readonly<{
  eip?: number;
  maxInstructions?: number;
}>;

const defaultMaxInstructions = 10_000;
const defaultGuestBytes = 1024 * 1024;

export class RuntimeInstance {
  readonly mode: RuntimeModeValue;
  readonly memories: WasmHostMemories;
  readonly codeMap: RuntimeCodeMap;
  readonly compiledBlocks: WasmCompiledBlockCacheLike;
  readonly engines: RuntimeEngines;

  constructor(options: RuntimeInstanceOptions = {}) {
    const program = normalizeProgramRegions(options.program);

    this.mode = options.mode ?? RuntimeMode.INTERPRETER;
    this.memories = createWasmHostMemories({
      guestMemoryByteLength: requiredGuestBytes(options.memory, program),
      ...(options.memory?.guest === undefined ? {} : { guestMemory: options.memory.guest }),
      ...(options.memory?.cpuState === undefined
        ? {}
        : { cpuStateMemory: options.memory.cpuState })
    });
    this.codeMap = new RuntimeCodeMap(codeRegionsFromProgram(program));
    this.compiledBlocks = options.compiledBlocks ?? new WasmCompiledBlockCache();
    this.engines = {
      interpreter: new WasmInterpreterEngine(
        new WasmInterpreterRuntime(this.memories.guestMemory, {
          cpuStateMemory: this.memories.cpuStateMemory
        })
      ),
      compiledBlocks: new WasmBlocksEngine(this.compiledBlocks)
    };

    loadProgramBytes(program, this.memories);
    this.memories.cpuState.load(options.cpuState ?? {});
  }

  run(options: RuntimeInstanceRunOptions = {}): RuntimeRunResult {
    if (options.eip !== undefined) {
      this.memories.cpuState.eip = u32(options.eip);
    }

    const engineResult = runRuntimeProgram(
      this.mode,
      { codeMap: this.codeMap, memories: this.memories },
      createInstructionBudget(
        this.memories.cpuState.instructionCount,
        options.maxInstructions ?? defaultMaxInstructions
      ),
      this.engines
    );

    if (engineResult.kind !== "done") {
      throw new Error(`runtime engine unavailable: ${engineResult.reason}`);
    }

    return engineResult.result;
  }

  clearCompiledBlocks(): void {
    this.compiledBlocks.clear?.();
  }
}

function requiredGuestBytes(
  memory: RuntimeInstanceMemoryOptions | undefined,
  program: readonly RuntimeProgramRegion[]
): number {
  return Math.max(
    memory?.guestBytes ?? defaultGuestBytes,
    requiredProgramByteLength(program) ?? 0
  );
}

function loadProgramBytes(
  program: readonly RuntimeProgramRegion[],
  memories: WasmHostMemories
): void {
  const fault = loadProgramRegions(memories.guestMemory, program);

  if (fault !== undefined) {
    throw new RangeError(`program byte load fault at 0x${fault.toString(16)}`);
  }
}
