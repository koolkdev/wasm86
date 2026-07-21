import { assert } from "#common/assert.js";
import { wasmPagesForByteLength } from "#compiler/program/pages.js";
import type { CpuException } from "#core/exceptions.js";
import type { SegmentRegister } from "#core/types.js";
import { u32 } from "#core/numeric.js";
import { bindInterpreter } from "#interpreter/binding.js";
import { decodeExit } from "./exit.js";
import { createCpuStateHostView } from "./host-view.js";
import { cpuState } from "./state.js";
import type { CpuStateView } from "./view.js";

export type RunStop =
  | Readonly<{ kind: "hostTrap"; vector: number }>
  | Readonly<{ kind: "segmentLoad"; segment: SegmentRegister; selector: number }>
  | Readonly<{ kind: "cpuException"; exception: CpuException<number> }>
  | Readonly<{ kind: "instructionLimit" }>;

export type CpuRunOptions = Readonly<{
  instructionBudget: number;
}>;

export type Cpu = Readonly<{
  state: CpuStateView;
  run(options: CpuRunOptions): RunStop;
}>;

export const maximumInstructionBudget = 0x7fff_ffff;

export function createCpu(guestMemory: WebAssembly.Memory): Cpu {
  const cpuStateMemory = new WebAssembly.Memory({
    initial: wasmPagesForByteLength(cpuState.layout.byteLength)
  });
  const state = createCpuStateHostView(cpuStateMemory);
  const interpreter = bindInterpreter({
    guestMemory,
    cpuStateMemory
  });

  return {
    state,
    run({ instructionBudget }): RunStop {
      assert(
        Number.isInteger(instructionBudget) &&
        instructionBudget >= 0 &&
        instructionBudget <= maximumInstructionBudget,
        `instructionBudget must be an integer in the supported modular deadline range: ` +
          instructionBudget
      );

      interpreter.setInstructionLimit(
        u32(state.instructionCount + instructionBudget)
      );
      const encodedExit = interpreter.run();

      return decodeExit(encodedExit);
    }
  };
}
