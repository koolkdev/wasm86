import type { RunResult } from "#x86/execution/run-result.js";
import { u32 } from "#x86/numeric.js";
import type { CpuState } from "#x86/state/cpu-state.js";
import { WasmInterpreterRuntime } from "#engines/interpreter/runtime.js";
import {
  WasmCompiledBlockCache,
  type WasmCompiledBlockCacheLike
} from "#engines/jit/compiled-blocks/wasm-cache.js";
import { WasmBlocksEngine } from "./engines/wasm-blocks.js";
import { WasmInterpreterEngine } from "./engines/wasm-interpreter.js";
import { createInstructionBudget } from "./execution/budget.js";
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

export type RuntimeInstanceOptions = Readonly<{
  program?: RuntimeProgramInput;
  state?: Partial<CpuState>;
  memory?: RuntimeInstanceMemoryOptions;
  mode?: RuntimeModeValue;
  compiledBlocks?: WasmCompiledBlockCacheLike;
}>;

export type RuntimeInstanceMemoryOptions = Readonly<{
  guestBytes?: number;
  guest?: WebAssembly.Memory;
  state?: WebAssembly.Memory;
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
      ...(options.memory?.state === undefined ? {} : { stateMemory: options.memory.state })
    });
    this.codeMap = new RuntimeCodeMap(codeRegionsFromProgram(program));
    this.compiledBlocks = options.compiledBlocks ?? new WasmCompiledBlockCache();
    this.engines = {
      interpreter: new WasmInterpreterEngine(
        new WasmInterpreterRuntime(this.memories.guestMemory, {
          stateMemory: this.memories.stateMemory
        })
      ),
      compiledBlocks: new WasmBlocksEngine(this.compiledBlocks)
    };

    loadProgramBytes(program, this.memories);
    this.memories.state.load(options.state ?? {});
  }

  run(options: RuntimeInstanceRunOptions = {}): RunResult {
    if (options.eip !== undefined) {
      this.memories.state.eip = u32(options.eip);
    }

    const engineResult = runRuntimeProgram(
      this.mode,
      { codeMap: this.codeMap, memories: this.memories },
      createInstructionBudget(
        this.memories.state.instructionCount,
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
  const fault = loadProgramRegions(memories.guest, program);

  if (fault !== undefined) {
    throw new RangeError(`program byte load fault at 0x${fault.faultAddress.toString(16)}`);
  }
}
