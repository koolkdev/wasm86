import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import type { RuntimeRunResult } from "#runtime/execution/engine-result.js";

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
  result: Partial<RuntimeRunResult> & Pick<RuntimeRunResult, "stop">;
  state: Partial<WasmCpuStateSnapshot>;
  memory?: readonly MemoryPatch[];
}>;
