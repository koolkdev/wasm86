import {
  CONDITION_CODE_DESCRIPTORS,
  type ConditionCodeDescriptor
} from "#x86/defs/condition-codes.js";
import { form, mnemonic, type InstructionForm, type InstructionMnemonic } from "#x86/schema/builders.js";
import { imm, modrmRm, rel } from "#x86/schema/operands.js";
import { callSemantic, jccSemantic, jmpSemantic, retImmSemantic, retSemantic } from "#x86/semantics/control.js";

export const JMP = mnemonic("jmp", [
  // EB cb: JMP rel8
  form("rel8", {
    opcode: [0xeb],
    operands: [rel(8)],
    format: { syntax: "jmp {0}" },
    semantics: jmpSemantic()
  }),
  // 66 E9 cw: JMP rel16
  form("rel16", {
    opcode: [0xe9],
    prefixes: { operandSize: "override" },
    operands: [rel(16)],
    format: { syntax: "jmp {0}" },
    semantics: jmpSemantic(16)
  }),
  // E9 cd: JMP rel32
  form("rel32", {
    opcode: [0xe9],
    operands: [rel(32)],
    format: { syntax: "jmp {0}" },
    semantics: jmpSemantic()
  }),
  // 66 FF /4: JMP r/m16
  form("rm16", {
    opcode: [0xff],
    prefixes: { operandSize: "override" },
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm16")],
    format: { syntax: "jmp {0}" },
    semantics: jmpSemantic(16)
  }),
  // FF /4: JMP r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm32")],
    format: { syntax: "jmp {0}" },
    semantics: jmpSemantic()
  })
]);

export const CALL = mnemonic("call", [
  // 66 E8 cw: CALL rel16
  form("rel16", {
    opcode: [0xe8],
    prefixes: { operandSize: "override" },
    operands: [rel(16)],
    format: { syntax: "call {0}" },
    semantics: callSemantic(16)
  }),
  // E8 cd: CALL rel32
  form("rel32", {
    opcode: [0xe8],
    operands: [rel(32)],
    format: { syntax: "call {0}" },
    semantics: callSemantic()
  }),
  // 66 FF /2: CALL r/m16
  form("rm16", {
    opcode: [0xff],
    prefixes: { operandSize: "override" },
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm16")],
    format: { syntax: "call {0}" },
    semantics: callSemantic(16)
  }),
  // FF /2: CALL r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm32")],
    format: { syntax: "call {0}" },
    semantics: callSemantic()
  })
]);

export const RET = mnemonic("ret", [
  // 66 C3: RET o16
  form("near_o16", {
    opcode: [0xc3],
    prefixes: { operandSize: "override" },
    format: { syntax: "ret" },
    semantics: retSemantic(16)
  }),
  // C3: RET
  form("near", {
    opcode: [0xc3],
    format: { syntax: "ret" },
    semantics: retSemantic()
  }),
  // 66 C2 iw: RET imm16 o16
  form("imm16_o16", {
    opcode: [0xc2],
    prefixes: { operandSize: "override" },
    operands: [imm(16)],
    format: { syntax: "ret {0}" },
    semantics: retImmSemantic(16)
  }),
  // C2 iw: RET imm16
  form("imm16", {
    opcode: [0xc2],
    operands: [imm(16)],
    format: { syntax: "ret {0}" },
    semantics: retImmSemantic()
  })
]);

export const JCC: readonly InstructionMnemonic[] = CONDITION_CODE_DESCRIPTORS.map(jccMnemonic);

function jccMnemonic(descriptor: ConditionCodeDescriptor): InstructionMnemonic {
  return mnemonic(`j${descriptor.suffix}`, [jccRel8(descriptor), jccRel16(descriptor), jccRel32(descriptor)]);
}

function jccRel8(descriptor: ConditionCodeDescriptor): InstructionForm {
  return form("rel8", {
    opcode: [0x70 + descriptor.opcodeLow],
    operands: [rel(8)],
    format: { syntax: `j${descriptor.suffix} {0}` },
    semantics: jccSemantic(descriptor.cc)
  });
}

function jccRel32(descriptor: ConditionCodeDescriptor): InstructionForm {
  return form("rel32", {
    opcode: [0x0f, 0x80 + descriptor.opcodeLow],
    operands: [rel(32)],
    format: { syntax: `j${descriptor.suffix} {0}` },
    semantics: jccSemantic(descriptor.cc)
  });
}

function jccRel16(descriptor: ConditionCodeDescriptor): InstructionForm {
  return form("rel16", {
    opcode: [0x0f, 0x80 + descriptor.opcodeLow],
    prefixes: { operandSize: "override" },
    operands: [rel(16)],
    format: { syntax: `j${descriptor.suffix} {0}` },
    semantics: jccSemantic(descriptor.cc)
  });
}
