import { assert } from "#common/assert.js";
import { createLayoutHostView } from "#compiler/layout/host-view.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import type { CpuException } from "#core/exceptions.js";
import type { SegmentRegister } from "#core/types.js";
import type { CompiledInterpreter } from "#interpreter/program.js";
import { decodeExit } from "./exit.js";
import { createCpuStateHostView } from "./host-view.js";
import type { CpuStateDefinition } from "./state.js";
import { instructionLimitField } from "./instruction-count.js";
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

type CpuInputs = Readonly<{
  state: CpuStateDefinition;
  sharedMemories: ReadonlyMap<ResourceRef, WebAssembly.Memory>;
  interpreter: CompiledInterpreter;
}>;

export function createCpu({
  state: stateDefinition,
  sharedMemories,
  interpreter
}: CpuInputs): Cpu {
  const { minPages, maxPages } = stateDefinition.memoryImport.limits;
  const cpuStateMemory = new WebAssembly.Memory({
    initial: minPages,
    ...(maxPages === undefined ? {} : { maximum: maxPages })
  });
  const memories = new Map(sharedMemories);

  assert(
    !memories.has(stateDefinition.resource),
    `execution state memory already bound: ${stateDefinition.resource.id}`
  );
  memories.set(stateDefinition.resource, cpuStateMemory);

  const instance = instantiateCompiledProgram(interpreter.program, {
    memories,
    functions: new Map()
  });
  const entry = instance.functionExports.get(interpreter.entry);

  assert(
    entry !== undefined,
    `missing Interpreter entry export ${interpreter.entry.id}`
  );
  assert(
    typeof entry === "function",
    `Interpreter entry export ${interpreter.entry.id} is not callable`
  );

  const storage = createLayoutHostView(cpuStateMemory, stateDefinition.layout);
  const state = createCpuStateHostView(storage);
  const runInterpreter = entry as () => bigint;

  return {
    state,
    run({ instructionBudget }): RunStop {
      assert(
        instructionBudget >= 0 &&
          instructionBudget <= maximumInstructionBudget,
        `instructionBudget must be in the supported modular deadline range: ` +
          instructionBudget
      );

      storage.writeField(
        instructionLimitField,
        state.instructionCount + instructionBudget
      );
      const encodedExit = runInterpreter();

      return decodeExit(encodedExit);
    }
  };
}
