import {
  flagProducerInputNames,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import {
  flagProducerWidth,
  jitArchitecturalSlotsEqual,
  normalizeFlagProducerMask,
  normalizeU32Mask
} from "#backends/wasm/jit/ir/value-shared.js";
import type {
  JitBinaryValue,
  JitConstValue,
  JitExtractBitsValue,
  JitExtractMaskedBitsValue,
  JitFlagConditionValue,
  JitFlagProducerValue,
  JitInputValue,
  JitInsertBitsValue,
  JitInsertMaskedBitsValue,
  JitProducedValue,
  JitRegValue,
  JitSelectValue,
  JitUnaryValue,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";

export function jitValuesEqual(a: JitValue, b: JitValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "value.binary": {
      const binary = b as JitBinaryValue;

      return a.type === binary.type &&
        a.operator === binary.operator &&
        jitValuesEqual(a.a, binary.a) &&
        jitValuesEqual(a.b, binary.b);
    }
    case "value.unary": {
      const unary = b as JitUnaryValue;

      return a.type === unary.type &&
        a.operator === unary.operator &&
        jitValuesEqual(a.value, unary.value);
    }
    case "value.select": {
      const select = b as JitSelectValue;

      return a.type === select.type &&
        jitValuesEqual(a.condition, select.condition) &&
        jitValuesEqual(a.whenTrue, select.whenTrue) &&
        jitValuesEqual(a.whenFalse, select.whenFalse);
    }
    case "const": {
      const constant = b as JitConstValue;

      return a.type === constant.type && a.value === constant.value;
    }
    case "produced": {
      const produced = b as JitProducedValue;

      return a.id === produced.id && a.type === produced.type;
    }
    case "reg":
      return a.reg === (b as JitRegValue).reg;
    case "input":
      return jitArchitecturalSlotsEqual(a.slot, (b as JitInputValue).slot);
    case "extractBits": {
      const extract = b as JitExtractBitsValue;

      return a.bitOffset === extract.bitOffset &&
        a.width === extract.width &&
        jitValuesEqual(a.value, extract.value);
    }
    case "insertBits": {
      const insert = b as JitInsertBitsValue;

      return a.bitOffset === insert.bitOffset &&
        a.width === insert.width &&
        jitValuesEqual(a.base, insert.base) &&
        jitValuesEqual(a.value, insert.value);
    }
    case "extractMaskedBits": {
      const extract = b as JitExtractMaskedBitsValue;

      return normalizeU32Mask(a.mask, "extractMaskedBits mask") ===
        normalizeU32Mask(extract.mask, "extractMaskedBits mask") &&
        jitValuesEqual(a.value, extract.value);
    }
    case "insertMaskedBits": {
      const insert = b as JitInsertMaskedBitsValue;

      return normalizeU32Mask(a.mask, "insertMaskedBits mask") ===
        normalizeU32Mask(insert.mask, "insertMaskedBits mask") &&
        jitValuesEqual(a.base, insert.base) &&
        jitValuesEqual(a.value, insert.value);
    }
    case "flagProducer": {
      const producer = b as JitFlagProducerValue;

      return a.producer === producer.producer &&
        flagProducerWidth(a) === flagProducerWidth(producer) &&
        normalizeFlagProducerMask(a.producer, a.mask) === normalizeFlagProducerMask(producer.producer, producer.mask) &&
        jitFlagProducerInputsEqual(a, producer);
    }
    case "flagCondition": {
      const condition = b as JitFlagConditionValue;

      return a.cc === condition.cc && jitValuesEqual(a.flags, condition.flags);
    }
  }
}

function jitFlagProducerInputsEqual(left: JitFlagProducerValue, right: JitFlagProducerValue): boolean {
  if (left.producer !== right.producer) {
    return false;
  }

  return flagProducerInputNames(left.producer).every((key) =>
    jitValuesEqual(
      requiredFlagProducerInput(left.producer, left.inputs, key),
      requiredFlagProducerInput(right.producer, right.inputs, key)
    )
  );
}
