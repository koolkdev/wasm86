import type { RunResult } from "#x86/execution/run-result.js";
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
  result: Partial<RunResult> & Pick<RunResult, "stopReason">;
  state: Partial<WasmCpuStateSnapshot>;
  memory?: readonly MemoryPatch[];
}>;
