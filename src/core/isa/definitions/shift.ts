import { form, imm, implicitReg, mnemonic, modrmReg, modrmRm } from "../dsl.js";
import type { InstructionMnemonic } from "../spec.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { rotateSemantic, type RotateOp } from "#core/semantics/rotate.js";
import {
  doubleShiftSemantic,
  shiftSemantic,
  type DoubleShiftCountSource,
  type DoubleShiftOp,
  type ShiftCountSource,
  type ShiftOp
} from "#core/semantics/shift.js";
import type { OperandWidth } from "#core/types.js";

type Group2 = 0 | 1 | 2 | 3 | 4 | 5 | 7;
type ShiftGroup = 4 | 5 | 7;
type RotateGroup = 0 | 1 | 2 | 3;

export const ROL = rotateMnemonic("rol", 0);
export const ROR = rotateMnemonic("ror", 1);
export const RCL = rotateMnemonic("rcl", 2);
export const RCR = rotateMnemonic("rcr", 3);
export const SHL = shiftMnemonic("shl", 4);
export const SHR = shiftMnemonic("shr", 5);
export const SAR = shiftMnemonic("sar", 7);
export const SHLD = doubleShiftMnemonic("shld", { imm8: 0xa4, cl: 0xa5 });
export const SHRD = doubleShiftMnemonic("shrd", { imm8: 0xac, cl: 0xad });

type Group2Semantic = (width: OperandWidth, countSource: ShiftCountSource) => SemanticTemplate;

function shiftMnemonic(op: ShiftOp, group: ShiftGroup): InstructionMnemonic {
  return group2Mnemonic(op, group, (width, countSource) => shiftSemantic(op, width, countSource));
}

function rotateMnemonic(op: RotateOp, group: RotateGroup): InstructionMnemonic {
  return group2Mnemonic(op, group, (width, countSource) => rotateSemantic(op, width, countSource));
}

function doubleShiftMnemonic(
  op: DoubleShiftOp,
  opcode: Readonly<Record<DoubleShiftCountSource, number>>
): InstructionMnemonic {
  return mnemonic(op, [
    // 66 0F xx /r ib: double-precision shift r/m16, r16 by imm8
    form("rm16_r16_imm8", {
      prefixes: { operandSize: "override" },
      opcode: [0x0f, opcode.imm8],
      operands: [modrmRm("rm16"), modrmReg("r16"), imm(8)],
      syntax: `${op} {0}, {1}, {2}`,
      semantics: doubleShiftSemantic(op, 16, "imm8")
    }),
    // 0F xx /r ib: double-precision shift r/m32, r32 by imm8
    form("rm32_r32_imm8", {
      opcode: [0x0f, opcode.imm8],
      operands: [modrmRm("rm32"), modrmReg("r32"), imm(8)],
      syntax: `${op} {0}, {1}, {2}`,
      semantics: doubleShiftSemantic(op, 32, "imm8")
    }),
    // 66 0F xx /r: double-precision shift r/m16, r16 by CL
    form("rm16_r16_cl", {
      prefixes: { operandSize: "override" },
      opcode: [0x0f, opcode.cl],
      operands: [modrmRm("rm16"), modrmReg("r16"), implicitReg("cl")],
      syntax: `${op} {0}, {1}, {2}`,
      semantics: doubleShiftSemantic(op, 16, "cl")
    }),
    // 0F xx /r: double-precision shift r/m32, r32 by CL
    form("rm32_r32_cl", {
      opcode: [0x0f, opcode.cl],
      operands: [modrmRm("rm32"), modrmReg("r32"), implicitReg("cl")],
      syntax: `${op} {0}, {1}, {2}`,
      semantics: doubleShiftSemantic(op, 32, "cl")
    })
  ]);
}

function group2Mnemonic(
  op: ShiftOp | RotateOp,
  group: Group2,
  semantic: Group2Semantic
): InstructionMnemonic {
  return mnemonic(op, [
    // D0 /n: group-2 r/m8 by 1
    form("rm8_1", {
      opcode: [0xd0],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8")],
      syntax: `${op} {0}, 1`,
      semantics: semantic(8, "one")
    }),
    // 66 D1 /n: group-2 r/m16 by 1
    form("rm16_1", {
      prefixes: { operandSize: "override" },
      opcode: [0xd1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16")],
      syntax: `${op} {0}, 1`,
      semantics: semantic(16, "one")
    }),
    // D1 /n: group-2 r/m32 by 1
    form("rm32_1", {
      opcode: [0xd1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32")],
      syntax: `${op} {0}, 1`,
      semantics: semantic(32, "one")
    }),
    // D2 /n: group-2 r/m8 by CL
    form("rm8_cl", {
      opcode: [0xd2],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8"), implicitReg("cl")],
      syntax: `${op} {0}, {1}`,
      semantics: semantic(8, "cl")
    }),
    // 66 D3 /n: group-2 r/m16 by CL
    form("rm16_cl", {
      prefixes: { operandSize: "override" },
      opcode: [0xd3],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16"), implicitReg("cl")],
      syntax: `${op} {0}, {1}`,
      semantics: semantic(16, "cl")
    }),
    // D3 /n: group-2 r/m32 by CL
    form("rm32_cl", {
      opcode: [0xd3],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32"), implicitReg("cl")],
      syntax: `${op} {0}, {1}`,
      semantics: semantic(32, "cl")
    }),
    // C0 /n ib: group-2 r/m8 by imm8
    form("rm8_imm8", {
      opcode: [0xc0],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8"), imm(8)],
      syntax: `${op} {0}, {1}`,
      semantics: semantic(8, "imm8")
    }),
    // 66 C1 /n ib: group-2 r/m16 by imm8
    form("rm16_imm8", {
      prefixes: { operandSize: "override" },
      opcode: [0xc1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16"), imm(8)],
      syntax: `${op} {0}, {1}`,
      semantics: semantic(16, "imm8")
    }),
    // C1 /n ib: group-2 r/m32 by imm8
    form("rm32_imm8", {
      opcode: [0xc1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32"), imm(8)],
      syntax: `${op} {0}, {1}`,
      semantics: semantic(32, "imm8")
    })
  ]);
}
