import { registerAlias, registerAliasesByWidth } from "#x86/isa/registers.js";
import { widthMask, type OperandWidth, type Reg32, type RegisterAlias } from "#x86/isa/types.js";
import type { IrUnaryOperator } from "#x86/ir/model/types.js";
import { simplifyValue } from "./simplify.js";
import { bitRangeMask, normalizeU32Mask } from "./bits.js";
import { valueChildren } from "./walk.js";
import type {
  JitArchitecturalSlot,
  JitBinaryValue,
  JitCanonicalInputSlot,
  JitRegisterSlot,
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

  switch (left.kind) {
    case "reg32":
      return right.kind === "reg32" && left.reg === right.reg;
    case "reg16":
      return right.kind === "reg16" && left.reg === right.reg;
    case "reg8":
      return right.kind === "reg8" && left.reg === right.reg;
    case "aluFlags":
      return true;
  }
}

export function jitArchitecturalSlotsOverlap(left: JitArchitecturalSlot, right: JitArchitecturalSlot): boolean {
  if (left.kind === "aluFlags" || right.kind === "aluFlags") {
    return left.kind === "aluFlags" && right.kind === "aluFlags";
  }

  return jitRegisterSlotsOverlap(left, right);
}

export function jitRegisterSlotsOverlap(left: JitRegisterSlot, right: JitRegisterSlot): boolean {
  const leftAlias = jitRegisterSlotAlias(left);
  const rightAlias = jitRegisterSlotAlias(right);

  if (leftAlias.base !== rightAlias.base) {
    return false;
  }

  return leftAlias.bitOffset < rightAlias.bitOffset + rightAlias.width &&
    rightAlias.bitOffset < leftAlias.bitOffset + leftAlias.width;
}

export function jitRegisterSlotAlias(slot: JitRegisterSlot): RegisterAlias {
  return registerAlias(slot.reg);
}

export function jitRegisterSlotForAlias(alias: RegisterAlias): JitRegisterSlot {
  return jitRegisterSlotForWrite(alias.base, alias.bitOffset, alias.width);
}

export function jitRegisterSlotForWrite(
  reg: Reg32,
  bitOffset: number,
  width: OperandWidth
): JitRegisterSlot {
  switch (width) {
    case 8: {
      const alias = registerAliasesByWidth[8].find((candidate) =>
        candidate.base === reg && candidate.bitOffset === bitOffset
      );

      if (alias === undefined) {
        throw new Error(`unsupported JIT 8-bit register slot: ${reg}+${bitOffset}`);
      }

      return { kind: "reg8", reg: alias.name };
    }
    case 16: {
      const alias = registerAliasesByWidth[16].find((candidate) =>
        candidate.base === reg && candidate.bitOffset === bitOffset
      );

      if (alias === undefined) {
        throw new Error(`unsupported JIT 16-bit register slot: ${reg}+${bitOffset}`);
      }

      return { kind: "reg16", reg: alias.name };
    }
    case 32:
      if (bitOffset !== 0) {
        throw new Error(`unsupported JIT 32-bit register slot: ${reg}+${bitOffset}`);
      }

      return { kind: "reg32", reg };
  }
}

export function jitRegisterSlotValueMask(slot: JitRegisterSlot): number {
  return widthMask(jitRegisterSlotAlias(slot).width);
}

export function jitArchitecturalSlotKey(slot: JitArchitecturalSlot): string {
  switch (slot.kind) {
    case "reg32":
      return `reg32:${slot.reg}`;
    case "reg16":
      return `reg16:${slot.reg}`;
    case "reg8":
      return `reg8:${slot.reg}`;
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
      collectInputSlotReadByValueForMask(simplified.slot, requiredMask, slots);
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

function collectInputSlotReadByValueForMask(
  slot: JitCanonicalInputSlot,
  requiredMask: number,
  slots: Map<string, JitArchitecturalSlot>
): void {
  const readSlot = inputSlotReadByMask(slot, requiredMask);

  slots.set(jitArchitecturalSlotKey(readSlot), readSlot);
}

function inputSlotReadByMask(
  slot: JitCanonicalInputSlot,
  requiredMask: number
): JitArchitecturalSlot {
  switch (slot.kind) {
    case "aluFlags":
      return slot;
    case "reg32":
      return narrowestInputRegisterSlotForMask(slot.reg, requiredMask);
  }
}

function narrowestInputRegisterSlotForMask(
  reg: Reg32,
  requiredMask: number
): JitRegisterSlot {
  for (const width of [8, 16] as const) {
    const alias = registerAliasesByWidth[width].find((candidate) =>
      candidate.base === reg &&
      (requiredMask & ~bitRangeMask(candidate.bitOffset, candidate.width)) === 0
    );

    if (alias !== undefined) {
      return jitRegisterSlotForAlias(alias);
    }
  }

  return { kind: "reg32", reg };
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
