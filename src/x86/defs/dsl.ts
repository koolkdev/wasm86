import type { OperandWidth, RegName, SegmentRegister } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import type {
  DefinedIsa,
  ImmediateExtension,
  InstructionForm,
  InstructionFormSpec,
  InstructionMnemonic,
  InstructionSpec,
  IsaDefinition,
  MemOperandType,
  OperandSpec,
  RegOperandType,
  RmOperandType
} from "./spec.js";

export function form(
  formId: string,
  spec: InstructionFormSpec
): InstructionForm {
  return { formId, spec };
}

export function mnemonic(
  mnemonicName: string,
  forms: readonly InstructionForm[]
): InstructionMnemonic {
  if (forms.length === 0) {
    throw new Error("instruction mnemonic must have at least one form");
  }

  return { mnemonic: mnemonicName, forms };
}

export function defineIsa(definition: IsaDefinition): DefinedIsa {
  return {
    name: definition.name,
    instructionLengthLimit: definition.instructionLengthLimit,
    instructions: definition.mnemonics.flatMap((entry) => instructionsForMnemonic(entry))
  };
}

export function instructionsForMnemonic(
  entry: InstructionMnemonic
): readonly InstructionSpec[] {
  return entry.forms.map((entryForm) =>
    instruction({
      id: `${entry.mnemonic}.${entryForm.formId}`,
      mnemonic: entry.mnemonic,
      ...entryForm.spec
    })
  );
}

export function opcodePlusReg(byte: number): Readonly<{ byte: number; bits: 5 }> {
  return { byte, bits: 5 };
}

function instruction(spec: InstructionSpec): InstructionSpec {
  return spec;
}

export function modrmReg(type: RegOperandType): OperandSpec {
  return { kind: "modrm.reg", type };
}

export function modrmSreg(): OperandSpec {
  return { kind: "modrm.sreg" };
}

export function modrmRm(type: RmOperandType | MemOperandType): OperandSpec {
  return { kind: "modrm.rm", type };
}

export function opReg(type: RegOperandType = "r32"): OperandSpec {
  return { kind: "opcode.reg", type };
}

export function implicitReg(reg: RegName): OperandSpec {
  return { kind: "implicit.reg", reg, type: regTypeForWidth(registerAlias(reg).width) };
}

export function implicitSreg(reg: SegmentRegister): OperandSpec {
  return { kind: "implicit.sreg", reg };
}

export function moffs(width: OperandWidth): OperandSpec {
  return { kind: "moffs", width };
}

export function imm(
  width: OperandWidth,
  extension?: ImmediateExtension,
  semanticWidth?: OperandWidth
): OperandSpec {
  const operand: { kind: "imm"; width: OperandWidth; semanticWidth?: OperandWidth; extension?: ImmediateExtension } = {
    kind: "imm",
    width
  };

  if (semanticWidth !== undefined) {
    operand.semanticWidth = semanticWidth;
  }

  if (extension !== undefined) {
    operand.extension = extension;
  }

  return operand;
}

export function rel(width: 8 | 16 | 32): OperandSpec {
  return { kind: "rel", width };
}

function regTypeForWidth(width: OperandWidth): RegOperandType {
  switch (width) {
    case 8:
      return "r8";
    case 16:
      return "r16";
    case 32:
      return "r32";
  }
}
