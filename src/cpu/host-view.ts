import type { LayoutHostView } from "#compiler/layout/host-view.js";
import { createFlagStateHostView } from "#core/flags/host-view.js";
import { createCoreStateHostView } from "#core/state/host-view.js";
import { instructionCountField } from "./instruction-count.js";
import type { CpuStateView } from "./view.js";

export function createCpuStateHostView(storage: LayoutHostView): CpuStateView {
  return {
    core: createCoreStateHostView(storage),
    flags: createFlagStateHostView(storage),
    get instructionCount(): number {
      return storage.readField(instructionCountField);
    }
  };
}
