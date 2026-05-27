import type { OperandWidth, RegName } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import type {
  ImmediateExtension,
  MemOperandType,
  OperandSpec,
  RegOperandType,
  RmOperandType
} from "./types.js";

export function modrmReg(type: RegOperandType): OperandSpec {
  return { kind: "modrm.reg", type };
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

export function rel(width: 8 | 32): OperandSpec {
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
