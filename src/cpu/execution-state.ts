import { FieldRef } from "#compiler/layout/handles.js";
import type { Layout } from "#compiler/layout/layout.js";
import { layoutStructure } from "#compiler/layout/structure.js";
import { u32 } from "#core/numeric.js";

export const cpuExecutionStateFields = {
  instructionCount: new FieldRef("cpu.execution.instruction-count", "u32")
} as const;

export const cpuExecutionState = layoutStructure("cpu.execution", [
  cpuExecutionStateFields.instructionCount
]);

export interface CpuExecutionStateHostView {
  instructionCount: number;
}

export function createCpuExecutionStateHostView(
  memory: WebAssembly.Memory,
  layout: Layout
): CpuExecutionStateHostView {
  return new CpuExecutionStateHostViewImpl(memory, layout);
}

class CpuExecutionStateHostViewImpl implements CpuExecutionStateHostView {
  readonly #memory: WebAssembly.Memory;
  readonly #layout: Layout;

  constructor(
    memory: WebAssembly.Memory,
    layout: Layout
  ) {
    this.#memory = memory;
    this.#layout = layout;
  }

  get instructionCount(): number {
    const field = this.#layout.field(cpuExecutionStateFields.instructionCount);

    return new DataView(this.#memory.buffer).getUint32(field.offset, true);
  }

  set instructionCount(value: number) {
    const field = this.#layout.field(cpuExecutionStateFields.instructionCount);

    new DataView(this.#memory.buffer).setUint32(field.offset, u32(value), true);
  }
}
