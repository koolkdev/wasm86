import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import type { IrUnaryOperator } from "#x86/ir/model/types.js";
import {
  flagProducerInputNames,
  flagProducerInputsFromRecord,
  requiredFlagProducerInput,
  type FlagProducerInputs
} from "#x86/ir/model/flags.js";
import { i32 } from "#x86/state/cpu-state.js";
import { valuesEqual } from "./equality.js";
import {
  assertBitRange,
  bitRangeMask,
  bitRangeRelationship,
  normalizeU32Mask
} from "./bits.js";
import {
  normalizeFlagProducerMask,
  normalizeOptionalWidth
} from "./flags.js";
import type {
  JitBinaryValue,
  JitExtractBitsValue,
  JitExtractMaskedBitsValue,
  JitFlagProducerValue,
  JitInsertBitsValue,
  JitInsertMaskedBitsValue,
  JitSelectValue,
  JitUnaryValue,
  JitValue
} from "./types.js";

export function simplifyValue(value: JitValue): JitValue {
  switch (value.kind) {
    case "const": {
      const normalized = i32(value.value);

      return normalized === value.value ? value : { ...value, value: normalized };
    }
    case "loadResult":
    case "input":
      return value;
    case "value.binary":
      return simplifyJitBinaryValue(value);
    case "value.unary":
      return simplifyJitUnaryValue(value);
    case "value.select":
      return simplifyJitSelectValue(value);
    case "extractBits":
      return simplifyJitExtractBitsValue(value);
    case "insertBits":
      return simplifyJitInsertBitsValue(value);
    case "extractMaskedBits":
      return simplifyJitExtractMaskedBitsValue(value);
    case "insertMaskedBits":
      return simplifyJitInsertMaskedBitsValue(value);
    case "flagProducer":
      return simplifyJitFlagProducerValue(value);
    case "flagCondition": {
      const flags = simplifyValue(value.flags);

      return flags === value.flags ? value : { ...value, flags };
    }
  }
}

function signExtendConst(value: number, width: 8 | 16): number {
  const masked = value & widthMask(width);
  const shift = 32 - width;

  return i32((masked << shift) >> shift);
}

function simplifyJitBinaryValue(value: JitBinaryValue): JitValue {
  const a = simplifyValue(value.a);
  const b = simplifyValue(value.b);

  if (b.kind === "const") {
    switch (value.operator) {
      case "add":
      case "or":
      case "xor":
      case "shl":
      case "shr_u":
        if (b.value === 0) {
          return a;
        }
        break;
      case "sub":
        if (b.value === 0) {
          return a;
        }
        break;
      case "and":
        if ((b.value >>> 0) === 0xffff_ffff) {
          return a;
        }
        if (b.value === 0) {
          return { kind: "const", type: value.type, value: 0 };
        }
        {
          const masked = simplifyJitMaskedValue(a, b.value);

          if (masked !== undefined) {
            return masked;
          }
        }
        break;
    }
  }

  if (a.kind === "const") {
    switch (value.operator) {
      case "add":
      case "or":
      case "xor":
        if (a.value === 0) {
          return b;
        }
        break;
      case "and":
        if ((a.value >>> 0) === 0xffff_ffff) {
          return b;
        }
        if (a.value === 0) {
          return { kind: "const", type: value.type, value: 0 };
        }
        {
          const masked = simplifyJitMaskedValue(b, a.value);

          if (masked !== undefined) {
            return masked;
          }
        }
        break;
      case "sub":
      case "shr_u":
        break;
      case "shl":
        if (a.value === 0) {
          return { kind: "const", type: value.type, value: 0 };
        }
        if (b.kind === "const") {
          return { kind: "const", type: value.type, value: i32(a.value << (b.value & 31)) };
        }
        break;
    }
  }

  return a === value.a && b === value.b ? value : { ...value, a, b };
}

function simplifyJitMaskedValue(value: JitValue, maskValue: number): JitValue | undefined {
  const mask = maskValue >>> 0;

  if (value.kind === "insertBits" && value.bitOffset === 0) {
    const insertedMask = bitRangeMask(value.bitOffset, value.width);

    if ((mask & ~insertedMask) === 0) {
      return simplifyValue({
        kind: "value.binary",
        type: "i32",
        operator: "and",
        a: value.value,
        b: { kind: "const", type: "i32", value: i32(mask) }
      });
    }

    if ((mask & insertedMask) === 0) {
      return simplifyValue({
        kind: "value.binary",
        type: "i32",
        operator: "and",
        a: value.base,
        b: { kind: "const", type: "i32", value: i32(mask) }
      });
    }
  }

  if (value.kind === "insertMaskedBits") {
    const insertedMask = normalizeU32Mask(value.mask, "insertMaskedBits mask");

    if ((mask & ~insertedMask) === 0) {
      return simplifyValue({
        kind: "value.binary",
        type: "i32",
        operator: "and",
        a: value.value,
        b: { kind: "const", type: "i32", value: i32(mask) }
      });
    }

    if ((mask & insertedMask) === 0) {
      return simplifyValue({
        kind: "value.binary",
        type: "i32",
        operator: "and",
        a: value.base,
        b: { kind: "const", type: "i32", value: i32(mask) }
      });
    }
  }

  return undefined;
}

function simplifyJitUnaryValue(value: JitUnaryValue): JitValue {
  const inner = simplifyValue(value.value);

  if (inner.kind === "const") {
    return { kind: "const", type: value.type, value: foldUnaryConst(value.operator, inner.value) };
  }

  return inner === value.value ? value : { ...value, value: inner };
}

function simplifyJitSelectValue(value: JitSelectValue): JitValue {
  const condition = simplifyValue(value.condition);
  const whenTrue = simplifyValue(value.whenTrue);
  const whenFalse = simplifyValue(value.whenFalse);

  if (condition.kind === "const") {
    return condition.value !== 0 ? whenTrue : whenFalse;
  }

  if (valuesEqual(whenTrue, whenFalse)) {
    return whenTrue;
  }

  return condition === value.condition && whenTrue === value.whenTrue && whenFalse === value.whenFalse
    ? value
    : { ...value, condition, whenTrue, whenFalse };
}

function simplifyJitExtractBitsValue(value: JitExtractBitsValue): JitValue {
  assertBitRange(value.bitOffset, value.width, "extractBits");
  const source = simplifyValue(value.value);

  if (value.bitOffset === 0 && value.width === 32) {
    return source;
  }

  if (source.kind === "const") {
    return { kind: "const", type: source.type, value: extractConstBits(source.value, value.bitOffset, value.width) };
  }

  if (source.kind === "extractBits" && value.bitOffset + value.width <= source.width) {
    return simplifyValue({
      kind: "extractBits",
      value: source.value,
      bitOffset: source.bitOffset + value.bitOffset,
      width: value.width
    });
  }

  if (source.kind === "insertBits") {
    const relationship = bitRangeRelationship(
      value.bitOffset,
      value.width,
      source.bitOffset,
      source.width
    );

    if (relationship === "same") {
      return simplifyValue({ kind: "extractBits", value: source.value, bitOffset: 0, width: value.width });
    }

    if (relationship === "disjoint") {
      return simplifyValue({ ...value, value: source.base });
    }
  }

  return source === value.value ? value : { ...value, value: source };
}

function simplifyJitInsertBitsValue(value: JitInsertBitsValue): JitValue {
  assertBitRange(value.bitOffset, value.width, "insertBits");
  const base = simplifyValue(value.base);
  const inserted = simplifyValue(value.value);

  if (value.bitOffset === 0 && value.width === 32) {
    return inserted;
  }

  if (base.kind === "const" && inserted.kind === "const") {
    return {
      kind: "const",
      type: base.type,
      value: insertConstBits(base.value, inserted.value, value.bitOffset, value.width)
    };
  }

  if (inserted.kind === "extractBits" &&
    inserted.bitOffset === value.bitOffset &&
    inserted.width === value.width &&
    valuesEqual(inserted.value, base)) {
    return base;
  }

  if (base.kind === "insertBits" && base.bitOffset === value.bitOffset && base.width === value.width) {
    return simplifyValue({ ...value, base: base.base, value: inserted });
  }

  return base === value.base && inserted === value.value ? value : { ...value, base, value: inserted };
}

function simplifyJitExtractMaskedBitsValue(value: JitExtractMaskedBitsValue): JitValue {
  const mask = normalizeU32Mask(value.mask, "extractMaskedBits mask");
  const source = simplifyValue(value.value);

  if (mask === 0) {
    return { kind: "const", type: "i32", value: 0 };
  }

  if (mask === 0xffff_ffff) {
    return source;
  }

  if (source.kind === "const") {
    return { kind: "const", type: source.type, value: i32((source.value >>> 0) & mask) };
  }

  if (source.kind === "extractMaskedBits") {
    return simplifyValue({ ...value, value: source.value, mask: mask & normalizeU32Mask(source.mask, "extractMaskedBits mask") });
  }

  if (source.kind === "insertMaskedBits") {
    const insertedMask = normalizeU32Mask(source.mask, "insertMaskedBits mask");

    if ((mask & ~insertedMask) === 0) {
      return simplifyValue({ ...value, value: source.value, mask });
    }

    if ((mask & insertedMask) === 0) {
      return simplifyValue({ ...value, value: source.base, mask });
    }
  }

  return source === value.value && mask === value.mask ? value : { ...value, value: source, mask };
}

function simplifyJitInsertMaskedBitsValue(value: JitInsertMaskedBitsValue): JitValue {
  const mask = normalizeU32Mask(value.mask, "insertMaskedBits mask");
  const base = simplifyValue(value.base);
  const inserted = simplifyValue(value.value);

  if (mask === 0) {
    return base;
  }

  if (mask === 0xffff_ffff) {
    return inserted;
  }

  if (base.kind === "const" && inserted.kind === "const") {
    return {
      kind: "const",
      type: base.type,
      value: i32(((base.value >>> 0) & (~mask >>> 0)) | ((inserted.value >>> 0) & mask))
    };
  }

  if (inserted.kind === "extractMaskedBits" &&
    normalizeU32Mask(inserted.mask, "extractMaskedBits mask") === mask &&
    valuesEqual(inserted.value, base)) {
    return base;
  }

  if (base.kind === "insertMaskedBits" && normalizeU32Mask(base.mask, "insertMaskedBits mask") === mask) {
    return simplifyValue({ ...value, base: base.base, value: inserted, mask });
  }

  return base === value.base && inserted === value.value && mask === value.mask
    ? value
    : { ...value, base, value: inserted, mask };
}

function simplifyJitFlagProducerValue(value: JitFlagProducerValue): JitValue {
  const width = normalizeOptionalWidth(value.width);
  const mask = normalizeFlagProducerMask(value.producer, value.mask);

  if (mask === 0) {
    return { kind: "const", type: "i32", value: 0 };
  }

  const inputs = simplifyJitFlagProducerInputs(value);

  return inputs === value.inputs && mask === value.mask && width === value.width
    ? value
    : {
        kind: "flagProducer",
        producer: value.producer,
        ...(width === undefined ? {} : { width }),
        inputs,
        mask
      } as JitFlagProducerValue;
}

function foldUnaryConst(operator: IrUnaryOperator, value: number): number {
  switch (operator) {
    case "extend8_s":
      return signExtendConst(value, 8);
    case "extend16_s":
      return signExtendConst(value, 16);
    case "popcnt":
      return popcnt32(value);
  }
}

function popcnt32(value: number): number {
  let remaining = value >>> 0;
  let count = 0;

  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }

  return count;
}

function extractConstBits(value: number, bitOffset: number, width: OperandWidth): number {
  return i32(((value >>> 0) >>> bitOffset) & (widthMask(width) >>> 0));
}

function insertConstBits(base: number, value: number, bitOffset: number, width: OperandWidth): number {
  const mask = bitRangeMask(bitOffset, width);
  const replacement = (((value >>> 0) & (widthMask(width) >>> 0)) << bitOffset) >>> 0;

  return i32(((base >>> 0) & (~mask >>> 0)) | replacement);
}

function simplifyJitFlagProducerInputs(value: JitFlagProducerValue): FlagProducerInputs<JitValue> {
  let changed = false;
  const simplified: Record<string, JitValue> = {};

  for (const key of flagProducerInputNames(value.producer)) {
    const input = requiredFlagProducerInput(value.producer, value.inputs, key);
    const simplifiedValue = simplifyValue(input);

    simplified[key] = simplifiedValue;
    changed ||= simplifiedValue !== input;
  }

  return changed
    ? flagProducerInputsFromRecord(value.producer, simplified)
    : value.inputs;
}
