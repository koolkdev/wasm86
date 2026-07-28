import type { MemOperand, OperandWidth, RegisterAlias, SegmentRegister } from "#core/types.js";
import type { InstructionSpec, ImmediateExtension } from "#instructions/isa/spec.js";
import type { CpuException } from "#core/exceptions.js";

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

export type IsaDecodeReadResult =
  | Readonly<{ kind: "value"; value: number }>
  | Readonly<{
      kind: "exception";
      exception: CpuException<number>;
    }>;

export type IsaDecodeReader = Readonly<{
  readU8(eip: number): IsaDecodeReadResult;
}>;

export type IsaDecodeExceptionResult = Readonly<{
  kind: "cpuException";
  exception: CpuException<number>;
  instructionStart: number;
  raw: readonly number[];
}>;

export type IsaDecodeResult =
  Readonly<{ kind: "instruction"; instruction: IsaDecodedInstruction }> | IsaDecodeExceptionResult;
