import { segmentRegisterIndex } from "#x86/segments.js";
import type { SegmentRegister } from "#x86/types.js";
import type { SegmentDynamicOperandBinding, SegmentOperandBinding } from "../operands.js";
import type { ValueId, ValueTable } from "../values.js";
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
      finish.finishCurrentBody(
        {
          kind: "exit",
          exit: { class: "host", reason: "segmentLoad", payload: loadPayload(values, binding, selector) }
        },
        "fault"
      );
      return "terminated";
  }
}

function loadPayload(
  values: ValueTable,
  binding: SegmentOperandBinding | SegmentDynamicOperandBinding,
  selector: ValueId
): ValueId {
  switch (binding.kind) {
    case "segment":
      return staticLoadPayload(values, binding.channel.reg, selector);
    case "segmentDynamic":
      return dynamicLoadPayload(values, binding.index, selector);
  }
}

function staticLoadPayload(values: ValueTable, reg: SegmentRegister, selector: ValueId): ValueId {
  return values.binary(
    "or",
    values.const(segmentRegisterIndex(reg) << 16),
    values.truncate(16, selector)
  );
}

function dynamicLoadPayload(values: ValueTable, index: number, selector: ValueId): ValueId {
  return values.binary(
    "or",
    values.binary("shl", values.external(index), values.const(16)),
    values.truncate(16, selector)
  );
}
