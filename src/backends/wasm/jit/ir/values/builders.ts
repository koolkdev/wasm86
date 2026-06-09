import type { OperandWidth, Reg16, Reg32, Reg8 } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import type {
  ConditionCode,
  FlagProducerName,
  IrCompareOperator,
  IrValueType
} from "#ir/model/types.js";
import {
  FLAG_PRODUCERS,
  flagProducerInputsFromRecord,
  flagProducerInputsToRecord,
  type FlagProducerInputs
} from "#ir/model/flags.js";
import {
  assertBitRange,
  normalizeU32Mask
} from "./bits.js";
import {
  flagWriteCellMask,
  normalizeFlagProducerMask,
  normalizeOptionalWidth
} from "./flags.js";
import type {
  JitFlagWriteValue,
  JitInputValue,
  JitLoadResultValue,
  JitLoadResultValueId,
  JitRegisterSlot,
  JitValue
} from "./types.js";

export function jitInputReg32Value(reg: Reg32): JitInputValue {
  return { kind: "input", slot: { kind: "reg32", reg } };
}

export function jitInputReg16Value(reg: Reg16): JitValue {
  const alias = registerAlias(reg);

  return jitExtractBits(jitInputReg32Value(alias.base), alias.bitOffset, alias.width);
}

export function jitInputReg8Value(reg: Reg8): JitValue {
  const alias = registerAlias(reg);

  return jitExtractBits(jitInputReg32Value(alias.base), alias.bitOffset, alias.width);
}

export function jitInputRegisterValue(slot: JitRegisterSlot): JitValue {
  switch (slot.kind) {
    case "reg32":
      return jitInputReg32Value(slot.reg);
    case "reg16":
      return jitInputReg16Value(slot.reg);
    case "reg8":
      return jitInputReg8Value(slot.reg);
  }
}

export function jitInputAluFlagsValue(): JitInputValue {
  return { kind: "input", slot: { kind: "aluFlags" } };
}

export function jitLoadResultValue(id: number, type: IrValueType): JitLoadResultValue {
  return { kind: "loadResult", id: id as JitLoadResultValueId, type };
}

export function jitFlagProducerValue<Producer extends FlagProducerName>(
  producer: Producer,
  inputs: FlagProducerInputs<JitValue, Producer>,
  options: Readonly<{ width?: OperandWidth; mask?: number }> = {}
): JitValue {
  const normalizedWidth = normalizeOptionalWidth(options.width);
  const mask = normalizeFlagProducerMask(producer, options.mask ?? FLAG_PRODUCERS[producer].writtenMask);
  const typedInputs = flagProducerInputsFromRecord(
    producer,
    flagProducerInputsToRecord(producer, inputs)
  );

  return {
    kind: "flagProducer",
    producer,
    ...(normalizedWidth === undefined ? {} : { width: normalizedWidth }),
    inputs: typedInputs,
    mask
  };
}

export function jitCompareValue(
  operator: IrCompareOperator,
  width: OperandWidth,
  a: JitValue,
  b: JitValue
): JitValue {
  return { kind: "value.compare", type: "i32", operator, width, a, b };
}

export function jitFlagWriteValue(
  cells: JitFlagWriteValue["cells"],
  conditions?: JitFlagWriteValue["conditions"]
): JitValue {
  return {
    kind: "flagWrite",
    cells,
    ...(conditions === undefined ? {} : { conditions }),
    mask: flagWriteCellMask(cells)
  };
}

export function jitExtractBits(value: JitValue, bitOffset: number, width: OperandWidth): JitValue {
  assertBitRange(bitOffset, width, "extractBits");

  return { kind: "extractBits", value, bitOffset, width };
}

export function jitInsertBits(
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): JitValue {
  assertBitRange(bitOffset, width, "insertBits");

  return { kind: "insertBits", base, value, bitOffset, width };
}

export function jitExtractMaskedBits(value: JitValue, mask: number): JitValue {
  return { kind: "extractMaskedBits", value, mask: normalizeU32Mask(mask, "extractMaskedBits mask") };
}

export function jitInsertMaskedBits(base: JitValue, value: JitValue, mask: number): JitValue {
  return { kind: "insertMaskedBits", base, value, mask: normalizeU32Mask(mask, "insertMaskedBits mask") };
}

export function jitFlagConditionValue(flags: JitValue, cc: ConditionCode): JitValue {
  return { kind: "flagCondition", flags, cc };
}
