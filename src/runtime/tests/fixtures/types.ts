import type { RunResult } from "#driver/results.js";
import type { WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";

export type MemoryPatch = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

export type EngineFixture = Readonly<{
  name: string;
  bytes: readonly number[];
  initialState: Partial<WasmCpuStateSnapshot>;
  initialMemory?: readonly MemoryPatch[];
  expected: EngineExpectation;
}>;

export type EngineExpectation = Readonly<{
  result: Partial<RunResult> & Pick<RunResult, "stop">;
  state: Partial<WasmCpuStateSnapshot>;
  memory?: readonly MemoryPatch[];
}>;
