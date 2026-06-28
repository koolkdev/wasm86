import { form, mnemonic } from "#x86/schema/builders.js";
import { imm, implicitReg, modrmRm } from "#x86/schema/operands.js";
import type { InstructionMnemonic } from "#x86/schema/types.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { shiftSemantic, type ShiftOp } from "#x86/semantics/shift.js";

type ShiftGroup = 4 | 5 | 7;

export const SHL = shiftMnemonic("shl", 4);
export const SHR = shiftMnemonic("shr", 5);
export const SAR = shiftMnemonic("sar", 7);

function shiftMnemonic(op: ShiftOp, group: ShiftGroup): InstructionMnemonic<SemanticTemplate> {
  return mnemonic(op, [
    // D0 /n: shift r/m8 by 1
    form("rm8_1", {
      opcode: [0xd0],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8")],
      format: { syntax: `${op} {0}, 1` },
      semantics: shiftSemantic(op, 8, "one")
    }),
    // 66 D1 /n: shift r/m16 by 1
    form("rm16_1", {
      prefixes: { operandSize: "override" },
      opcode: [0xd1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16")],
      format: { syntax: `${op} {0}, 1` },
      semantics: shiftSemantic(op, 16, "one")
    }),
    // D1 /n: shift r/m32 by 1
    form("rm32_1", {
      opcode: [0xd1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32")],
      format: { syntax: `${op} {0}, 1` },
      semantics: shiftSemantic(op, 32, "one")
    }),
    // D2 /n: shift r/m8 by CL
    form("rm8_cl", {
      opcode: [0xd2],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8"), implicitReg("cl")],
      format: { syntax: `${op} {0}, {1}` },
      semantics: shiftSemantic(op, 8, "cl")
    }),
    // 66 D3 /n: shift r/m16 by CL
    form("rm16_cl", {
      prefixes: { operandSize: "override" },
      opcode: [0xd3],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16"), implicitReg("cl")],
      format: { syntax: `${op} {0}, {1}` },
      semantics: shiftSemantic(op, 16, "cl")
    }),
    // D3 /n: shift r/m32 by CL
    form("rm32_cl", {
      opcode: [0xd3],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32"), implicitReg("cl")],
      format: { syntax: `${op} {0}, {1}` },
      semantics: shiftSemantic(op, 32, "cl")
    }),
    // C0 /n ib: shift r/m8 by imm8
    form("rm8_imm8", {
      opcode: [0xc0],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8"), imm(8)],
      format: { syntax: `${op} {0}, {1}` },
      semantics: shiftSemantic(op, 8, "imm8")
    }),
    // 66 C1 /n ib: shift r/m16 by imm8
    form("rm16_imm8", {
      prefixes: { operandSize: "override" },
      opcode: [0xc1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16"), imm(8)],
      format: { syntax: `${op} {0}, {1}` },
      semantics: shiftSemantic(op, 16, "imm8")
    }),
    // C1 /n ib: shift r/m32 by imm8
    form("rm32_imm8", {
      opcode: [0xc1],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32"), imm(8)],
      format: { syntax: `${op} {0}, {1}` },
      semantics: shiftSemantic(op, 32, "imm8")
    })
  ]);
}
