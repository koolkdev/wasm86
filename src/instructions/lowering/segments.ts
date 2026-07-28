import { segmentRegisterIndex } from "#core/segments.js";
import type { SegmentOperandBinding } from "#instructions/lowering/bindings.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { InstructionTerminator } from "./terminal.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { BoundStateAccess } from "#core/state/access.js";

// A selector write's consequence is mode policy, not state: it may end the
// block (flat32) or check and continue (later modes).
export type SegmentWriteOutcome = "terminated" | "continues";

// flat32 has no descriptor state: every segment load leaves the engine
// through a host exit naming the register index and the selector.
export function emitSegmentLoad(
  terminator: InstructionTerminator,
  region: RegionBuilder,
  access: BoundStateAccess,
  binding: SegmentOperandBinding,
  selector: ValueId
): SegmentWriteOutcome {
  terminator.segmentLoad(region, access, segmentIndex(region, binding), selector);
  return "terminated";
}

function segmentIndex(region: RegionBuilder, binding: SegmentOperandBinding): ValueId {
  switch (binding.selection.kind) {
    case "static":
      return region.values.const(segmentRegisterIndex(binding.selection.reg));
    case "dynamic":
      return binding.selection.index;
  }
}
