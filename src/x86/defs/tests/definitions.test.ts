import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { x86StatusFlags } from "#x86/flags.js";
import { X86_32_CORE } from "#x86/index.js";
import { expandInstructionSpec } from "#x86/schema/builders.js";
import type { InstructionSpec } from "#x86/schema/types.js";
import {
  buildSemanticTrace,
  operands,
  regOperands
} from "#x86/semantics/tests/test-semantics-trace.js";

test("x86-32 core registers the initial instruction surface", () => {
  strictEqual(X86_32_CORE.name, "x86-32-core");
  strictEqual(X86_32_CORE.instructions.length, 389);

  const ids = X86_32_CORE.instructions.map((spec) => spec.id);

  for (const id of [
    "mov.r32_rm32",
    "mov.r8_rm8",
    "mov.r16_rm16",
    "mov.r8_imm8",
    "mov.r16_imm16",
    "mov.al_moffs8",
    "mov.eax_moffs32",
    "mov.ax_moffs16",
    "mov.moffs8_al",
    "mov.moffs32_eax",
    "mov.moffs16_ax",
    "nop.rm16",
    "nop.rm32",
    "mov.rm32_r32",
    "mov.r32_imm32",
    "mov.rm32_imm32",
    "movzx.r16_rm8",
    "movzx.r32_rm8",
    "movzx.r32_rm16",
    "movsx.r16_rm8",
    "movsx.r32_rm8",
    "movsx.r32_rm16",
    "cmove.r16_rm16",
    "cmove.r32_rm32",
    "sete.rm8",
    "xchg.rm8_r8",
    "xchg.rm16_r16",
    "xchg.rm32_r32",
    "xchg.ax_r16",
    "xchg.eax_r32",
    "lea.r16_m16",
    "lea.r32_m32",
    "add.rm8_r8",
    "add.rm16_imm8",
    "add.ax_imm16",
    "add.rm32_imm8",
    "adc.eax_imm32",
    "adc.rm32_imm8",
    "or.rm32_imm8",
    "sbb.eax_imm32",
    "sbb.rm32_imm8",
    "and.rm32_imm8",
    "sub.rm32_imm8",
    "xor.eax_imm32",
    "inc.r32",
    "inc.rm8",
    "inc.rm16",
    "inc.rm32",
    "dec.r32",
    "dec.rm8",
    "dec.rm16",
    "dec.rm32",
    "not.rm8",
    "not.rm16",
    "not.rm32",
    "neg.rm8",
    "neg.rm16",
    "neg.rm32",
    "mul.rm8",
    "mul.rm16",
    "mul.rm32",
    "imul.rm8",
    "imul.rm16",
    "imul.rm32",
    "imul.r16_rm16",
    "imul.r32_rm32",
    "imul.r16_rm16_imm16",
    "imul.r32_rm32_imm32",
    "imul.r16_rm16_imm8",
    "imul.r32_rm32_imm8",
    "bswap.r32",
    "cbw.word",
    "cwde.dword",
    "cwd.word",
    "cdq.dword",
    "rol.rm32_1",
    "ror.rm16_imm8",
    "rcl.rm8_cl",
    "rcr.rm32_cl",
    "shl.rm8_1",
    "shl.rm16_cl",
    "shl.rm32_imm8",
    "shld.rm32_r32_imm8",
    "shr.rm32_cl",
    "shrd.rm16_r16_cl",
    "sar.rm8_imm8",
    "cmp.rm32_imm8",
    "cmp.rm16_imm16",
    "test.al_imm8",
    "test.rm32_imm32",
    "push.r16",
    "push.r32",
    "push.rm16",
    "push.imm16",
    "push.imm8_o16",
    "pop.r16",
    "pop.r32",
    "pop.rm16",
    "pop.rm32",
    "pushad.dword",
    "pusha.word",
    "popad.dword",
    "popa.word",
    "pushf.word",
    "pushfd.dword",
    "popf.word",
    "popfd.dword",
    "leave.near",
    "jmp.rel8",
    "jmp.rel16",
    "jmp.rm16",
    "call.rm32",
    "call.rel16",
    "call.rm16",
    "ret.near_o16",
    "ret.near",
    "ret.imm16_o16",
    "ret.imm16",
    "int.imm8",
    "cmovne.r32_rm32",
    "jne.rel8",
    "jne.rel16",
    "jne.rel32"
  ]) {
    strictEqual(ids.includes(id), true, `missing ${id}`);
  }
});

test("multi-byte nop forms use slash-zero ModRM operands without side effects", () => {
  const near = instruction("nop.rm32");
  const operandSize = instruction("nop.rm16");

  deepStrictEqual(near.opcode, [0x0f, 0x1f]);
  deepStrictEqual(near.modrm, { match: { reg: 0 } });
  deepStrictEqual(near.operands, [{ kind: "modrm.rm", type: "rm32" }]);
  deepStrictEqual(near.format, { syntax: "nop {0}" });

  deepStrictEqual(buildSemanticTrace(semanticsOf(near)).events, ["next"]);

  deepStrictEqual(operandSize.prefixes, { operandSize: "override" });
  deepStrictEqual(operandSize.operands, [{ kind: "modrm.rm", type: "rm16" }]);
});

test("cmovcc forms are concrete specs with select-value semantics", () => {
  const word = instruction("cmove.r16_rm16");
  const spec = instruction("cmove.r32_rm32");

  deepStrictEqual(word.prefixes, { operandSize: "override" });
  deepStrictEqual(word.opcode, [0x0f, 0x44]);
  deepStrictEqual(word.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" }
  ]);

  deepStrictEqual(spec.opcode, [0x0f, 0x44]);
  deepStrictEqual(spec.operands, [
    { kind: "modrm.reg", type: "r32" },
    { kind: "modrm.rm", type: "rm32" }
  ]);
  deepStrictEqual(spec.format, { syntax: "cmove {0}, {1}" });

  const trace = buildSemanticTrace(semanticsOf(spec), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op1:32",
    "%1 = condition E",
    "%2 = get op0:32",
    "set op0:32 <- %3",
    "next"
  ]);
  strictEqual(trace.defs[3], "select(%1, %0, %2)");

  const wordTrace = buildSemanticTrace(semanticsOf(word), regOperands(2));

  deepStrictEqual(wordTrace.events, [
    "%0 = get op1:16",
    "%1 = condition E",
    "%2 = get op0:16",
    "set op0:16 <- %3",
    "next"
  ]);
  strictEqual(wordTrace.defs[3], "select(%1, %0, %2)");
});

test("mov moffs forms use accumulator direct-offset operands", () => {
  const alLoad = instruction("mov.al_moffs8");
  const eaxLoad = instruction("mov.eax_moffs32");
  const axLoad = instruction("mov.ax_moffs16");
  const byteStore = instruction("mov.moffs8_al");
  const dwordStore = instruction("mov.moffs32_eax");
  const wordStore = instruction("mov.moffs16_ax");

  deepStrictEqual(alLoad.opcode, [0xa0]);
  deepStrictEqual(alLoad.operands, [
    { kind: "implicit.reg", reg: "al", type: "r8" },
    { kind: "moffs", width: 8 }
  ]);

  deepStrictEqual(eaxLoad.opcode, [0xa1]);
  deepStrictEqual(eaxLoad.operands, [
    { kind: "implicit.reg", reg: "eax", type: "r32" },
    { kind: "moffs", width: 32 }
  ]);

  deepStrictEqual(axLoad.prefixes, { operandSize: "override" });
  deepStrictEqual(axLoad.opcode, [0xa1]);
  deepStrictEqual(axLoad.operands, [
    { kind: "implicit.reg", reg: "ax", type: "r16" },
    { kind: "moffs", width: 16 }
  ]);

  deepStrictEqual(byteStore.opcode, [0xa2]);
  deepStrictEqual(byteStore.operands, [
    { kind: "moffs", width: 8 },
    { kind: "implicit.reg", reg: "al", type: "r8" }
  ]);

  deepStrictEqual(dwordStore.opcode, [0xa3]);
  deepStrictEqual(dwordStore.operands, [
    { kind: "moffs", width: 32 },
    { kind: "implicit.reg", reg: "eax", type: "r32" }
  ]);

  deepStrictEqual(wordStore.prefixes, { operandSize: "override" });
  deepStrictEqual(wordStore.opcode, [0xa3]);
  deepStrictEqual(wordStore.operands, [
    { kind: "moffs", width: 16 },
    { kind: "implicit.reg", reg: "ax", type: "r16" }
  ]);
});

test("setcc forms use select-value semantics for register or memory destinations", () => {
  const spec = instruction("sete.rm8");

  deepStrictEqual(spec.opcode, [0x0f, 0x94]);
  strictEqual(spec.modrm, undefined);
  deepStrictEqual(spec.operands, [{ kind: "modrm.rm", type: "rm8" }]);
  deepStrictEqual(spec.format, { syntax: "sete {0}" });

  const trace = buildSemanticTrace(semanticsOf(spec), regOperands(1));

  deepStrictEqual(trace.events, [
    "%0 = condition E",
    "set op0:8 <- %1",
    "next"
  ]);
  strictEqual(trace.defs[1], "select(%0, 1, 0)");
});

test("leave is a no-operand stack frame instruction", () => {
  const spec = instruction("leave.near");

  deepStrictEqual(spec.opcode, [0xc9]);
  strictEqual(spec.operands, undefined);
  deepStrictEqual(spec.format, { syntax: "leave" });
});

test("pushfd is a no-operand dword flags push", () => {
  const spec = instruction("pushfd.dword");

  deepStrictEqual(spec.opcode, [0x9c]);
  strictEqual(spec.operands, undefined);
  deepStrictEqual(spec.format, { syntax: "pushfd" });
});

test("pushf is an operand-size word flags push", () => {
  const spec = instruction("pushf.word");

  deepStrictEqual(spec.prefixes, { operandSize: "override" });
  deepStrictEqual(spec.opcode, [0x9c]);
  strictEqual(spec.operands, undefined);
  deepStrictEqual(spec.format, { syntax: "pushf" });
});

test("popfd is a no-operand dword flags pop", () => {
  const spec = instruction("popfd.dword");

  deepStrictEqual(spec.opcode, [0x9d]);
  strictEqual(spec.operands, undefined);
  deepStrictEqual(spec.format, { syntax: "popfd" });
});

test("pushad and popad are no-operand dword stack-all forms", () => {
  const pushad = instruction("pushad.dword");
  const popad = instruction("popad.dword");

  deepStrictEqual(pushad.opcode, [0x60]);
  strictEqual(pushad.operands, undefined);
  deepStrictEqual(pushad.format, { syntax: "pushad" });

  deepStrictEqual(popad.opcode, [0x61]);
  strictEqual(popad.operands, undefined);
  deepStrictEqual(popad.format, { syntax: "popad" });
});

test("pusha and popa are operand-size word stack-all forms", () => {
  const pusha = instruction("pusha.word");
  const popa = instruction("popa.word");

  deepStrictEqual(pusha.prefixes, { operandSize: "override" });
  deepStrictEqual(pusha.opcode, [0x60]);
  strictEqual(pusha.operands, undefined);
  deepStrictEqual(pusha.format, { syntax: "pusha" });

  deepStrictEqual(popa.prefixes, { operandSize: "override" });
  deepStrictEqual(popa.opcode, [0x61]);
  strictEqual(popa.operands, undefined);
  deepStrictEqual(popa.format, { syntax: "popa" });
});

test("popf is an operand-size word flags pop", () => {
  const spec = instruction("popf.word");

  deepStrictEqual(spec.prefixes, { operandSize: "override" });
  deepStrictEqual(spec.opcode, [0x9d]);
  strictEqual(spec.operands, undefined);
  deepStrictEqual(spec.format, { syntax: "popf" });
});

test("operand-size stack forms use word operands with 32-bit ESP semantics", () => {
  const pushReg = instruction("push.r16");
  const pushMem = instruction("push.rm16");
  const pushImm = instruction("push.imm16");
  const pushSignImm = instruction("push.imm8_o16");
  const popReg = instruction("pop.r16");
  const popMem = instruction("pop.rm16");

  deepStrictEqual(pushReg.prefixes, { operandSize: "override" });
  deepStrictEqual(pushReg.operands, [{ kind: "opcode.reg", type: "r16" }]);

  deepStrictEqual(pushMem.prefixes, { operandSize: "override" });
  deepStrictEqual(pushMem.opcode, [0xff]);
  deepStrictEqual(pushMem.modrm, { match: { reg: 6 } });
  deepStrictEqual(pushMem.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(pushImm.prefixes, { operandSize: "override" });
  deepStrictEqual(pushImm.opcode, [0x68]);
  deepStrictEqual(pushImm.operands, [{ kind: "imm", width: 16 }]);

  deepStrictEqual(pushSignImm.prefixes, { operandSize: "override" });
  deepStrictEqual(pushSignImm.opcode, [0x6a]);
  deepStrictEqual(pushSignImm.operands, [{ kind: "imm", width: 8, semanticWidth: 16, extension: "sign" }]);

  deepStrictEqual(popReg.prefixes, { operandSize: "override" });
  deepStrictEqual(popReg.operands, [{ kind: "opcode.reg", type: "r16" }]);

  deepStrictEqual(popMem.prefixes, { operandSize: "override" });
  deepStrictEqual(popMem.opcode, [0x8f]);
  deepStrictEqual(popMem.modrm, { match: { reg: 0 } });
  deepStrictEqual(popMem.operands, [{ kind: "modrm.rm", type: "rm16" }]);
});

test("slash-r forms use ModRM operands without an explicit ModRM match", () => {
  const spec = instruction("mov.r32_rm32");

  deepStrictEqual(spec.opcode, [0x8b]);
  strictEqual(spec.modrm, undefined);
  deepStrictEqual(spec.operands, [
    { kind: "modrm.reg", type: "r32" },
    { kind: "modrm.rm", type: "rm32" }
  ]);
  deepStrictEqual(spec.format, { syntax: "mov {0}, {1}" });
});

test("xchg forms cover ModRM and accumulator opcodes", () => {
  const byte = instruction("xchg.rm8_r8");
  const word = instruction("xchg.rm16_r16");
  const dword = instruction("xchg.rm32_r32");
  const ax = instruction("xchg.ax_r16");
  const eax = instruction("xchg.eax_r32");

  deepStrictEqual(byte.opcode, [0x86]);
  strictEqual(byte.modrm, undefined);
  deepStrictEqual(byte.operands, [
    { kind: "modrm.rm", type: "rm8" },
    { kind: "modrm.reg", type: "r8" }
  ]);
  deepStrictEqual(byte.format, { syntax: "xchg {0}, {1}" });

  deepStrictEqual(word.opcode, [0x87]);
  deepStrictEqual(word.prefixes, { operandSize: "override" });
  strictEqual(word.modrm, undefined);
  deepStrictEqual(word.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" }
  ]);

  deepStrictEqual(dword.opcode, [0x87]);
  strictEqual(dword.modrm, undefined);
  deepStrictEqual(dword.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "modrm.reg", type: "r32" }
  ]);

  deepStrictEqual(ax.prefixes, { operandSize: "override" });
  deepStrictEqual(ax.opcode, [{ byte: 0x90, bits: 5 }]);
  deepStrictEqual(ax.operands, [
    { kind: "implicit.reg", reg: "ax", type: "r16" },
    { kind: "opcode.reg", type: "r16" }
  ]);
  deepStrictEqual(ax.format, { syntax: "xchg {0}, {1}" });

  deepStrictEqual(eax.opcode, [{ byte: 0x90, bits: 5 }]);
  deepStrictEqual(eax.operands, [
    { kind: "implicit.reg", reg: "eax", type: "r32" },
    { kind: "opcode.reg", type: "r32" }
  ]);
  deepStrictEqual(eax.format, { syntax: "xchg {0}, {1}" });
});

test("xchg semantics read both operands before writing either operand", () => {
  const trace = buildSemanticTrace(semanticsOf(instruction("xchg.rm32_r32")), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "%1 = get op1:32",
    "set op1:32 <- %0",
    "set op0:32 <- %1",
    "next"
  ]);
});

test("explicit imul forms use register destinations and signed immediates", () => {
  const regDword = instruction("imul.r32_rm32");
  const regWord = instruction("imul.r16_rm16");
  const immDword = instruction("imul.r32_rm32_imm32");
  const immWord = instruction("imul.r16_rm16_imm16");
  const imm8Dword = instruction("imul.r32_rm32_imm8");
  const imm8Word = instruction("imul.r16_rm16_imm8");

  deepStrictEqual(regDword.opcode, [0x0f, 0xaf]);
  strictEqual(regDword.modrm, undefined);
  deepStrictEqual(regDword.operands, [
    { kind: "modrm.reg", type: "r32" },
    { kind: "modrm.rm", type: "rm32" }
  ]);
  deepStrictEqual(regDword.format, { syntax: "imul {0}, {1}" });

  deepStrictEqual(regWord.prefixes, { operandSize: "override" });
  deepStrictEqual(regWord.opcode, [0x0f, 0xaf]);
  deepStrictEqual(regWord.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" }
  ]);

  deepStrictEqual(immDword.opcode, [0x69]);
  deepStrictEqual(immDword.operands, [
    { kind: "modrm.reg", type: "r32" },
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 32 }
  ]);
  deepStrictEqual(immDword.format, { syntax: "imul {0}, {1}, {2}" });

  deepStrictEqual(immWord.prefixes, { operandSize: "override" });
  deepStrictEqual(immWord.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" },
    { kind: "imm", width: 16 }
  ]);

  deepStrictEqual(imm8Dword.operands, [
    { kind: "modrm.reg", type: "r32" },
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 8, semanticWidth: 32, extension: "sign" }
  ]);
  deepStrictEqual(imm8Word.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" },
    { kind: "imm", width: 8, semanticWidth: 16, extension: "sign" }
  ]);
});

test("implicit multiply forms use one source operand and grouped opcodes", () => {
  const mulByte = instruction("mul.rm8");
  const mulWord = instruction("mul.rm16");
  const mulDword = instruction("mul.rm32");
  const imulByte = instruction("imul.rm8");
  const imulWord = instruction("imul.rm16");
  const imulDword = instruction("imul.rm32");

  deepStrictEqual(mulByte.opcode, [0xf6]);
  deepStrictEqual(mulByte.modrm, { match: { reg: 4 } });
  deepStrictEqual(mulByte.operands, [{ kind: "modrm.rm", type: "rm8" }]);
  deepStrictEqual(mulByte.format, { syntax: "mul {0}" });

  deepStrictEqual(mulWord.prefixes, { operandSize: "override" });
  deepStrictEqual(mulWord.opcode, [0xf7]);
  deepStrictEqual(mulWord.modrm, { match: { reg: 4 } });
  deepStrictEqual(mulWord.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(mulDword.opcode, [0xf7]);
  deepStrictEqual(mulDword.modrm, { match: { reg: 4 } });
  deepStrictEqual(mulDword.operands, [{ kind: "modrm.rm", type: "rm32" }]);

  deepStrictEqual(imulByte.opcode, [0xf6]);
  deepStrictEqual(imulByte.modrm, { match: { reg: 5 } });
  deepStrictEqual(imulByte.operands, [{ kind: "modrm.rm", type: "rm8" }]);
  deepStrictEqual(imulByte.format, { syntax: "imul {0}" });

  deepStrictEqual(imulWord.prefixes, { operandSize: "override" });
  deepStrictEqual(imulWord.opcode, [0xf7]);
  deepStrictEqual(imulWord.modrm, { match: { reg: 5 } });
  deepStrictEqual(imulWord.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(imulDword.opcode, [0xf7]);
  deepStrictEqual(imulDword.modrm, { match: { reg: 5 } });
  deepStrictEqual(imulDword.operands, [{ kind: "modrm.rm", type: "rm32" }]);
});

test("accumulator sign-extension forms are no-operand instructions", () => {
  const cbw = instruction("cbw.word");
  const cwde = instruction("cwde.dword");
  const cwd = instruction("cwd.word");
  const cdq = instruction("cdq.dword");

  deepStrictEqual(cbw.prefixes, { operandSize: "override" });
  deepStrictEqual(cbw.opcode, [0x98]);
  strictEqual(cbw.operands, undefined);
  deepStrictEqual(cbw.format, { syntax: "cbw" });

  deepStrictEqual(cwde.opcode, [0x98]);
  strictEqual(cwde.operands, undefined);
  deepStrictEqual(cwde.format, { syntax: "cwde" });

  deepStrictEqual(cwd.prefixes, { operandSize: "override" });
  deepStrictEqual(cwd.opcode, [0x99]);
  strictEqual(cwd.operands, undefined);
  deepStrictEqual(cwd.format, { syntax: "cwd" });

  deepStrictEqual(cdq.opcode, [0x99]);
  strictEqual(cdq.operands, undefined);
  deepStrictEqual(cdq.format, { syntax: "cdq" });
});

test("rotate forms share group-2 count and width shapes", () => {
  const rol = instruction("rol.rm32_1");
  const ror = instruction("ror.rm16_imm8");
  const rcl = instruction("rcl.rm8_cl");
  const rcr = instruction("rcr.rm32_cl");

  deepStrictEqual(rol.opcode, [0xd1]);
  deepStrictEqual(rol.modrm, { match: { reg: 0 } });
  deepStrictEqual(rol.operands, [{ kind: "modrm.rm", type: "rm32" }]);
  deepStrictEqual(rol.format, { syntax: "rol {0}, 1" });

  deepStrictEqual(ror.prefixes, { operandSize: "override" });
  deepStrictEqual(ror.opcode, [0xc1]);
  deepStrictEqual(ror.modrm, { match: { reg: 1 } });
  deepStrictEqual(ror.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "imm", width: 8 }
  ]);
  deepStrictEqual(ror.format, { syntax: "ror {0}, {1}" });

  deepStrictEqual(rcl.opcode, [0xd2]);
  deepStrictEqual(rcl.modrm, { match: { reg: 2 } });
  deepStrictEqual(rcl.operands, [
    { kind: "modrm.rm", type: "rm8" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  deepStrictEqual(rcl.format, { syntax: "rcl {0}, {1}" });

  deepStrictEqual(rcr.opcode, [0xd3]);
  deepStrictEqual(rcr.modrm, { match: { reg: 3 } });
  deepStrictEqual(rcr.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  deepStrictEqual(rcr.format, { syntax: "rcr {0}, {1}" });
});

test("double-shift forms use two-byte ModRM source and count operands", () => {
  const shldImm = instruction("shld.rm32_r32_imm8");
  const shldCl = instruction("shld.rm16_r16_cl");
  const shrdImm = instruction("shrd.rm16_r16_imm8");
  const shrdCl = instruction("shrd.rm32_r32_cl");

  deepStrictEqual(shldImm.opcode, [0x0f, 0xa4]);
  deepStrictEqual(shldImm.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "modrm.reg", type: "r32" },
    { kind: "imm", width: 8 }
  ]);
  deepStrictEqual(shldImm.format, { syntax: "shld {0}, {1}, {2}" });

  deepStrictEqual(shldCl.prefixes, { operandSize: "override" });
  deepStrictEqual(shldCl.opcode, [0x0f, 0xa5]);
  deepStrictEqual(shldCl.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  deepStrictEqual(shldCl.format, { syntax: "shld {0}, {1}, {2}" });

  deepStrictEqual(shrdImm.prefixes, { operandSize: "override" });
  deepStrictEqual(shrdImm.opcode, [0x0f, 0xac]);
  deepStrictEqual(shrdImm.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" },
    { kind: "imm", width: 8 }
  ]);
  deepStrictEqual(shrdImm.format, { syntax: "shrd {0}, {1}, {2}" });

  deepStrictEqual(shrdCl.opcode, [0x0f, 0xad]);
  deepStrictEqual(shrdCl.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "modrm.reg", type: "r32" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  deepStrictEqual(shrdCl.format, { syntax: "shrd {0}, {1}, {2}" });
});

test("group opcode forms use modrm.match.reg for Intel slash-digit notation", () => {
  const or = instruction("or.rm32_imm8");
  const adc = instruction("adc.rm32_imm8");
  const sbb = instruction("sbb.rm32_imm32");
  const and = instruction("and.rm32_imm32");
  const sub = instruction("sub.rm32_imm8");
  const not = instruction("not.rm32");
  const neg = instruction("neg.rm8");
  const mul = instruction("mul.rm32");
  const imul = instruction("imul.rm8");
  const shl = instruction("shl.rm32_imm8");
  const shr = instruction("shr.rm16_cl");
  const sar = instruction("sar.rm8_1");
  const call = instruction("call.rm32");

  deepStrictEqual(or.opcode, [0x83]);
  deepStrictEqual(or.modrm, { match: { reg: 1 } });
  deepStrictEqual(or.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 8, semanticWidth: 32, extension: "sign" }
  ]);

  deepStrictEqual(adc.opcode, [0x83]);
  deepStrictEqual(adc.modrm, { match: { reg: 2 } });
  deepStrictEqual(adc.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 8, semanticWidth: 32, extension: "sign" }
  ]);

  deepStrictEqual(sbb.opcode, [0x81]);
  deepStrictEqual(sbb.modrm, { match: { reg: 3 } });
  deepStrictEqual(sbb.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 32 }
  ]);

  deepStrictEqual(and.opcode, [0x81]);
  deepStrictEqual(and.modrm, { match: { reg: 4 } });
  deepStrictEqual(and.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 32 }
  ]);

  deepStrictEqual(sub.opcode, [0x83]);
  deepStrictEqual(sub.modrm, { match: { reg: 5 } });
  deepStrictEqual(sub.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 8, semanticWidth: 32, extension: "sign" }
  ]);

  deepStrictEqual(not.opcode, [0xf7]);
  deepStrictEqual(not.modrm, { match: { reg: 2 } });
  deepStrictEqual(not.operands, [{ kind: "modrm.rm", type: "rm32" }]);

  deepStrictEqual(neg.opcode, [0xf6]);
  deepStrictEqual(neg.modrm, { match: { reg: 3 } });
  deepStrictEqual(neg.operands, [{ kind: "modrm.rm", type: "rm8" }]);

  deepStrictEqual(mul.opcode, [0xf7]);
  deepStrictEqual(mul.modrm, { match: { reg: 4 } });
  deepStrictEqual(mul.operands, [{ kind: "modrm.rm", type: "rm32" }]);

  deepStrictEqual(imul.opcode, [0xf6]);
  deepStrictEqual(imul.modrm, { match: { reg: 5 } });
  deepStrictEqual(imul.operands, [{ kind: "modrm.rm", type: "rm8" }]);

  deepStrictEqual(shl.opcode, [0xc1]);
  deepStrictEqual(shl.modrm, { match: { reg: 4 } });
  deepStrictEqual(shl.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 8 }
  ]);

  deepStrictEqual(shr.opcode, [0xd3]);
  deepStrictEqual(shr.prefixes, { operandSize: "override" });
  deepStrictEqual(shr.modrm, { match: { reg: 5 } });
  deepStrictEqual(shr.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);

  deepStrictEqual(sar.opcode, [0xd0]);
  deepStrictEqual(sar.modrm, { match: { reg: 7 } });
  deepStrictEqual(sar.operands, [{ kind: "modrm.rm", type: "rm8" }]);

  deepStrictEqual(call.opcode, [0xff]);
  deepStrictEqual(call.modrm, { match: { reg: 2 } });
  deepStrictEqual(call.operands, [{ kind: "modrm.rm", type: "rm32" }]);
});

test("width-specific decode forms record operand-size metadata", () => {
  const mov8 = instruction("mov.r8_rm8");
  const mov16 = instruction("mov.r16_rm16");
  const movzx16 = instruction("movzx.r16_rm8");
  const movsx16 = instruction("movsx.r16_rm8");
  const lea16 = instruction("lea.r16_m16");
  const add8 = instruction("add.rm8_r8");
  const cmp16 = instruction("cmp.rm16_imm16");
  const not16 = instruction("not.rm16");
  const neg16 = instruction("neg.rm16");
  const imul16 = instruction("imul.r16_rm16");
  const shl16 = instruction("shl.rm16_1");

  deepStrictEqual(mov8.operands, [
    { kind: "modrm.reg", type: "r8" },
    { kind: "modrm.rm", type: "rm8" }
  ]);

  deepStrictEqual(mov16.prefixes, { operandSize: "override" });
  deepStrictEqual(mov16.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" }
  ]);

  deepStrictEqual(movzx16.prefixes, { operandSize: "override" });
  deepStrictEqual(movzx16.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm8" }
  ]);

  deepStrictEqual(movsx16.prefixes, { operandSize: "override" });
  deepStrictEqual(movsx16.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm8" }
  ]);

  deepStrictEqual(lea16.prefixes, { operandSize: "override" });
  deepStrictEqual(lea16.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "m16" }
  ]);

  deepStrictEqual(add8.operands, [
    { kind: "modrm.rm", type: "rm8" },
    { kind: "modrm.reg", type: "r8" }
  ]);

  deepStrictEqual(cmp16.prefixes, { operandSize: "override" });
  deepStrictEqual(cmp16.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "imm", width: 16 }
  ]);

  deepStrictEqual(not16.prefixes, { operandSize: "override" });
  deepStrictEqual(not16.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(neg16.prefixes, { operandSize: "override" });
  deepStrictEqual(neg16.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(imul16.prefixes, { operandSize: "override" });
  deepStrictEqual(imul16.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" }
  ]);

  deepStrictEqual(shl16.prefixes, { operandSize: "override" });
  deepStrictEqual(shl16.operands, [{ kind: "modrm.rm", type: "rm16" }]);
});

test("unary ALU semantics lower to flagless not and sub-flags neg", () => {
  const not = buildSemanticTrace(semanticsOf(instruction("not.rm16")), regOperands(1));

  deepStrictEqual(not.events, [
    "%0 = get op0:16",
    "set op0:16 <- %1",
    "next"
  ]);
  strictEqual(not.defs[1], "xor(%0, 65535)");
  strictEqual(not.flagWrites.length, 0);

  const neg = buildSemanticTrace(semanticsOf(instruction("neg.rm8")), regOperands(1));

  strictEqual(neg.events[0], "%0 = get op0:8");
  strictEqual(neg.defs[1], "sub(0, %0)");
  deepStrictEqual(statusFlagKeys(neg.flagWrites[0]!).sort(), [...x86StatusFlags].sort());
  ok(neg.events.includes("set op0:8 <- %1"));
});

test("mov r/m32, imm32 uses C7 slash-zero form", () => {
  const spec = instruction("mov.rm32_imm32");

  deepStrictEqual(spec.opcode, [0xc7]);
  deepStrictEqual(spec.modrm, { match: { reg: 0 } });
  deepStrictEqual(spec.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "imm", width: 32 }
  ]);
});

test("extension move semantics are flagless and encode source and destination widths", () => {
  const movzx = buildSemanticTrace(semanticsOf(instruction("movzx.r32_rm8")), regOperands(2));
  const movsx = buildSemanticTrace(semanticsOf(instruction("movsx.r16_rm8")), regOperands(2));

  deepStrictEqual(movzx.events, [
    "%0 = get op1:8",
    "set op0:32 <- %0",
    "next"
  ]);
  deepStrictEqual(movsx.events, [
    "%0 = get op1:8:signed",
    "set op0:16 <- %0",
    "next"
  ]);
  strictEqual(movzx.flagWrites.length, 0);
  strictEqual(movsx.flagWrites.length, 0);
});

test("bswap is a flagless opcode-register dword byte swap", () => {
  const spec = instruction("bswap.r32");
  const trace = buildSemanticTrace(semanticsOf(spec), regOperands(1));

  deepStrictEqual(spec.opcode, [0x0f, { byte: 0xc8, bits: 5 }]);
  deepStrictEqual(spec.operands, [{ kind: "opcode.reg", type: "r32" }]);
  deepStrictEqual(spec.format, { syntax: "bswap {0}" });
  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "set op0:32 <- %5",
    "next"
  ]);
  strictEqual(trace.defs[1], "and(%0, 16711935)");
  strictEqual(trace.defs[2], "and(%0, 4278255360)");
  strictEqual(trace.defs[3], "rotr(%1, 8)");
  strictEqual(trace.defs[4], "rotl(%2, 8)");
  strictEqual(trace.defs[5], "or(%3, %4)");
  strictEqual(trace.flagWrites.length, 0);
});

test("opcode-encoded register forms expand through opcode low bits", () => {
  const mov = instruction("mov.r32_imm32");
  const bswap = instruction("bswap.r32");
  const pushWord = instruction("push.r16");
  const push = instruction("push.r32");
  const popWord = instruction("pop.r16");
  const pop = instruction("pop.r32");

  deepStrictEqual(expandInstructionSpec(mov).map((entry) => entry.opcode), [
    [0xb8],
    [0xb9],
    [0xba],
    [0xbb],
    [0xbc],
    [0xbd],
    [0xbe],
    [0xbf]
  ]);
  deepStrictEqual(expandInstructionSpec(bswap).map((entry) => entry.opcode), [
    [0x0f, 0xc8],
    [0x0f, 0xc9],
    [0x0f, 0xca],
    [0x0f, 0xcb],
    [0x0f, 0xcc],
    [0x0f, 0xcd],
    [0x0f, 0xce],
    [0x0f, 0xcf]
  ]);
  deepStrictEqual(expandInstructionSpec(push).map((entry) => entry.opcode), [
    [0x50],
    [0x51],
    [0x52],
    [0x53],
    [0x54],
    [0x55],
    [0x56],
    [0x57]
  ]);
  deepStrictEqual(expandInstructionSpec(pushWord).map((entry) => entry.opcode), [
    [0x50],
    [0x51],
    [0x52],
    [0x53],
    [0x54],
    [0x55],
    [0x56],
    [0x57]
  ]);
  deepStrictEqual(expandInstructionSpec(pop).map((entry) => entry.opcode), [
    [0x58],
    [0x59],
    [0x5a],
    [0x5b],
    [0x5c],
    [0x5d],
    [0x5e],
    [0x5f]
  ]);
  deepStrictEqual(expandInstructionSpec(popWord).map((entry) => entry.opcode), [
    [0x58],
    [0x59],
    [0x5a],
    [0x5b],
    [0x5c],
    [0x5d],
    [0x5e],
    [0x5f]
  ]);
});

test("ret imm16 records unsigned immediate and generic control semantics", () => {
  const spec = instruction("ret.imm16");

  deepStrictEqual(spec.opcode, [0xc2]);
  deepStrictEqual(spec.operands, [{ kind: "imm", width: 16 }]);
  deepStrictEqual(spec.format, { syntax: "ret {0}" });

  const trace = buildSemanticTrace(semanticsOf(spec));

  strictEqual(trace.events.at(-1), "jump %1");
  ok(trace.events.includes("%3 = get op0:32"));
});

test("operand-size near control forms use 16-bit targets and stack cells", () => {
  const jmpRel = instruction("jmp.rel16");
  const jmpRm = instruction("jmp.rm16");
  const callRel = instruction("call.rel16");
  const callRm = instruction("call.rm16");
  const retNear = instruction("ret.near_o16");
  const retImm = instruction("ret.imm16_o16");

  deepStrictEqual(jmpRel.prefixes, { operandSize: "override" });
  deepStrictEqual(jmpRel.opcode, [0xe9]);
  deepStrictEqual(jmpRel.operands, [{ kind: "rel", width: 16 }]);

  deepStrictEqual(jmpRm.prefixes, { operandSize: "override" });
  deepStrictEqual(jmpRm.opcode, [0xff]);
  deepStrictEqual(jmpRm.modrm, { match: { reg: 4 } });
  deepStrictEqual(jmpRm.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(callRel.prefixes, { operandSize: "override" });
  deepStrictEqual(callRel.opcode, [0xe8]);
  deepStrictEqual(callRel.operands, [{ kind: "rel", width: 16 }]);

  deepStrictEqual(callRm.prefixes, { operandSize: "override" });
  deepStrictEqual(callRm.opcode, [0xff]);
  deepStrictEqual(callRm.modrm, { match: { reg: 2 } });
  deepStrictEqual(callRm.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(retNear.prefixes, { operandSize: "override" });
  deepStrictEqual(retNear.opcode, [0xc3]);
  deepStrictEqual(retImm.prefixes, { operandSize: "override" });
  deepStrictEqual(retImm.opcode, [0xc2]);
  deepStrictEqual(retImm.operands, [{ kind: "imm", width: 16 }]);

  const trace = buildSemanticTrace(semanticsOf(jmpRel), operands("relTarget"));

  deepStrictEqual(trace.events, [
    "%0 = get op0:16",
    "jump %1"
  ]);
  strictEqual(trace.defs[1], "truncate16(%0)");
});

test("jcc forms are concrete specs with condition-specific semantics", () => {
  const short = instruction("jne.rel8");
  const word = instruction("jne.rel16");
  const near = instruction("jne.rel32");

  deepStrictEqual(short.opcode, [0x75]);
  deepStrictEqual(short.operands, [{ kind: "rel", width: 8 }]);
  deepStrictEqual(short.format, { syntax: "jne {0}" });

  deepStrictEqual(word.opcode, [0x0f, 0x85]);
  deepStrictEqual(word.prefixes, { operandSize: "override" });
  deepStrictEqual(word.operands, [{ kind: "rel", width: 16 }]);
  deepStrictEqual(word.format, { syntax: "jne {0}" });

  deepStrictEqual(near.opcode, [0x0f, 0x85]);
  deepStrictEqual(near.operands, [{ kind: "rel", width: 32 }]);
  deepStrictEqual(near.format, { syntax: "jne {0}" });

  const trace = buildSemanticTrace(semanticsOf(short));

  deepStrictEqual(trace.events, [
    "%0 = condition NE",
    "%1 = get op0:32",
    "branch %0 ? %1 : nextEip"
  ]);
});

function instruction(id: string): InstructionSpec {
  const spec = X86_32_CORE.instructions.find((entry) => entry.id === id);

  ok(spec !== undefined, `missing instruction ${id}`);

  return spec;
}

function semanticsOf(spec: InstructionSpec): SemanticTemplate {
  return spec.semantics as SemanticTemplate;
}

function statusFlagKeys(write: Partial<Record<(typeof x86StatusFlags)[number], unknown>>): string[] {
  return x86StatusFlags.filter((flag) => flag in write);
}
