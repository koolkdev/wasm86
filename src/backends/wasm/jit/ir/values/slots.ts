import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import type { IrUnaryOperator } from "#x86/ir/model/types.js";
import { simplifyValue } from "./simplify.js";
import { bitRangeMask, normalizeU32Mask } from "./bits.js";
import { valueChildren } from "./walk.js";
import type {
  JitArchitecturalSlot,
  JitBinaryValue,
  JitValue
} from "./types.js";

export function slotsReadByValue(value: JitValue): readonly JitArchitecturalSlot[] {
  const slots = new Map<string, JitArchitecturalSlot>();

  collectSlotsReadByValue(simplifyValue(value), slots);
  return [...slots.values()];
}

export function slotsReadByValueForMask(
  value: JitValue,
  requiredMask: number
): readonly JitArchitecturalSlot[] {
  const slots = new Map<string, JitArchitecturalSlot>();

  collectSlotsReadByValueForMask(
    simplifyValue(value),
    normalizeU32Mask(requiredMask, "required value mask"),
    slots
  );
  return [...slots.values()];
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

function collectSlotsReadByValue(value: JitValue, slots: Map<string, JitArchitecturalSlot>): void {
  switch (value.kind) {
    case "input":
      slots.set(jitArchitecturalSlotKey(value.slot), value.slot);
      return;
    case "const":
    case "produced":
      return;
    default:
      for (const child of valueChildren(value)) {
        collectSlotsReadByValue(child, slots);
      }
  }
}

function collectSlotsReadByValueForMask(
  value: JitValue,
  requiredMask: number,
  slots: Map<string, JitArchitecturalSlot>
): void {
  if (requiredMask === 0) {
    return;
  }

  const simplified = simplifyValue(value);

  switch (simplified.kind) {
    case "const":
    case "produced":
      return;
    case "input":
      slots.set(jitArchitecturalSlotKey(simplified.slot), simplified.slot);
      return;
    case "value.unary":
      collectSlotsReadByValueForMask(
        simplified.value,
        unaryInputRequiredMask(simplified.operator, requiredMask),
        slots
      );
      return;
    case "value.binary": {
      const maskedValue = binaryAndMaskedValue(simplified);

      if (maskedValue !== undefined) {
        collectSlotsReadByValueForMask(
          maskedValue.value,
          (requiredMask & maskedValue.mask) >>> 0,
          slots
        );
        return;
      }

      collectSlotsReadByValue(simplified, slots);
      return;
    }
    case "extractBits":
      collectSlotsReadByValueForMask(
        simplified.value,
        extractBitsRequiredMask(requiredMask, simplified.bitOffset, simplified.width),
        slots
      );
      return;
    case "extractMaskedBits":
      collectSlotsReadByValueForMask(
        simplified.value,
        (requiredMask & simplified.mask) >>> 0,
        slots
      );
      return;
    case "insertBits": {
      const insertedMask = bitRangeMask(simplified.bitOffset, simplified.width);
      const valueRequiredMask = ((requiredMask & insertedMask) >>> simplified.bitOffset) >>> 0;

      collectSlotsReadByValueForMask(simplified.base, (requiredMask & ~insertedMask) >>> 0, slots);
      collectSlotsReadByValueForMask(simplified.value, valueRequiredMask, slots);
      return;
    }
    case "insertMaskedBits":
      collectSlotsReadByValueForMask(simplified.base, (requiredMask & ~simplified.mask) >>> 0, slots);
      collectSlotsReadByValueForMask(simplified.value, (requiredMask & simplified.mask) >>> 0, slots);
      return;
    default:
      collectSlotsReadByValue(simplified, slots);
  }
}

function unaryInputRequiredMask(
  operator: IrUnaryOperator,
  requiredMask: number
): number {
  switch (operator) {
    case "extend8_s":
      return requiredMask === 0 ? 0 : 0xff;
    case "extend16_s":
      return requiredMask === 0 ? 0 : 0xffff;
  }
}

function binaryAndMaskedValue(
  value: JitBinaryValue
): Readonly<{ value: JitValue; mask: number }> | undefined {
  if (value.operator !== "and") {
    return undefined;
  }

  if (value.a.kind === "const") {
    return { value: value.b, mask: value.a.value >>> 0 };
  }

  if (value.b.kind === "const") {
    return { value: value.a, mask: value.b.value >>> 0 };
  }

  return undefined;
}

function extractBitsRequiredMask(requiredMask: number, bitOffset: number, width: OperandWidth): number {
  const resultMask = widthMask(width) >>> 0;

  return (((requiredMask & resultMask) << bitOffset) >>> 0);
}
