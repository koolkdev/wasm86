import { integer, select, type BitValue } from "#compiler/function/values.js";
import { invalidOpcode } from "#core/exceptions.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { SegmentRef } from "#instructions/semantics/refs.js";
import type { OperandWidth } from "#core/types.js";

type MoveExtensionTarget<SourceWidth extends 8 | 16> =
  32 | ([SourceWidth] extends [8] ? 16 : never);

export function movSemantic(width: OperandWidth = 32): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, width);

    s.write(dst, value);
  };
}

export function movSregSemantic(registerWidth: 16 | 32): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, 16).unsigned.extend(registerWidth);

    s.write(dst, value, { memoryWidth: 16 });
  };
}

export function movToSregSemantic(): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const csLoad = segmentTargetIsCs(s.segment(dst));

    if (csLoad !== undefined) {
      s.if(csLoad, (failure) => failure.cpuException(invalidOpcode()), "unlikely");
    }

    s.write(dst, s.read(src, 16));
  };
}

function segmentTargetIsCs(segment: SegmentRef): BitValue | undefined {
  switch (segment.kind) {
    case "static":
      return segment.reg === "cs" ? integer(1, 1) : undefined;
    case "dynamic":
      return segment.index.eq(segmentRegisterIndex("cs"));
  }
}

export function movzxSemantic<SourceWidth extends 8 | 16>(
  sourceWidth: SourceWidth,
  destinationWidth: MoveExtensionTarget<NoInfer<SourceWidth>>
): InstructionSemantics {
  return extendedMove("unsigned", sourceWidth, destinationWidth);
}

export function movsxSemantic<SourceWidth extends 8 | 16>(
  sourceWidth: SourceWidth,
  destinationWidth: MoveExtensionTarget<NoInfer<SourceWidth>>
): InstructionSemantics {
  return extendedMove("signed", sourceWidth, destinationWidth);
}

function extendedMove(
  signedness: "signed" | "unsigned",
  sourceWidth: 8 | 16,
  destinationWidth: 16 | 32
): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, sourceWidth);
    const result =
      signedness === "signed"
        ? value.signed.extend(destinationWidth)
        : value.unsigned.extend(destinationWidth);

    s.write(dst, result);
  };
}

export function cmovSemantic(cc: ConditionCode, width: 16 | 32): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, width);
    const destination = s.update(dst, width);
    const condition = s.condition(cc);
    const fallback = s.read(destination);
    const selected = select(condition, value, fallback);

    s.write(destination, selected);
  };
}
