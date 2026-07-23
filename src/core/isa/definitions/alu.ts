import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import {
  form,
  imm,
  implicitReg,
  mnemonic,
  modrmReg,
  modrmRm,
  opcodePlusReg,
  opReg
} from "../dsl.js";
import type { InstructionMnemonic, Reg3 } from "../spec.js";
import {
  aluSemantic,
  type AluOp,
  unaryAluSemantic
} from "#core/semantics/alu.js";
import { cmpSemantic } from "#core/semantics/cmp.js";

export const ADD = aluMnemonic("add", 0);
export const OR = aluMnemonic("or", 1);
export const ADC = aluMnemonic("adc", 2);
export const SBB = aluMnemonic("sbb", 3);
export const AND = aluMnemonic("and", 4);
export const SUB = aluMnemonic("sub", 5);
export const XOR = aluMnemonic("xor", 6);
export const CMP = binaryAluMnemonic("cmp", 7, cmpSemantic);

function aluMnemonic(
  operation: AluOp,
  group: Reg3
): InstructionMnemonic {
  return binaryAluMnemonic(
    operation,
    group,
    (width) => aluSemantic(operation, width)
  );
}

function binaryAluMnemonic(
  mnemonicName: string,
  group: Reg3,
  semantic: (width: OperandWidth) => SemanticTemplate
): InstructionMnemonic {
  // The operation selects both its eight-byte primary-opcode row and the
  // ModRM.reg extension of the shared immediate opcodes.
  const opcodeBase = group << 3;
  const syntax = `${mnemonicName} {0}, {1}`;

  return mnemonic(mnemonicName, [
    // base /r: r/m8, r8
    form("rm8_r8", {
      opcode: [opcodeBase],
      operands: [modrmRm("rm8"), modrmReg("r8")],
      syntax,
      semantics: semantic(8)
    }),
    // base+2 /r: r8, r/m8
    form("r8_rm8", {
      opcode: [opcodeBase + 2],
      operands: [modrmReg("r8"), modrmRm("rm8")],
      syntax,
      semantics: semantic(8)
    }),
    // base+4 ib: AL, imm8
    form("al_imm8", {
      opcode: [opcodeBase + 4],
      operands: [implicitReg("al"), imm(8)],
      syntax,
      semantics: semantic(8)
    }),
    // 80 /group ib: r/m8, imm8
    form("rm8_imm8", {
      opcode: [0x80],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm8"), imm(8)],
      syntax,
      semantics: semantic(8)
    }),
    // 66 base+1 /r: r/m16, r16
    form("rm16_r16", {
      prefixes: { operandSize: "override" },
      opcode: [opcodeBase + 1],
      operands: [modrmRm("rm16"), modrmReg("r16")],
      syntax,
      semantics: semantic(16)
    }),
    // 66 base+3 /r: r16, r/m16
    form("r16_rm16", {
      prefixes: { operandSize: "override" },
      opcode: [opcodeBase + 3],
      operands: [modrmReg("r16"), modrmRm("rm16")],
      syntax,
      semantics: semantic(16)
    }),
    // base+1 /r: r/m32, r32
    form("rm32_r32", {
      opcode: [opcodeBase + 1],
      operands: [modrmRm("rm32"), modrmReg("r32")],
      syntax,
      semantics: semantic(32)
    }),
    // base+3 /r: r32, r/m32
    form("r32_rm32", {
      opcode: [opcodeBase + 3],
      operands: [modrmReg("r32"), modrmRm("rm32")],
      syntax,
      semantics: semantic(32)
    }),
    // base+5 id: EAX, imm32
    form("eax_imm32", {
      opcode: [opcodeBase + 5],
      operands: [implicitReg("eax"), imm(32)],
      syntax,
      semantics: semantic(32)
    }),
    // 66 base+5 iw: AX, imm16
    form("ax_imm16", {
      prefixes: { operandSize: "override" },
      opcode: [opcodeBase + 5],
      operands: [implicitReg("ax"), imm(16)],
      syntax,
      semantics: semantic(16)
    }),
    // 66 81 /group iw: r/m16, imm16
    form("rm16_imm16", {
      prefixes: { operandSize: "override" },
      opcode: [0x81],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16"), imm(16)],
      syntax,
      semantics: semantic(16)
    }),
    // 81 /group id: r/m32, imm32
    form("rm32_imm32", {
      opcode: [0x81],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32"), imm(32)],
      syntax,
      semantics: semantic(32)
    }),
    // 66 83 /group ib: r/m16, sign-extended imm8
    form("rm16_imm8", {
      prefixes: { operandSize: "override" },
      opcode: [0x83],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm16"), imm(8, "sign", 16)],
      syntax,
      semantics: semantic(16)
    }),
    // 83 /group ib: r/m32, sign-extended imm8
    form("rm32_imm8", {
      opcode: [0x83],
      modrm: { match: { reg: group } },
      operands: [modrmRm("rm32"), imm(8, "sign", 32)],
      syntax,
      semantics: semantic(32)
    })
  ]);
}

export const INC = mnemonic("inc", [
  // FE /0: INC r/m8
  form("rm8", {
    opcode: [0xfe],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm8")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 8)
  }),
  // 66 40+rw: INC r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x40)],
    operands: [opReg("r16")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 16)
  }),
  // 40+rd: INC r32
  form("r32", {
    opcode: [opcodePlusReg(0x40)],
    operands: [opReg()],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 32)
  }),
  // 66 FF /0: INC r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xff],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 16)
  }),
  // FF /0: INC r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 32)
  })
]);

export const DEC = mnemonic("dec", [
  // FE /1: DEC r/m8
  form("rm8", {
    opcode: [0xfe],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm8")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 8)
  }),
  // 66 48+rw: DEC r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x48)],
    operands: [opReg("r16")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 16)
  }),
  // 48+rd: DEC r32
  form("r32", {
    opcode: [opcodePlusReg(0x48)],
    operands: [opReg()],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 32)
  }),
  // 66 FF /1: DEC r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xff],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm16")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 16)
  }),
  // FF /1: DEC r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm32")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 32)
  })
]);

export const NOT = mnemonic("not", [
  // F6 /2: NOT r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm8")],
    syntax: "not {0}",
    semantics: unaryAluSemantic("not", 8)
  }),
  // 66 F7 /2: NOT r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm16")],
    syntax: "not {0}",
    semantics: unaryAluSemantic("not", 16)
  }),
  // F7 /2: NOT r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm32")],
    syntax: "not {0}",
    semantics: unaryAluSemantic("not", 32)
  })
]);

export const NEG = mnemonic("neg", [
  // F6 /3: NEG r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm8")],
    syntax: "neg {0}",
    semantics: unaryAluSemantic("neg", 8)
  }),
  // 66 F7 /3: NEG r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm16")],
    syntax: "neg {0}",
    semantics: unaryAluSemantic("neg", 16)
  }),
  // F7 /3: NEG r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm32")],
    syntax: "neg {0}",
    semantics: unaryAluSemantic("neg", 32)
  })
]);
