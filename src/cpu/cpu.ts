import { assert } from "#common/assert.js";
import type { CpuException } from "#core/exceptions.js";
import type { MutableCpuStateView } from "#core/state/cpu-state.js";
import type { SegmentRegister } from "#core/types.js";
import { executionStateLayout } from "#ir/state-layout.js";
import {
  bindWasmInterpreter,
  type WasmInterpreterBinding
} from "#engines/interpreter/binding.js";
import { WasmCpuState } from "#wasm/host/cpu-state.js";
import { wasmPageByteLength } from "#wasm/abi.js";
import { decodeExit } from "./exit.js";

export type UnsupportedReason =
  | "unsupportedOpcode"
  | "unsupportedPrefixSemantics"
  | "unsupportedAddressingMode"
  | "unsupportedInstruction";

export type RunStop =
  | Readonly<{ kind: "hostTrap"; vector: number }>
  | Readonly<{ kind: "segmentLoad"; segment: SegmentRegister; selector: number }>
  | Readonly<{ kind: "unsupported"; reason: UnsupportedReason }>
  | Readonly<{ kind: "cpuException"; exception: CpuException<number> }>
  | Readonly<{ kind: "instructionLimit" }>;

export type CpuStateView = MutableCpuStateView & Readonly<{
  instructionCount: number;
}>;

export type CpuRunOptions = Readonly<{
  instructionBudget: number;
}>;

export type Cpu = Readonly<{
  state: CpuStateView;
  run(options: CpuRunOptions): RunStop;
}>;

type CpuContext = Readonly<{
  state: WasmCpuState;
  interpreter: WasmInterpreterBinding;
}>;

export function createCpu(guestMemory: WebAssembly.Memory): Cpu {
  const cpuStateMemory = new WebAssembly.Memory({
    initial: Math.ceil(executionStateLayout.byteLength / wasmPageByteLength)
  });
  const state = new WasmCpuState(cpuStateMemory);
  const interpreter = bindWasmInterpreter(
    guestMemory,
    cpuStateMemory
  );
  const context: CpuContext = { state, interpreter };

  return {
    state,
    run({ instructionBudget }): RunStop {
      assert(
        Number.isInteger(instructionBudget) &&
        instructionBudget >= 0 &&
        instructionBudget <= 0xffff_ffff,
        `instructionBudget must be a valid Wasm i32 fuel value: ${instructionBudget}`
      );

      const encodedExit = context.interpreter.run(instructionBudget);

      return decodeExit(encodedExit);
    }
  };
}
