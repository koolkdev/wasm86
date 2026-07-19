import { form, implicitMem, mnemonic } from "../dsl.js";
import {
  cmpsSemantic,
  lodsSemantic,
  movsSemantic,
  repeCmpsSemantic,
  repeScasSemantic,
  repLodsSemantic,
  repMovsSemantic,
  repneCmpsSemantic,
  repneScasSemantic,
  repStosSemantic,
  scasSemantic,
  stosSemantic
} from "#core/semantics/strings.js";
import type { OperandWidth } from "#core/types.js";

export const MOVS = mnemonic("movs", [
  // A4: MOVS m8, m8
  form("m8_m8", {
    opcode: [0xa4],
    operands: stringMemoryOperands(8),
    syntax: "movs",
    semantics: movsSemantic(8)
  }),
  // F3 A4: REP MOVS m8, m8
  form("rep_m8_m8", {
    prefixes: { rep: "rep" },
    opcode: [0xa4],
    operands: stringMemoryOperands(8),
    syntax: "rep movs",
    semantics: repMovsSemantic(8)
  }),
  // 66 A5: MOVS m16, m16
  form("m16_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xa5],
    operands: stringMemoryOperands(16),
    syntax: "movs",
    semantics: movsSemantic(16)
  }),
  // F3 66 A5: REP MOVS m16, m16
  form("rep_m16_m16", {
    prefixes: { operandSize: "override", rep: "rep" },
    opcode: [0xa5],
    operands: stringMemoryOperands(16),
    syntax: "rep movs",
    semantics: repMovsSemantic(16)
  }),
  // A5: MOVS m32, m32
  form("m32_m32", {
    opcode: [0xa5],
    operands: stringMemoryOperands(32),
    syntax: "movs",
    semantics: movsSemantic(32)
  }),
  // F3 A5: REP MOVS m32, m32
  form("rep_m32_m32", {
    prefixes: { rep: "rep" },
    opcode: [0xa5],
    operands: stringMemoryOperands(32),
    syntax: "rep movs",
    semantics: repMovsSemantic(32)
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
  // F3 A6: REPE CMPS m8, m8
  form("repe_m8_m8", {
    prefixes: { rep: "rep" },
    opcode: [0xa6],
    operands: stringMemoryOperands(8),
    syntax: "repe cmps",
    semantics: repeCmpsSemantic(8)
  }),
  // F2 A6: REPNE CMPS m8, m8
  form("repne_m8_m8", {
    prefixes: { rep: "repne" },
    opcode: [0xa6],
    operands: stringMemoryOperands(8),
    syntax: "repne cmps",
    semantics: repneCmpsSemantic(8)
  }),
  // 66 A7: CMPS m16, m16
  form("m16_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xa7],
    operands: stringMemoryOperands(16),
    syntax: "cmps",
    semantics: cmpsSemantic(16)
  }),
  // F3 66 A7: REPE CMPS m16, m16
  form("repe_m16_m16", {
    prefixes: { operandSize: "override", rep: "rep" },
    opcode: [0xa7],
    operands: stringMemoryOperands(16),
    syntax: "repe cmps",
    semantics: repeCmpsSemantic(16)
  }),
  // F2 66 A7: REPNE CMPS m16, m16
  form("repne_m16_m16", {
    prefixes: { operandSize: "override", rep: "repne" },
    opcode: [0xa7],
    operands: stringMemoryOperands(16),
    syntax: "repne cmps",
    semantics: repneCmpsSemantic(16)
  }),
  // A7: CMPS m32, m32
  form("m32_m32", {
    opcode: [0xa7],
    operands: stringMemoryOperands(32),
    syntax: "cmps",
    semantics: cmpsSemantic(32)
  }),
  // F3 A7: REPE CMPS m32, m32
  form("repe_m32_m32", {
    prefixes: { rep: "rep" },
    opcode: [0xa7],
    operands: stringMemoryOperands(32),
    syntax: "repe cmps",
    semantics: repeCmpsSemantic(32)
  }),
  // F2 A7: REPNE CMPS m32, m32
  form("repne_m32_m32", {
    prefixes: { rep: "repne" },
    opcode: [0xa7],
    operands: stringMemoryOperands(32),
    syntax: "repne cmps",
    semantics: repneCmpsSemantic(32)
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
  // F3 AA: REP STOS m8
  form("rep_m8_al", {
    prefixes: { rep: "rep" },
    opcode: [0xaa],
    operands: [ediMemoryOperand(8)],
    syntax: "rep stos",
    semantics: repStosSemantic(8)
  }),
  // 66 AB: STOS m16
  form("m16_ax", {
    prefixes: { operandSize: "override" },
    opcode: [0xab],
    operands: [ediMemoryOperand(16)],
    syntax: "stos",
    semantics: stosSemantic(16)
  }),
  // F3 66 AB: REP STOS m16
  form("rep_m16_ax", {
    prefixes: { operandSize: "override", rep: "rep" },
    opcode: [0xab],
    operands: [ediMemoryOperand(16)],
    syntax: "rep stos",
    semantics: repStosSemantic(16)
  }),
  // AB: STOS m32
  form("m32_eax", {
    opcode: [0xab],
    operands: [ediMemoryOperand(32)],
    syntax: "stos",
    semantics: stosSemantic(32)
  }),
  // F3 AB: REP STOS m32
  form("rep_m32_eax", {
    prefixes: { rep: "rep" },
    opcode: [0xab],
    operands: [ediMemoryOperand(32)],
    syntax: "rep stos",
    semantics: repStosSemantic(32)
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
  // F3 AC: REP LODS m8
  form("rep_al_m8", {
    prefixes: { rep: "rep" },
    opcode: [0xac],
    operands: [esiMemoryOperand(8)],
    syntax: "rep lods",
    semantics: repLodsSemantic(8)
  }),
  // 66 AD: LODS m16
  form("ax_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xad],
    operands: [esiMemoryOperand(16)],
    syntax: "lods",
    semantics: lodsSemantic(16)
  }),
  // F3 66 AD: REP LODS m16
  form("rep_ax_m16", {
    prefixes: { operandSize: "override", rep: "rep" },
    opcode: [0xad],
    operands: [esiMemoryOperand(16)],
    syntax: "rep lods",
    semantics: repLodsSemantic(16)
  }),
  // AD: LODS m32
  form("eax_m32", {
    opcode: [0xad],
    operands: [esiMemoryOperand(32)],
    syntax: "lods",
    semantics: lodsSemantic(32)
  }),
  // F3 AD: REP LODS m32
  form("rep_eax_m32", {
    prefixes: { rep: "rep" },
    opcode: [0xad],
    operands: [esiMemoryOperand(32)],
    syntax: "rep lods",
    semantics: repLodsSemantic(32)
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
  // F3 AE: REPE SCAS m8
  form("repe_al_m8", {
    prefixes: { rep: "rep" },
    opcode: [0xae],
    operands: [ediMemoryOperand(8)],
    syntax: "repe scas",
    semantics: repeScasSemantic(8)
  }),
  // F2 AE: REPNE SCAS m8
  form("repne_al_m8", {
    prefixes: { rep: "repne" },
    opcode: [0xae],
    operands: [ediMemoryOperand(8)],
    syntax: "repne scas",
    semantics: repneScasSemantic(8)
  }),
  // 66 AF: SCAS m16
  form("ax_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0xaf],
    operands: [ediMemoryOperand(16)],
    syntax: "scas",
    semantics: scasSemantic(16)
  }),
  // F3 66 AF: REPE SCAS m16
  form("repe_ax_m16", {
    prefixes: { operandSize: "override", rep: "rep" },
    opcode: [0xaf],
    operands: [ediMemoryOperand(16)],
    syntax: "repe scas",
    semantics: repeScasSemantic(16)
  }),
  // F2 66 AF: REPNE SCAS m16
  form("repne_ax_m16", {
    prefixes: { operandSize: "override", rep: "repne" },
    opcode: [0xaf],
    operands: [ediMemoryOperand(16)],
    syntax: "repne scas",
    semantics: repneScasSemantic(16)
  }),
  // AF: SCAS m32
  form("eax_m32", {
    opcode: [0xaf],
    operands: [ediMemoryOperand(32)],
    syntax: "scas",
    semantics: scasSemantic(32)
  }),
  // F3 AF: REPE SCAS m32
  form("repe_eax_m32", {
    prefixes: { rep: "rep" },
    opcode: [0xaf],
    operands: [ediMemoryOperand(32)],
    syntax: "repe scas",
    semantics: repeScasSemantic(32)
  }),
  // F2 AF: REPNE SCAS m32
  form("repne_eax_m32", {
    prefixes: { rep: "repne" },
    opcode: [0xaf],
    operands: [ediMemoryOperand(32)],
    syntax: "repne scas",
    semantics: repneScasSemantic(32)
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
