import type { IsaOperandBinding } from "#instructions/decoder/types.js";
import { defaultSegmentForBase } from "#core/segments.js";
import {
  immBinding,
  memBinding,
  regBinding,
  segmentBinding,
  staticMemSegment,
  type OperandBinding
} from "./bindings.js";

export function staticOperandBinding(operand: IsaOperandBinding): OperandBinding {
  switch (operand.kind) {
    case "reg":
      return regBinding(operand.alias.name);
    case "segment":
      return segmentBinding(operand.reg);
    case "imm":
      // The decoder already applied the immediate's extension.
      return immBinding(operand.value);
    case "relTarget":
      // The decoder already resolved the absolute target.
      return immBinding(operand.target);
    case "mem":
      return memBinding(
        {
          base: operand.base,
          index: operand.index,
          scale: operand.scale,
          disp: operand.disp
        },
        staticMemSegment(operand.segment ?? defaultSegmentForBase(operand.base))
      );
  }
}
