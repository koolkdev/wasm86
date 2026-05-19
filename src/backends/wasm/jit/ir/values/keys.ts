import {
  flagProducerInputNames,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import { i32 } from "#x86/state/cpu-state.js";
import { simplifyValue } from "./simplify.js";
import {
  flagProducerWidth,
  normalizeFlagProducerMask
} from "./flags.js";
import { normalizeU32Mask } from "./bits.js";
import { jitArchitecturalSlotKey } from "./slots.js";
import type { JitValue } from "./types.js";

export function valueKey(value: JitValue): string {
  const simplified = simplifyValue(value);

  if (simplified !== value) {
    return valueKey(simplified);
  }

  switch (value.kind) {
    case "const":
      return `const:${value.type}:${i32(value.value)}`;
    case "loadResult":
      return `loadResult:${value.type}:${value.id}`;
    case "input":
      return `input:${jitArchitecturalSlotKey(value.slot)}`;
    case "value.binary":
      return `binary:${value.type}:${value.operator}:${valueKey(value.a)}:${valueKey(value.b)}`;
    case "value.unary":
      return `unary:${value.type}:${value.operator}:${valueKey(value.value)}`;
    case "value.select":
      return `select:${value.type}:${valueKey(value.condition)}:${valueKey(value.whenTrue)}:${valueKey(value.whenFalse)}`;
    case "extractBits":
      return `extractBits:${value.bitOffset}:${value.width}:${valueKey(value.value)}`;
    case "insertBits":
      return `insertBits:${value.bitOffset}:${value.width}:${valueKey(value.base)}:${valueKey(value.value)}`;
    case "extractMaskedBits":
      return `extractMaskedBits:${normalizeU32Mask(value.mask, "extractMaskedBits mask")}:${valueKey(value.value)}`;
    case "insertMaskedBits":
      return `insertMaskedBits:${normalizeU32Mask(value.mask, "insertMaskedBits mask")}:${valueKey(value.base)}:${valueKey(value.value)}`;
    case "flagProducer":
      return `flagProducer:${value.producer}:${flagProducerWidth(value)}:${normalizeFlagProducerMask(value.producer, value.mask)}:${jitFlagProducerInputKey(value)}`;
    case "flagCondition":
      return `flagCondition:${value.cc}:${valueKey(value.flags)}`;
  }
}

function jitFlagProducerInputKey(value: JitValue & { kind: "flagProducer" }): string {
  return flagProducerInputNames(value.producer)
    .map((key) => `${key}=${valueKey(requiredFlagProducerInput(value.producer, value.inputs, key))}`)
    .join(",");
}
