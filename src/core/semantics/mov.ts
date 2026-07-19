import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import { invalidOpcode } from "#core/exceptions.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { SegmentRef, Value } from "#core/semantics/refs.js";
import type { OperandWidth } from "#core/types.js";

export function movSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, { width });

    s.write(dst, value, { width });
  };
}

export function movSregSemantic(registerWidth: Extract<OperandWidth, 16 | 32>): SemanticTemplate {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, { width: registerWidth });

    s.write(dst, value, { width: registerWidth, memory: { width: 16 } });
  };
}

export function movToSregSemantic(): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const csLoad = segmentTargetIsCs(v, s.segment(dst));

    if (csLoad !== undefined) {
      s.if(
        csLoad,
        (failure) => failure.cpuException(invalidOpcode()),
        "unlikely"
      );
    }

    s.write(dst, s.read(src, { width: 16 }), { width: 16 });
  };
}

function segmentTargetIsCs(
  v: ValueBuilder,
  segment: SegmentRef
): Value | undefined {
  switch (segment.kind) {
    case "static":
      return segment.reg === "cs" ? v.const(1) : undefined;
    case "dynamic":
      return v.compare(
        32,
        "eq",
        segment.index,
        v.const(segmentRegisterIndex("cs"))
      );
  }
}

export function movzxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, { width: sourceWidth });

    s.write(dst, value, { width: destinationWidth });
  };
}

export function movsxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, { width: sourceWidth, signed: true });

    s.write(dst, value, { width: destinationWidth });
  };
}

export function cmovSemantic(cc: ConditionCode, width: OperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const value = s.read(src, { width });
    const destination = s.update(dst, { width });
    const condition = s.condition(cc);
    const fallback = destination.read(s);
    const selected = v.select(condition, value, fallback);

    destination.write(s, selected);
  };
}
