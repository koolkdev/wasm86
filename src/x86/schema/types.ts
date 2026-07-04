import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth, RegName, SegmentRegister } from "#x86/types.js";

export type Reg3 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type FixedHighBits = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type OpcodePathPart =
  | number
  | Readonly<{
      byte: number;
      bits?: FixedHighBits;
    }>;

export type OpcodePath = readonly OpcodePathPart[];

export type ImmediateExtension = "sign";
export type RegOperandType = "r8" | "r16" | "r32";
export type RmOperandType = "rm8" | "rm16" | "rm32" | "r32_m16";
export type MemOperandType = "m8" | "m16" | "m32";
export type OperandSizePrefixMode = "default" | "override";

export type OperandSpec =
  | Readonly<{ kind: "modrm.reg"; type: RegOperandType }>
  | Readonly<{ kind: "modrm.sreg" }>
  | Readonly<{ kind: "modrm.rm"; type: RmOperandType | MemOperandType }>
  | Readonly<{ kind: "opcode.reg"; type: RegOperandType }>
  | Readonly<{ kind: "implicit.reg"; reg: RegName; type: RegOperandType }>
  | Readonly<{ kind: "implicit.sreg"; reg: SegmentRegister }>
  | Readonly<{ kind: "moffs"; width: OperandWidth }>
  | Readonly<{ kind: "imm"; width: OperandWidth; semanticWidth?: OperandWidth; extension?: ImmediateExtension }>
  | Readonly<{ kind: "rel"; width: 8 | 16 | 32 }>;

export type ModRmMatch = Readonly<{
  mod?: Reg3;
  reg?: Reg3;
  rm?: Reg3;
}>;

export type InstructionFormat = Readonly<{
  syntax: string;
}>;

export type InstructionPrefixes = Readonly<{
  operandSize?: OperandSizePrefixMode;
}>;

export type InstructionSpec = Readonly<{
  id: string;
  mnemonic: string;
  opcode: OpcodePath;
  prefixes?: InstructionPrefixes;
  modrm?: Readonly<{
    match?: ModRmMatch;
  }>;
  operands?: readonly OperandSpec[];
  format: InstructionFormat;
  semantics: SemanticTemplate;
}>;

export type InstructionFormSpec = Omit<InstructionSpec, "id" | "mnemonic">;

export type InstructionForm = Readonly<{
  formId: string;
  spec: InstructionFormSpec;
}>;

export type InstructionMnemonic = Readonly<{
  mnemonic: string;
  forms: readonly InstructionForm[];
}>;

export type IsaDefinition = Readonly<{
  name: string;
  mnemonics: readonly InstructionMnemonic[];
}>;

export type DefinedIsa = Readonly<{
  name: string;
  instructions: readonly InstructionSpec[];
}>;

export type ExpandedInstructionSpec = Readonly<{
  spec: InstructionSpec;
  opcode: readonly number[];
  opcodeLowBits?: number;
}>;
