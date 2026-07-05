import { form, implicitMem, mnemonic } from "./dsl.js";
import {
  cmpsSemantic,
  lodsSemantic,
  movsSemantic,
  scasSemantic,
  stosSemantic
} from "#x86/semantics/strings.js";
import type { OperandWidth } from "#x86/types.js";

export const MOVS = mnemonic("movs", [
  // A4: MOVS m8, m8
  form("m8_m8", {
    opcode: [0xa4],
    operands: stringMemoryOperands(8),
    syntax: "movs",
    semantics: movsSemantic(8)
  }),
  // 66 A5: MOVS m16, m16
  form("m16_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xa5],
    operands: stringMemoryOperands(16),
    syntax: "movs",
    semantics: movsSemantic(16)
  }),
  // A5: MOVS m32, m32
  form("m32_m32", {
    opcode: [0xa5],
    operands: stringMemoryOperands(32),
    syntax: "movs",
    semantics: movsSemantic(32)
  })
]);

export const CMPS = mnemonic("cmps", [
  // A6: CMPS m8, m8
  form("m8_m8", {
    opcode: [0xa6],
    operands: stringMemoryOperands(8),
    syntax: "cmps",
    semantics: cmpsSemantic(8)
  }),
  // 66 A7: CMPS m16, m16
  form("m16_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xa7],
    operands: stringMemoryOperands(16),
    syntax: "cmps",
    semantics: cmpsSemantic(16)
  }),
  // A7: CMPS m32, m32
  form("m32_m32", {
    opcode: [0xa7],
    operands: stringMemoryOperands(32),
    syntax: "cmps",
    semantics: cmpsSemantic(32)
  })
]);

export const STOS = mnemonic("stos", [
  // AA: STOS m8
  form("m8_al", {
    opcode: [0xaa],
    operands: [ediMemoryOperand(8)],
    syntax: "stos",
    semantics: stosSemantic(8)
  }),
  // 66 AB: STOS m16
  form("m16_ax", {
    prefixes: { operandSize: "override" },
    opcode: [0xab],
    operands: [ediMemoryOperand(16)],
    syntax: "stos",
    semantics: stosSemantic(16)
  }),
  // AB: STOS m32
  form("m32_eax", {
    opcode: [0xab],
    operands: [ediMemoryOperand(32)],
    syntax: "stos",
    semantics: stosSemantic(32)
  })
]);

export const LODS = mnemonic("lods", [
  // AC: LODS m8
  form("al_m8", {
    opcode: [0xac],
    operands: [esiMemoryOperand(8)],
    syntax: "lods",
    semantics: lodsSemantic(8)
  }),
  // 66 AD: LODS m16
  form("ax_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xad],
    operands: [esiMemoryOperand(16)],
    syntax: "lods",
    semantics: lodsSemantic(16)
  }),
  // AD: LODS m32
  form("eax_m32", {
    opcode: [0xad],
    operands: [esiMemoryOperand(32)],
    syntax: "lods",
    semantics: lodsSemantic(32)
  })
]);

export const SCAS = mnemonic("scas", [
  // AE: SCAS m8
  form("al_m8", {
    opcode: [0xae],
    operands: [ediMemoryOperand(8)],
    syntax: "scas",
    semantics: scasSemantic(8)
  }),
  // 66 AF: SCAS m16
  form("ax_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xaf],
    operands: [ediMemoryOperand(16)],
    syntax: "scas",
    semantics: scasSemantic(16)
  }),
  // AF: SCAS m32
  form("eax_m32", {
    opcode: [0xaf],
    operands: [ediMemoryOperand(32)],
    syntax: "scas",
    semantics: scasSemantic(32)
  })
]);

function stringMemoryOperands(width: OperandWidth) {
  return [esiMemoryOperand(width), ediMemoryOperand(width)];
}

function esiMemoryOperand(width: OperandWidth) {
  return implicitMem(width, "esi");
}

function ediMemoryOperand(width: OperandWidth) {
  return implicitMem(width, "edi", 0, { segment: "es" });
}
