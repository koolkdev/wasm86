import { assert } from "#common/assert.js";
import type { CpuException } from "#core/exceptions.js";
import type { SegmentRegister } from "#core/types.js";
import { bindWasmInterpreter } from "#engines/interpreter/binding.js";
import { wasmPageByteLength } from "#wasm/abi.js";
import { decodeExit } from "./exit.js";
import { createCpuStateHostView } from "./host-view.js";
import { cpuState } from "./state.js";
import type { CpuStateView } from "./view.js";

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

export type CpuRunOptions = Readonly<{
  instructionBudget: number;
}>;

export type Cpu = Readonly<{
  state: CpuStateView;
  run(options: CpuRunOptions): RunStop;
}>;

export function createCpu(guestMemory: WebAssembly.Memory): Cpu {
  const cpuStateMemory = new WebAssembly.Memory({
    initial: Math.ceil(cpuState.layout.byteLength / wasmPageByteLength)
  });
  const state = createCpuStateHostView(cpuStateMemory);
  const interpreter = bindWasmInterpreter(
    guestMemory,
    cpuStateMemory
  );

  return {
    state,
    run({ instructionBudget }): RunStop {
      assert(
        Number.isInteger(instructionBudget) &&
        instructionBudget >= 0 &&
        instructionBudget <= 0xffff_ffff,
        `instructionBudget must be a valid Wasm i32 fuel value: ${instructionBudget}`
      );

      const encodedExit = interpreter.run(instructionBudget);

      return decodeExit(encodedExit);
    }
  };
}
