import type { MemOperand, OperandWidth, RegisterAlias } from "#x86/types.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { InstructionSpec, ImmediateExtension } from "#x86/schema/types.js";

export type IsaOperandBinding =
  | Readonly<{ kind: "reg"; alias: RegisterAlias }>
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
  spec: InstructionSpec<SemanticTemplate>;
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
