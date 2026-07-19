import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { createFlagStateHostView } from "#core/flags/host-view.js";
import { createCoreStateHostView } from "#core/state/host-view.js";
import { instructionCountField } from "./instruction-count.js";
import { cpuState } from "./state.js";
import type { CpuStateView } from "./view.js";

export function createCpuStateHostView(memory: WebAssembly.Memory): CpuStateView {
  const storage = createLayoutHostView(memory, cpuState.layout);

  return {
    core: createCoreStateHostView(storage),
    flags: createFlagStateHostView(storage),
    get instructionCount(): number {
      return storage.readField(instructionCountField);
    }
  };
}
