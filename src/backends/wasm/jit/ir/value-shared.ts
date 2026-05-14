import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import type { FlagProducerName } from "#x86/ir/model/types.js";
import {
  FLAG_PRODUCERS,
  flagProducerInputNames,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import { IR_ALU_FLAG_MASK, assertIrAluFlagMask } from "#x86/ir/model/flag-effects.js";
import type {
  JitArchitecturalSlot,
  JitFlagProducerValue,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";

export function bitRangeMask(bitOffset: number, width: OperandWidth): number {
  return width === 32 ? 0xffff_ffff : ((widthMask(width) << bitOffset) >>> 0);
}

export function bitRangeRelationship(
  leftOffset: number,
  leftWidth: OperandWidth,
  rightOffset: number,
  rightWidth: OperandWidth
): "same" | "disjoint" | "overlap" {
  const leftEnd = leftOffset + leftWidth;
  const rightEnd = rightOffset + rightWidth;

  if (leftOffset === rightOffset && leftWidth === rightWidth) {
    return "same";
  }

  return leftEnd <= rightOffset || rightEnd <= leftOffset ? "disjoint" : "overlap";
}

export function assertBitRange(bitOffset: number, width: OperandWidth, context: string): void {
  if (
    !Number.isInteger(bitOffset) ||
    bitOffset < 0 ||
    !isOperandWidth(width) ||
    bitOffset + width > 32
  ) {
    throw new Error(`${context} range must fit in 32 bits`);
  }
}

export function normalizeU32Mask(mask: number, context: string): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff_ffff) {
    throw new Error(`${context} must be a 32-bit unsigned mask`);
  }

  return mask >>> 0;
}

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

export function jitValueChildren(value: JitValue): readonly JitValue[] {
  switch (value.kind) {
    case "value.binary":
      return [value.a, value.b];
    case "value.unary":
      return [value.value];
    case "value.select":
      return [value.condition, value.whenTrue, value.whenFalse];
    case "extractBits":
    case "extractMaskedBits":
      return [value.value];
    case "insertBits":
    case "insertMaskedBits":
      return [value.base, value.value];
    case "flagProducer":
      return flagProducerInputValues(value);
    case "flagCondition":
      return [value.flags];
    case "const":
    case "reg":
    case "produced":
    case "input":
      return [];
  }
}

export function flagProducerInputValues(value: JitFlagProducerValue): readonly JitValue[] {
  return flagProducerInputNames(value.producer).map((key) =>
    requiredFlagProducerInput(value.producer, value.inputs, key)
  );
}

export function jitArchitecturalSlotsEqual(left: JitArchitecturalSlot, right: JitArchitecturalSlot): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  return left.kind === "aluFlags" || right.kind === "aluFlags" || left.reg === right.reg;
}

export function jitArchitecturalSlotKey(slot: JitArchitecturalSlot): string {
  switch (slot.kind) {
    case "reg32":
      return `reg32:${slot.reg}`;
    case "aluFlags":
      return "aluFlags";
  }
}

function isOperandWidth(width: number): width is OperandWidth {
  return width === 8 || width === 16 || width === 32;
}
