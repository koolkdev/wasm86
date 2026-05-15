import {
  flagProducerInputNames,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import {
  flagProducerWidth,
  normalizeFlagProducerMask
} from "./flags.js";
import {
  jitArchitecturalSlotsEqual
} from "./slots.js";
import {
  normalizeU32Mask
} from "./bits.js";
import { simplifyValue } from "./simplify.js";
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
  JitSelectValue,
  JitUnaryValue,
  JitValue
} from "./types.js";

export function valuesEqual(a: JitValue, b: JitValue): boolean {
  return valuesEqualStructural(simplifyValue(a), simplifyValue(b));
}

function valuesEqualStructural(a: JitValue, b: JitValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "value.binary": {
      const binary = b as JitBinaryValue;

      return a.type === binary.type &&
        a.operator === binary.operator &&
        valuesEqual(a.a, binary.a) &&
        valuesEqual(a.b, binary.b);
    }
    case "value.unary": {
      const unary = b as JitUnaryValue;

      return a.type === unary.type &&
        a.operator === unary.operator &&
        valuesEqual(a.value, unary.value);
    }
    case "value.select": {
      const select = b as JitSelectValue;

      return a.type === select.type &&
        valuesEqual(a.condition, select.condition) &&
        valuesEqual(a.whenTrue, select.whenTrue) &&
        valuesEqual(a.whenFalse, select.whenFalse);
    }
    case "const": {
      const constant = b as JitConstValue;

      return a.type === constant.type && a.value === constant.value;
    }
    case "produced": {
      const produced = b as JitProducedValue;

      return a.id === produced.id && a.type === produced.type;
    }
    case "input":
      return jitArchitecturalSlotsEqual(a.slot, (b as JitInputValue).slot);
    case "extractBits": {
      const extract = b as JitExtractBitsValue;

      return a.bitOffset === extract.bitOffset &&
        a.width === extract.width &&
        valuesEqual(a.value, extract.value);
    }
    case "insertBits": {
      const insert = b as JitInsertBitsValue;

      return a.bitOffset === insert.bitOffset &&
        a.width === insert.width &&
        valuesEqual(a.base, insert.base) &&
        valuesEqual(a.value, insert.value);
    }
    case "extractMaskedBits": {
      const extract = b as JitExtractMaskedBitsValue;

      return normalizeU32Mask(a.mask, "extractMaskedBits mask") ===
        normalizeU32Mask(extract.mask, "extractMaskedBits mask") &&
        valuesEqual(a.value, extract.value);
    }
    case "insertMaskedBits": {
      const insert = b as JitInsertMaskedBitsValue;

      return normalizeU32Mask(a.mask, "insertMaskedBits mask") ===
        normalizeU32Mask(insert.mask, "insertMaskedBits mask") &&
        valuesEqual(a.base, insert.base) &&
        valuesEqual(a.value, insert.value);
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

      return a.cc === condition.cc && valuesEqual(a.flags, condition.flags);
    }
  }
}

function jitFlagProducerInputsEqual(left: JitFlagProducerValue, right: JitFlagProducerValue): boolean {
  if (left.producer !== right.producer) {
    return false;
  }

  return flagProducerInputNames(left.producer).every((key) =>
    valuesEqual(
      requiredFlagProducerInput(left.producer, left.inputs, key),
      requiredFlagProducerInput(right.producer, right.inputs, key)
    )
  );
}
