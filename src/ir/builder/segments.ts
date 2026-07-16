import { segmentRegisterIndex } from "#core/segments.js";
import type { SegmentDynamicOperandBinding, SegmentOperandBinding } from "../operands.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { FinishEmitter } from "./finish.js";

export type SegmentMode = "flat32";

// A selector write's consequence is mode policy, not state: it may end the
// block (flat32) or check and continue (later modes).
export type SegmentWriteOutcome = "terminated" | "continues";

// flat32 has no descriptor state: every segment load leaves the engine
// through a host exit naming the register index and the selector.
export function emitSegmentLoad(
  mode: SegmentMode,
  values: ValueTable,
  finish: FinishEmitter,
  binding: SegmentOperandBinding | SegmentDynamicOperandBinding,
  selector: ValueId
): SegmentWriteOutcome {
  switch (mode) {
    case "flat32":
      finish.segmentLoad(segmentIndex(values, binding), selector);
      return "terminated";
  }
}

function segmentIndex(
  values: ValueTable,
  binding: SegmentOperandBinding | SegmentDynamicOperandBinding
): ValueId {
  switch (binding.kind) {
    case "segment":
      return values.const(segmentRegisterIndex(binding.channel.reg));
    case "segmentDynamic":
      return values.external(binding.index);
  }
}
