import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import type { IrUnaryOperator } from "#x86/ir/model/types.js";
import {
  flagProducerInputNames,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import { i32 } from "#x86/state/cpu-state.js";
import { simplifyJitValue } from "#backends/wasm/jit/ir/value-simplify.js";
import {
  bitRangeMask,
  flagProducerInputValues,
  flagProducerWidth,
  jitArchitecturalSlotKey,
  jitValueChildren,
  normalizeFlagProducerMask,
  normalizeU32Mask
} from "#backends/wasm/jit/ir/value-shared.js";
import type {
  JitArchitecturalSlot,
  JitBinaryValue,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";

export function jitValueMaterializationSlots(value: JitValue): readonly JitArchitecturalSlot[] {
  const slots = new Map<string, JitArchitecturalSlot>();

  collectMaterializationSlots(simplifyJitValue(value), slots);
  return [...slots.values()];
}

export function jitValueMaterializationSlotsForMask(
  value: JitValue,
  requiredMask: number
): readonly JitArchitecturalSlot[] {
  const slots = new Map<string, JitArchitecturalSlot>();

  collectMaterializationSlotsForMask(
    simplifyJitValue(value),
    normalizeU32Mask(requiredMask, "required materialization mask"),
    slots
  );
  return [...slots.values()];
}

export function jitValueCost(value: JitValue): number {
  const simplified = simplifyJitValue(value);

  if (simplified !== value) {
    return jitValueCost(simplified);
  }

  switch (value.kind) {
    case "value.binary":
      return 1 + jitValueCost(value.a) + jitValueCost(value.b);
    case "value.unary":
      return 1 + jitValueCost(value.value);
    case "value.select":
      return 1 + jitValueCost(value.condition) + jitValueCost(value.whenTrue) + jitValueCost(value.whenFalse);
    case "extractBits":
    case "extractMaskedBits":
    case "flagCondition":
      return 1 + jitValueCost(value.kind === "flagCondition" ? value.flags : value.value);
    case "insertBits":
    case "insertMaskedBits":
      return 1 + jitValueCost(value.base) + jitValueCost(value.value);
    case "flagProducer":
      return 1 + flagProducerInputValues(value).reduce((cost, input) => cost + jitValueCost(input), 0);
    case "const":
    case "reg":
    case "produced":
    case "input":
      return 1;
  }
}

export function jitValueKey(value: JitValue): string {
  const simplified = simplifyJitValue(value);

  if (simplified !== value) {
    return jitValueKey(simplified);
  }

  switch (value.kind) {
    case "const":
      return `const:${value.type}:${i32(value.value)}`;
    case "reg":
      return `reg:${value.reg}`;
    case "produced":
      return `produced:${value.type}:${value.id}`;
    case "input":
      return `input:${jitArchitecturalSlotKey(value.slot)}`;
    case "value.binary":
      return `binary:${value.type}:${value.operator}:${jitValueKey(value.a)}:${jitValueKey(value.b)}`;
    case "value.unary":
      return `unary:${value.type}:${value.operator}:${jitValueKey(value.value)}`;
    case "value.select":
      return `select:${value.type}:${jitValueKey(value.condition)}:${jitValueKey(value.whenTrue)}:${jitValueKey(value.whenFalse)}`;
    case "extractBits":
      return `extractBits:${value.bitOffset}:${value.width}:${jitValueKey(value.value)}`;
    case "insertBits":
      return `insertBits:${value.bitOffset}:${value.width}:${jitValueKey(value.base)}:${jitValueKey(value.value)}`;
    case "extractMaskedBits":
      return `extractMaskedBits:${normalizeU32Mask(value.mask, "extractMaskedBits mask")}:${jitValueKey(value.value)}`;
    case "insertMaskedBits":
      return `insertMaskedBits:${normalizeU32Mask(value.mask, "insertMaskedBits mask")}:${jitValueKey(value.base)}:${jitValueKey(value.value)}`;
    case "flagProducer":
      return `flagProducer:${value.producer}:${flagProducerWidth(value)}:${normalizeFlagProducerMask(value.producer, value.mask)}:${jitFlagProducerInputKey(value)}`;
    case "flagCondition":
      return `flagCondition:${value.cc}:${jitValueKey(value.flags)}`;
  }
}

export function jitValueDependencies(value: JitValue): readonly JitValue[] {
  return jitValueChildren(value);
}

export function walkJitValueDependencies(value: JitValue, visit: (dependency: JitValue) => void): void {
  for (const child of jitValueChildren(value)) {
    visit(child);
    walkJitValueDependencies(child, visit);
  }
}

function jitFlagProducerInputKey(value: JitValue & { kind: "flagProducer" }): string {
  return flagProducerInputNames(value.producer)
    .map((key) => `${key}=${jitValueKey(requiredFlagProducerInput(value.producer, value.inputs, key))}`)
    .join(",");
}

function collectMaterializationSlots(value: JitValue, slots: Map<string, JitArchitecturalSlot>): void {
  switch (value.kind) {
    case "reg":
      slots.set(jitArchitecturalSlotKey({ kind: "reg32", reg: value.reg }), { kind: "reg32", reg: value.reg });
      return;
    case "input":
      slots.set(jitArchitecturalSlotKey(value.slot), value.slot);
      return;
    case "produced":
      return;
    default:
      for (const child of jitValueChildren(value)) {
        collectMaterializationSlots(child, slots);
      }
  }
}

function collectMaterializationSlotsForMask(
  value: JitValue,
  requiredMask: number,
  slots: Map<string, JitArchitecturalSlot>
): void {
  if (requiredMask === 0) {
    return;
  }

  const simplified = simplifyJitValue(value);

  switch (simplified.kind) {
    case "const":
    case "produced":
      return;
    case "reg":
      slots.set(jitArchitecturalSlotKey({ kind: "reg32", reg: simplified.reg }), { kind: "reg32", reg: simplified.reg });
      return;
    case "input":
      slots.set(jitArchitecturalSlotKey(simplified.slot), simplified.slot);
      return;
    case "value.unary":
      collectMaterializationSlotsForMask(
        simplified.value,
        unaryInputRequiredMask(simplified.operator, requiredMask),
        slots
      );
      return;
    case "value.binary": {
      const maskedValue = binaryAndMaskedValue(simplified);

      if (maskedValue !== undefined) {
        collectMaterializationSlotsForMask(
          maskedValue.value,
          (requiredMask & maskedValue.mask) >>> 0,
          slots
        );
        return;
      }

      collectMaterializationSlots(simplified, slots);
      return;
    }
    case "extractBits":
      collectMaterializationSlotsForMask(
        simplified.value,
        extractBitsRequiredMask(requiredMask, simplified.bitOffset, simplified.width),
        slots
      );
      return;
    case "extractMaskedBits":
      collectMaterializationSlotsForMask(
        simplified.value,
        (requiredMask & simplified.mask) >>> 0,
        slots
      );
      return;
    case "insertBits": {
      const insertedMask = bitRangeMask(simplified.bitOffset, simplified.width);
      const valueRequiredMask = ((requiredMask & insertedMask) >>> simplified.bitOffset) >>> 0;

      collectMaterializationSlotsForMask(simplified.base, (requiredMask & ~insertedMask) >>> 0, slots);
      collectMaterializationSlotsForMask(simplified.value, valueRequiredMask, slots);
      return;
    }
    case "insertMaskedBits":
      collectMaterializationSlotsForMask(simplified.base, (requiredMask & ~simplified.mask) >>> 0, slots);
      collectMaterializationSlotsForMask(simplified.value, (requiredMask & simplified.mask) >>> 0, slots);
      return;
    default:
      collectMaterializationSlots(simplified, slots);
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
