import type { MutableFlagStateView } from "#core/flags/view.js";
import type { MutableCoreStateView } from "#core/state/view.js";

export type CpuStateView = Readonly<{
  core: MutableCoreStateView;
  flags: MutableFlagStateView;
  instructionCount: number;
}>;
