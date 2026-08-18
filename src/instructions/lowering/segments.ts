import { segmentRegisterIndex } from "#core/segments.js";
import type { SegmentOperandBinding } from "#instructions/lowering/bindings.js";
import { i32, type I32Value } from "#compiler/function/values.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { InstructionTerminator } from "./terminal.js";
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
  selector: I32Value
): SegmentWriteOutcome {
  terminator.segmentLoad(region, access, segmentIndex(binding), selector);
  return "terminated";
}

function segmentIndex(binding: SegmentOperandBinding): I32Value {
  switch (binding.selection.kind) {
    case "static":
      return i32(segmentRegisterIndex(binding.selection.reg));
    case "dynamic":
      return binding.selection.index.unsigned.extend(32);
  }
}
