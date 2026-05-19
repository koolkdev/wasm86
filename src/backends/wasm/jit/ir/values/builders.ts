import type { OperandWidth, Reg16, Reg32, Reg8 } from "#x86/isa/types.js";
import { registerAlias } from "#x86/isa/registers.js";
import type {
  ConditionCode,
  FlagProducerName,
  IrValueType
} from "#x86/ir/model/types.js";
import {
  FLAG_PRODUCERS,
  flagProducerInputsFromRecord,
  flagProducerInputsToRecord,
  type FlagProducerInputs
} from "#x86/ir/model/flags.js";
import { simplifyValue } from "./simplify.js";
import {
  normalizeFlagProducerMask,
  normalizeOptionalWidth
} from "./flags.js";
import type {
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

  return simplifyValue({
    kind: "flagProducer",
    producer,
    ...(normalizedWidth === undefined ? {} : { width: normalizedWidth }),
    inputs: typedInputs,
    mask
  });
}

export function jitExtractBits(value: JitValue, bitOffset: number, width: OperandWidth): JitValue {
  return simplifyValue({ kind: "extractBits", value, bitOffset, width });
}

export function jitInsertBits(
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): JitValue {
  return simplifyValue({ kind: "insertBits", base, value, bitOffset, width });
}

export function jitExtractMaskedBits(value: JitValue, mask: number): JitValue {
  return simplifyValue({ kind: "extractMaskedBits", value, mask });
}

export function jitInsertMaskedBits(base: JitValue, value: JitValue, mask: number): JitValue {
  return simplifyValue({ kind: "insertMaskedBits", base, value, mask });
}

export function jitFlagConditionValue(flags: JitValue, cc: ConditionCode): JitValue {
  return simplifyValue({ kind: "flagCondition", flags, cc });
}
