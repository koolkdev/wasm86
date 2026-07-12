import type { MemOperand, OperandWidth, RegisterAlias, SegmentRegister } from "#core/types.js";
import type { InstructionSpec, ImmediateExtension } from "#core/instructions/spec.js";

export type IsaOperandBinding =
  | Readonly<{ kind: "reg"; alias: RegisterAlias }>
  | Readonly<{ kind: "segment"; reg: SegmentRegister }>
  | MemOperand
  | Readonly<{
      kind: "imm";
      value: number;
      encodedWidth: OperandWidth;
      semanticWidth: OperandWidth;
      extension?: ImmediateExtension;
    }>
  | Readonly<{
      kind: "relTarget";
      width: 8 | 16 | 32;
      displacement: number;
      target: number;
    }>;

export type IsaDecodedInstruction = Readonly<{
  spec: InstructionSpec;
  address: number;
  length: number;
  nextEip: number;
  operands: readonly IsaOperandBinding[];
  raw: readonly number[];
}>;

export type IsaDecodeResult =
  | Readonly<{ kind: "ok"; instruction: IsaDecodedInstruction }>
  | Readonly<{
      kind: "unsupported";
      address: number;
      length: number;
      raw: readonly number[];
      unsupportedByte?: number;
    }>;
