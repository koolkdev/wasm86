import type { OperandWidth, RegisterAlias, Reg32 } from "#x86/isa/types.js";
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
import type { StorageRef } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { simplifyJitValue } from "#backends/wasm/jit/ir/value-simplify.js";
import {
  normalizeFlagProducerMask,
  normalizeOptionalWidth
} from "#backends/wasm/jit/ir/value-shared.js";
import type {
  JitInputValue,
  JitProducedValue,
  JitProducedValueId,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";

export type JitRegisterAccess = Readonly<{
  reg: Reg32;
  width: OperandWidth;
  bitOffset: RegisterAlias["bitOffset"];
}>;

const fullWidth = 32;

export function jitInputReg32Value(reg: Reg32): JitInputValue {
  return { kind: "input", slot: { kind: "reg32", reg } };
}

export function jitInputAluFlagsValue(): JitInputValue {
  return { kind: "input", slot: { kind: "aluFlags" } };
}

export function jitProducedValue(id: JitProducedValueId, type: IrValueType): JitProducedValue {
  return { kind: "produced", id, type };
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

  return simplifyJitValue({
    kind: "flagProducer",
    producer,
    ...(normalizedWidth === undefined ? {} : { width: normalizedWidth }),
    inputs: typedInputs,
    mask
  });
}

export function jitExtractBits(value: JitValue, bitOffset: number, width: OperandWidth): JitValue {
  return simplifyJitValue({ kind: "extractBits", value, bitOffset, width });
}

export function jitInsertBits(
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): JitValue {
  return simplifyJitValue({ kind: "insertBits", base, value, bitOffset, width });
}

export function jitExtractMaskedBits(value: JitValue, mask: number): JitValue {
  return simplifyJitValue({ kind: "extractMaskedBits", value, mask });
}

export function jitInsertMaskedBits(base: JitValue, value: JitValue, mask: number): JitValue {
  return simplifyJitValue({ kind: "insertMaskedBits", base, value, mask });
}

export function jitFlagConditionValue(flags: JitValue, cc: ConditionCode): JitValue {
  return simplifyJitValue({ kind: "flagCondition", flags, cc });
}

export function jitStorageRegisterAccess(
  storage: StorageRef,
  operands: readonly JitOperandBinding[],
  accessWidth: OperandWidth = fullWidth
): JitRegisterAccess | undefined {
  switch (storage.kind) {
    case "reg":
      return { reg: storage.reg, width: accessWidth, bitOffset: 0 };
    case "operand": {
      const binding = operands[storage.index]!;

      return binding.kind === "static.reg"
        ? {
            reg: binding.alias.base,
            width: binding.alias.width,
            bitOffset: binding.alias.bitOffset
          }
        : undefined;
    }
    case "mem":
      return undefined;
  }
}

export function jitStorageReg(storage: StorageRef, operands: readonly JitOperandBinding[]): Reg32 | undefined {
  return jitStorageRegisterAccess(storage, operands)?.reg;
}
