import type { OperandWidth, Reg16, Reg32, Reg8 } from "#x86/isa/types.js";
import type {
  ConditionCode,
  FlagProducerName,
  IrBinaryOperator,
  IrUnaryOperator,
  IrValueType
} from "#x86/ir/model/types.js";
import type { FlagProducerInputs } from "#x86/ir/model/flags.js";

export type JitConstValue = Readonly<{ kind: "const"; type: IrValueType; value: number }>;
export type JitLoadResultValueId = number & { readonly __jitLoadResultValueId: unique symbol };
export type JitLoadResultValue = Readonly<{ kind: "loadResult"; id: JitLoadResultValueId; type: IrValueType }>;

export type JitBinaryValue = Readonly<{
  kind: "value.binary";
  type: IrValueType;
  operator: IrBinaryOperator;
  a: JitValue;
  b: JitValue;
}>;

export type JitUnaryValue = Readonly<{
  kind: "value.unary";
  type: IrValueType;
  operator: IrUnaryOperator;
  value: JitValue;
}>;

export type JitSelectValue = Readonly<{
  kind: "value.select";
  type: IrValueType;
  condition: JitValue;
  whenTrue: JitValue;
  whenFalse: JitValue;
}>;

export type JitRegisterSlot =
  | Readonly<{ kind: "reg32"; reg: Reg32 }>
  | Readonly<{ kind: "reg16"; reg: Reg16 }>
  | Readonly<{ kind: "reg8"; reg: Reg8 }>;

export type JitFlagSlot = Readonly<{ kind: "aluFlags" }>;

export type JitArchitecturalSlot = JitRegisterSlot | JitFlagSlot;

export type JitCanonicalInputSlot =
  | Readonly<{ kind: "reg32"; reg: Reg32 }>
  | JitFlagSlot;

export type JitInputValue = Readonly<{
  kind: "input";
  slot: JitCanonicalInputSlot;
}>;

export type JitExtractBitsValue = Readonly<{
  kind: "extractBits";
  value: JitValue;
  bitOffset: number;
  width: OperandWidth;
}>;

export type JitInsertBitsValue = Readonly<{
  kind: "insertBits";
  base: JitValue;
  value: JitValue;
  bitOffset: number;
  width: OperandWidth;
}>;

export type JitExtractMaskedBitsValue = Readonly<{
  kind: "extractMaskedBits";
  value: JitValue;
  mask: number;
}>;

export type JitInsertMaskedBitsValue = Readonly<{
  kind: "insertMaskedBits";
  base: JitValue;
  value: JitValue;
  mask: number;
}>;

export type JitFlagProducerValueFor<Producer extends FlagProducerName> = Readonly<{
  kind: "flagProducer";
  producer: Producer;
  width?: OperandWidth;
  inputs: FlagProducerInputs<JitValue, Producer>;
  mask: number;
}>;

export type JitFlagProducerValue = JitFlagProducerValueFor<FlagProducerName>;

export type JitFlagConditionValue = Readonly<{
  kind: "flagCondition";
  flags: JitValue;
  cc: ConditionCode;
}>;

export type JitValue =
  | JitConstValue
  | JitLoadResultValue
  | JitUnaryValue
  | JitBinaryValue
  | JitSelectValue
  | JitInputValue
  | JitExtractBitsValue
  | JitInsertBitsValue
  | JitExtractMaskedBitsValue
  | JitInsertMaskedBitsValue
  | JitFlagProducerValue
  | JitFlagConditionValue;

export type JitRegisterValueMap = ReadonlyMap<Reg32, JitValue>;
