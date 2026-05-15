import { type OperandWidth } from "#x86/isa/types.js";
import type { FlagProducerName } from "#x86/ir/model/types.js";
import {
  FLAG_PRODUCERS,
  flagProducerInputNames,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import { IR_ALU_FLAG_MASK, assertIrAluFlagMask } from "#x86/ir/model/flag-effects.js";
import type {
  JitFlagProducerValue,
  JitValue
} from "./types.js";

export function normalizeFlagProducerMask(producer: FlagProducerName, mask: number): number {
  assertIrAluFlagMask(mask, "flagProducer mask");
  const writtenMask = FLAG_PRODUCERS[producer].writtenMask;

  if ((mask & ~writtenMask) !== 0) {
    throw new Error(`flagProducer mask includes bits not written by ${producer}`);
  }

  return mask & IR_ALU_FLAG_MASK;
}

export function normalizeOptionalWidth(width: OperandWidth | undefined): OperandWidth | undefined {
  if (width === undefined || width === 32) {
    return undefined;
  }

  if (!isOperandWidth(width)) {
    throw new Error(`JIT value width is not supported: ${width}`);
  }

  return width;
}

export function flagProducerWidth(value: Pick<JitFlagProducerValue, "width">): OperandWidth {
  return value.width ?? 32;
}

export function flagProducerInputValues(value: JitFlagProducerValue): readonly JitValue[] {
  return flagProducerInputNames(value.producer).map((key) =>
    requiredFlagProducerInput(value.producer, value.inputs, key)
  );
}

function isOperandWidth(width: number): width is OperandWidth {
  return width === 8 || width === 16 || width === 32;
}
