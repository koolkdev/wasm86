import type { ConditionCode } from "#core/flags/conditions.js";
import { invalidOpcode } from "#core/exceptions.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { SemanticOperandInfo, SemanticTemplate } from "#core/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import type { Value } from "./refs.js";
import {
  readStorage,
  resolveStorageRead,
  resolveStorageReadWrite,
  resolveStorageWrite,
  writeStorage
} from "./memory.js";

export function movSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const srcStorage = resolveStorageRead(s, v, context, src, width);
    const value = readStorage(s, v, srcStorage, width);

    const dstStorage = resolveStorageWrite(s, v, context, dst, width);

    writeStorage(s, v, dstStorage, value, width);
  };
}

export function movSregSemantic(registerWidth: Extract<OperandWidth, 16 | 32>): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const width = context.operandInfo(dst).storage === "mem" ? 16 : registerWidth;

    const srcStorage = resolveStorageRead(s, v, context, src, width);
    const value = readStorage(s, v, srcStorage, width);

    const dstStorage = resolveStorageWrite(s, v, context, dst, width);

    writeStorage(s, v, dstStorage, value, width);
  };
}

export function movToSregSemantic(): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const csLoad = segmentTargetIsCs(v, context.operandInfo(dst));

    if (csLoad !== undefined) {
      s.if(csLoad, (then) => then.cpuException(invalidOpcode()), "unlikely");
    }

    const srcStorage = resolveStorageRead(s, v, context, src, 16);

    s.set(dst, readStorage(s, v, srcStorage, 16), 16);
  };
}

function segmentTargetIsCs(v: ValueBuilder, info: SemanticOperandInfo): Value | undefined {
  if (info.segment === undefined) {
    return undefined;
  }

  switch (info.segment.kind) {
    case "static":
      return info.segment.reg === "cs" ? v.const(1) : undefined;
    case "dynamic":
      return v.compare(32, "eq", info.segment.index, v.const(segmentRegisterIndex("cs")));
  }
}

export function movzxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const srcStorage = resolveStorageRead(s, v, context, src, sourceWidth);
    const value = readStorage(s, v, srcStorage, sourceWidth);

    const dstStorage = resolveStorageWrite(s, v, context, dst, destinationWidth);

    writeStorage(s, v, dstStorage, value, destinationWidth);
  };
}

export function movsxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const srcStorage = resolveStorageRead(s, v, context, src, sourceWidth);
    const value = readStorage(s, v, srcStorage, sourceWidth, { signed: true });

    const dstStorage = resolveStorageWrite(s, v, context, dst, destinationWidth);

    writeStorage(s, v, dstStorage, value, destinationWidth);
  };
}

export function cmovSemantic(cc: ConditionCode, width: OperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const srcStorage = resolveStorageRead(s, v, context, src, width);
    const dstStorage = resolveStorageReadWrite(s, v, context, dst, width);

    const value = readStorage(s, v, srcStorage, width);
    const condition = s.condition(cc);
    const fallback = readStorage(s, v, dstStorage, width);
    const selected = v.select(condition, value, fallback);

    writeStorage(s, v, dstStorage, selected, width);
  };
}
