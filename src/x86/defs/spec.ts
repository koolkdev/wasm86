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
  syntax: string;
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

export type ExpandedOpcode = Readonly<{
  bytes: readonly number[];
  lowBits?: number;
}>;

type ExpandedOpcodePart = Readonly<{
  byte: number;
  lowBits?: number;
}>;

export function instructionReadsModRm(spec: InstructionSpec): boolean {
  return spec.modrm?.match !== undefined || (spec.operands ?? []).some(isModRmOperand);
}

export function expandInstructionSpec(
  spec: InstructionSpec
): readonly ExpandedInstructionSpec[] {
  return expandOpcodePath(spec.opcode).map(({ bytes, lowBits }) => {
    if (lowBits === undefined) {
      return { spec, opcode: bytes };
    }

    return { spec, opcode: bytes, opcodeLowBits: lowBits };
  });
}

export function expandOpcodePath(path: OpcodePath): readonly ExpandedOpcode[] {
  const expanded: ExpandedOpcode[] = [{ bytes: [] }];

  for (const part of path) {
    const values = expandOpcodePart(part);
    const next: ExpandedOpcode[] = [];

    for (const prefix of expanded) {
      for (const value of values) {
        const bytes = [...prefix.bytes, value.byte];
        const lowBits = prefix.lowBits ?? value.lowBits;

        next.push(lowBits === undefined ? { bytes } : { bytes, lowBits });
      }
    }

    expanded.splice(0, expanded.length, ...next);
  }

  return expanded;
}

function isModRmOperand(operand: OperandSpec): boolean {
  return operand.kind === "modrm.reg" || operand.kind === "modrm.sreg" || operand.kind === "modrm.rm";
}

function expandOpcodePart(part: OpcodePathPart): readonly ExpandedOpcodePart[] {
  if (typeof part === "number") {
    return [{ byte: part }];
  }

  const bits = part.bits ?? 8;
  const count = 1 << (8 - bits);
  const values: ExpandedOpcodePart[] = [];

  for (let low = 0; low < count; low += 1) {
    const byte = part.byte | low;
    values.push(bits < 8 ? { byte, lowBits: low } : { byte });
  }

  return values;
}
