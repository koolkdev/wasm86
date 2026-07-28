import type { InstructionSpec } from "#instructions/isa/spec.js";
import type { RepeatPrefix } from "#instructions/isa/prefixes.js";
import type {
  EffectiveAddress,
  MemoryOperandWidth,
  OperandWidth,
  Reg32,
  RegisterAlias,
  SegmentRegister
} from "#core/types.js";

export type PrefixEffect =
  | Readonly<{ kind: "operandSize"; value: "override" }>
  | Readonly<{ kind: "repeat"; value: RepeatPrefix }>
  | Readonly<{ kind: "segment"; value: SegmentRegister }>;

export type PrefixFlagBits = Readonly<{
  operandSizeOverride: number;
  rep: number;
  repne: number;
}>;

export type PrefixModel = Readonly<{
  byByte: readonly (PrefixEffect | undefined)[];
  flagBits: PrefixFlagBits;
  flagMask: number;
}>;

export type SegmentSelection =
  | Readonly<{ kind: "fixed"; segment: SegmentRegister }>
  | Readonly<{
      kind: "overrideOrDefault";
      defaultSegment: SegmentRegister;
    }>;

export type EncodedValue = Readonly<{
  byteLength: 1 | 2 | 4;
  signed: boolean;
}>;

export type DecodeOperand =
  | Readonly<{
      kind: "modrm.reg";
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "modrm.sreg";
      registers: readonly SegmentRegister[];
    }>
  | Readonly<{
      kind: "modrm.rm";
      form: "registerOrMemory";
      registerWidth: OperandWidth;
      memoryWidth: MemoryOperandWidth;
    }>
  | Readonly<{
      kind: "modrm.rm";
      form: "memory";
      memoryWidth: MemoryOperandWidth;
    }>
  | Readonly<{
      kind: "opcode.reg";
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "implicit.reg";
      alias: RegisterAlias;
    }>
  | Readonly<{
      kind: "implicit.sreg";
      reg: SegmentRegister;
    }>
  | Readonly<{
      kind: "implicit.mem";
      accessWidth: OperandWidth;
      base: Reg32;
      disp: number;
      segment: SegmentSelection;
    }>
  | Readonly<{
      kind: "moffs";
      accessWidth: OperandWidth;
      address: EncodedValue;
      segment: SegmentSelection;
    }>
  | Readonly<{
      kind: "immediate";
      encodedWidth: OperandWidth;
      semanticWidth: OperandWidth;
      extension: "none" | "sign";
      value: EncodedValue;
    }>
  | Readonly<{
      kind: "relative";
      width: 8 | 16 | 32;
      displacement: EncodedValue;
    }>;

export type InstructionForm = Readonly<{
  id: string;
  instruction: InstructionSpec;
  opcode: readonly number[];
  opcodeLowBits: number | undefined;
  operands: readonly DecodeOperand[];
  modrm:
    | Readonly<{
        acceptedBytes: readonly boolean[];
      }>
    | undefined;
}>;

export type Displacement = Readonly<{
  byteLength: 0 | 1 | 4;
  signed: boolean;
}>;

export type AddressBase = Readonly<{
  base: Reg32 | undefined;
  displacement: Displacement;
  defaultSegment: SegmentRegister;
}>;

export type MemoryAddress =
  | Readonly<{
      kind: "base";
      address: AddressBase;
    }>
  | Readonly<{
      kind: "sib";
      bases: readonly AddressBase[];
    }>;

export type ModRmMode =
  | Readonly<{
      kind: "register";
    }>
  | Readonly<{
      kind: "memory";
      rm: readonly MemoryAddress[];
    }>;

export type ModRm32Model = Readonly<{
  modes: readonly ModRmMode[];
  sibIndexes: readonly (Reg32 | undefined)[];
  sibScales: readonly EffectiveAddress["scale"][];
}>;

export type ModRmModeForms = Readonly<{
  register: InstructionForm | undefined;
  memory: InstructionForm | undefined;
}>;

export type ModRmFieldSelection =
  | Readonly<{
      kind: "mode";
      forms: ModRmModeForms;
    }>
  | Readonly<{
      kind: "reg";
      byReg: readonly ModRmModeForms[];
    }>;

export type ModRmFormSelection =
  | Readonly<{
      kind: "fields";
      fields: ModRmFieldSelection;
    }>
  | Readonly<{
      kind: "exact";
      byByte: readonly (InstructionForm | undefined)[];
    }>;

export type DecodeCandidate =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "plain";
      form: InstructionForm;
    }>
  | Readonly<{
      kind: "modRm";
      formSelection: ModRmFormSelection;
    }>;

export type OpcodeLeaf = Readonly<{
  opcodeLength: number;
  byPrefix: readonly DecodeCandidate[];
}>;

export type OpcodeNode = Readonly<{
  leaf: OpcodeLeaf | undefined;
  next: readonly (OpcodeNode | undefined)[];
}>;

export type X86DecodeModel = Readonly<{
  instructionLengthLimit: number;
  maximumUnprefixedByteLength: number;
  prefixes: PrefixModel;
  opcodeRoot: OpcodeNode;
  addressForms: ModRm32Model;
  forms: readonly InstructionForm[];
}>;
