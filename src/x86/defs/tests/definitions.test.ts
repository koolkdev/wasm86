import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { x86StatusFlags } from "#x86/flags.js";
import { X86_32_CORE } from "#x86/index.js";
import { expandInstructionSpec, type InstructionSpec } from "#x86/defs/spec.js";
import {
  buildSemanticTrace,
  operands,
  regOperands
} from "#x86/semantics/tests/test-semantics-trace.js";

test("x86-32 core registers the initial instruction surface", () => {
  strictEqual(X86_32_CORE.name, "x86-32-core");
  strictEqual(X86_32_CORE.instructionLengthLimit, 15);
  strictEqual(X86_32_CORE.instructions.length, 505);

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
    "mov.rm16_sreg",
    "mov.rm32_sreg",
    "mov.sreg_rm16",
    "mov.sreg_rm16_o16",
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
    "daa.al",
    "das.al",
    "xor.eax_imm32",
    "aaa.al_ah",
    "aas.al_ah",
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
    "div.rm8",
    "div.rm16",
    "div.rm32",
    "idiv.rm8",
    "idiv.rm16",
    "idiv.rm32",
    "bswap.r32",
    "clc.near",
    "stc.near",
    "cmc.near",
    "cld.near",
    "std.near",
    "lahf.ah",
    "sahf.ah",
    "xlat.m8_al",
    "movs.m8_m8",
    "movs.rep_m8_m8",
    "movs.m16_m16",
    "movs.rep_m16_m16",
    "movs.m32_m32",
    "movs.rep_m32_m32",
    "cmps.m8_m8",
    "cmps.repe_m8_m8",
    "cmps.repne_m8_m8",
    "cmps.m16_m16",
    "cmps.repe_m16_m16",
    "cmps.repne_m16_m16",
    "cmps.m32_m32",
    "cmps.repe_m32_m32",
    "cmps.repne_m32_m32",
    "stos.m8_al",
    "stos.rep_m8_al",
    "stos.m16_ax",
    "stos.rep_m16_ax",
    "stos.m32_eax",
    "stos.rep_m32_eax",
    "lods.al_m8",
    "lods.rep_al_m8",
    "lods.ax_m16",
    "lods.rep_ax_m16",
    "lods.eax_m32",
    "lods.rep_eax_m32",
    "scas.al_m8",
    "scas.repe_al_m8",
    "scas.repne_al_m8",
    "scas.ax_m16",
    "scas.repe_ax_m16",
    "scas.repne_ax_m16",
    "scas.eax_m32",
    "scas.repe_eax_m32",
    "scas.repne_eax_m32",
    "cbw.word",
    "cwde.dword",
    "cwd.word",
    "cdq.dword",
    "aam.imm8",
    "aad.imm8",
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
    "bt.rm32_r32",
    "bts.rm16_imm8",
    "btr.rm32_imm8",
    "btc.rm32_r32",
    "bsf.r16_rm16",
    "bsr.r32_rm32",
    "cmpxchg.rm8_r8",
    "cmpxchg.rm16_r16",
    "cmpxchg.rm32_r32",
    "xadd.rm8_r8",
    "xadd.rm16_r16",
    "xadd.rm32_r32",
    "cmpxchg8b.m64",
    "cmp.rm32_imm8",
    "cmp.rm16_imm16",
    "test.al_imm8",
    "test.rm32_imm32",
    "push.r16",
    "push.r32",
    "push.es",
    "push.fs",
    "push.gs_o16",
    "push.rm16",
    "push.imm16",
    "push.imm8_o16",
    "pop.r16",
    "pop.r32",
    "pop.ds",
    "pop.fs",
    "pop.gs_o16",
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
    "jecxz.rel8",
    "loop.rel8",
    "loope.rel8",
    "loopne.rel8",
    "wait.near",
    "int.imm8",
    "int3.near",
    "into.near",
    "cmovne.r32_rm32",
    "jne.rel8",
    "jne.rel16",
    "jne.rel32"
  ]) {
    strictEqual(ids.includes(id), true, `missing ${id}`);
  }
});

test("mov segment-register forms use Sreg ModRM operands", () => {
  const word = instruction("mov.rm16_sreg");
  const dword = instruction("mov.rm32_sreg");
  const toSegment = instruction("mov.sreg_rm16");
  const toSegmentOperandSize = instruction("mov.sreg_rm16_o16");

  deepStrictEqual(word.prefixes, { operandSize: "override" });
  deepStrictEqual(word.opcode, [0x8c]);
  deepStrictEqual(word.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.sreg" }
  ]);

  deepStrictEqual(dword.opcode, [0x8c]);
  deepStrictEqual(dword.operands, [
    { kind: "modrm.rm", type: "r32_m16" },
    { kind: "modrm.sreg" }
  ]);

  deepStrictEqual(toSegment.opcode, [0x8e]);
  deepStrictEqual(toSegment.operands, [
    { kind: "modrm.sreg" },
    { kind: "modrm.rm", type: "rm16" }
  ]);

  deepStrictEqual(toSegmentOperandSize.prefixes, { operandSize: "override" });
  deepStrictEqual(toSegmentOperandSize.opcode, [0x8e]);
  deepStrictEqual(toSegmentOperandSize.operands, toSegment.operands);
  deepStrictEqual(buildSemanticTrace(semanticsOf(toSegment), operands("reg", "reg")).events, [
    "%0 = get op1:16",
    "set op0:16 <- %0",
    "next"
  ]);
});

test("multi-byte nop forms use slash-zero ModRM operands without side effects", () => {
  const near = instruction("nop.rm32");
  const operandSize = instruction("nop.rm16");

  deepStrictEqual(near.opcode, [0x0f, 0x1f]);
  deepStrictEqual(near.modrm, { match: { reg: 0 } });
  deepStrictEqual(near.operands, [{ kind: "modrm.rm", type: "rm32" }]);
  strictEqual(near.syntax, "nop {0}");

  deepStrictEqual(buildSemanticTrace(semanticsOf(near)).events, ["next"]);

  deepStrictEqual(operandSize.prefixes, { operandSize: "override" });
  deepStrictEqual(operandSize.operands, [{ kind: "modrm.rm", type: "rm16" }]);
});

test("flag and misc scalar forms use fixed one-byte opcodes", () => {
  const cases = [
    ["clc.near", [0xf8], "clc"],
    ["stc.near", [0xf9], "stc"],
    ["cmc.near", [0xf5], "cmc"],
    ["cld.near", [0xfc], "cld"],
    ["std.near", [0xfd], "std"],
    ["lahf.ah", [0x9f], "lahf"],
    ["sahf.ah", [0x9e], "sahf"],
    ["wait.near", [0x9b], "wait"]
  ] as const;

  for (const [id, opcode, syntax] of cases) {
    const spec = instruction(id);

    deepStrictEqual(spec.opcode, opcode, id);
    strictEqual(spec.syntax, syntax, id);
    deepStrictEqual(spec.operands, undefined, id);
  }

  deepStrictEqual(buildSemanticTrace(semanticsOf(instruction("wait.near"))).events, ["next"]);
});

test("xlat form is operand-less syntax over a hidden EBX byte memory operand", () => {
  const spec = instruction("xlat.m8_al");

  deepStrictEqual(spec.opcode, [0xd7]);
  strictEqual(spec.syntax, "xlat");
  deepStrictEqual(spec.operands, [{ kind: "implicit.mem", width: 8, base: "ebx", disp: 0 }]);

  const trace = buildSemanticTrace(semanticsOf(spec), operands("mem"));

  deepStrictEqual(trace.events.slice(0, 3), [
    "%0 = addr op0",
    "%1 = get al:8",
    "guard read %2:1"
  ]);
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
  strictEqual(spec.syntax, "cmove {0}, {1}");

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

test("string forms use hidden ESI and fixed ES:EDI memory operands", () => {
  const movsByte = instruction("movs.m8_m8");
  const movsWord = instruction("movs.m16_m16");
  const movsDword = instruction("movs.m32_m32");
  const cmpsDword = instruction("cmps.m32_m32");
  const stosDword = instruction("stos.m32_eax");
  const lodsDword = instruction("lods.eax_m32");
  const scasDword = instruction("scas.eax_m32");

  deepStrictEqual(movsByte.opcode, [0xa4]);
  deepStrictEqual(movsByte.operands, [
    { kind: "implicit.mem", width: 8, base: "esi", disp: 0 },
    { kind: "implicit.mem", width: 8, base: "edi", disp: 0, segment: "es" }
  ]);
  strictEqual(movsByte.syntax, "movs");

  deepStrictEqual(movsWord.prefixes, { operandSize: "override" });
  deepStrictEqual(movsWord.opcode, [0xa5]);
  deepStrictEqual(movsWord.operands, [
    { kind: "implicit.mem", width: 16, base: "esi", disp: 0 },
    { kind: "implicit.mem", width: 16, base: "edi", disp: 0, segment: "es" }
  ]);

  deepStrictEqual(movsDword.opcode, [0xa5]);
  deepStrictEqual(movsDword.operands, [
    { kind: "implicit.mem", width: 32, base: "esi", disp: 0 },
    { kind: "implicit.mem", width: 32, base: "edi", disp: 0, segment: "es" }
  ]);

  deepStrictEqual(cmpsDword.opcode, [0xa7]);
  deepStrictEqual(cmpsDword.operands, movsDword.operands);

  deepStrictEqual(stosDword.opcode, [0xab]);
  deepStrictEqual(stosDword.operands, [
    { kind: "implicit.mem", width: 32, base: "edi", disp: 0, segment: "es" }
  ]);

  deepStrictEqual(lodsDword.opcode, [0xad]);
  deepStrictEqual(lodsDword.operands, [
    { kind: "implicit.mem", width: 32, base: "esi", disp: 0 }
  ]);

  deepStrictEqual(scasDword.opcode, [0xaf]);
  deepStrictEqual(scasDword.operands, stosDword.operands);
});

test("setcc forms use select-value semantics for register or memory destinations", () => {
  const spec = instruction("sete.rm8");

  deepStrictEqual(spec.opcode, [0x0f, 0x94]);
  strictEqual(spec.modrm, undefined);
  deepStrictEqual(spec.operands, [{ kind: "modrm.rm", type: "rm8" }]);
  strictEqual(spec.syntax, "sete {0}");

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
  strictEqual(spec.syntax, "leave");
});

test("pushfd is a no-operand dword flags push", () => {
  const spec = instruction("pushfd.dword");

  deepStrictEqual(spec.opcode, [0x9c]);
  strictEqual(spec.operands, undefined);
  strictEqual(spec.syntax, "pushfd");
});

test("pushf is an operand-size word flags push", () => {
  const spec = instruction("pushf.word");

  deepStrictEqual(spec.prefixes, { operandSize: "override" });
  deepStrictEqual(spec.opcode, [0x9c]);
  strictEqual(spec.operands, undefined);
  strictEqual(spec.syntax, "pushf");
});

test("popfd is a no-operand dword flags pop", () => {
  const spec = instruction("popfd.dword");

  deepStrictEqual(spec.opcode, [0x9d]);
  strictEqual(spec.operands, undefined);
  strictEqual(spec.syntax, "popfd");
});

test("pushad and popad are no-operand dword stack-all forms", () => {
  const pushad = instruction("pushad.dword");
  const popad = instruction("popad.dword");

  deepStrictEqual(pushad.opcode, [0x60]);
  strictEqual(pushad.operands, undefined);
  strictEqual(pushad.syntax, "pushad");

  deepStrictEqual(popad.opcode, [0x61]);
  strictEqual(popad.operands, undefined);
  strictEqual(popad.syntax, "popad");
});

test("pusha and popa are operand-size word stack-all forms", () => {
  const pusha = instruction("pusha.word");
  const popa = instruction("popa.word");

  deepStrictEqual(pusha.prefixes, { operandSize: "override" });
  deepStrictEqual(pusha.opcode, [0x60]);
  strictEqual(pusha.operands, undefined);
  strictEqual(pusha.syntax, "pusha");

  deepStrictEqual(popa.prefixes, { operandSize: "override" });
  deepStrictEqual(popa.opcode, [0x61]);
  strictEqual(popa.operands, undefined);
  strictEqual(popa.syntax, "popa");
});

test("popf is an operand-size word flags pop", () => {
  const spec = instruction("popf.word");

  deepStrictEqual(spec.prefixes, { operandSize: "override" });
  deepStrictEqual(spec.opcode, [0x9d]);
  strictEqual(spec.operands, undefined);
  strictEqual(spec.syntax, "popf");
});

test("push segment forms name each fixed segment-register opcode", () => {
  const es = instruction("push.es");
  const fs = instruction("push.fs");
  const gsWord = instruction("push.gs_o16");

  deepStrictEqual(es.opcode, [0x06]);
  deepStrictEqual(es.operands, [{ kind: "implicit.sreg", reg: "es" }]);

  deepStrictEqual(fs.opcode, [0x0f, 0xa0]);
  deepStrictEqual(fs.operands, [{ kind: "implicit.sreg", reg: "fs" }]);

  deepStrictEqual(gsWord.prefixes, { operandSize: "override" });
  deepStrictEqual(gsWord.opcode, [0x0f, 0xa8]);
  deepStrictEqual(gsWord.operands, [{ kind: "implicit.sreg", reg: "gs" }]);
});

test("pop segment forms name each writable fixed segment-register opcode", () => {
  const es = instruction("pop.es");
  const ss = instruction("pop.ss");
  const ds = instruction("pop.ds");
  const fs = instruction("pop.fs");
  const gsWord = instruction("pop.gs_o16");

  deepStrictEqual(es.opcode, [0x07]);
  deepStrictEqual(es.operands, [{ kind: "implicit.sreg", reg: "es" }]);

  deepStrictEqual(ss.opcode, [0x17]);
  deepStrictEqual(ss.operands, [{ kind: "implicit.sreg", reg: "ss" }]);

  deepStrictEqual(ds.opcode, [0x1f]);
  deepStrictEqual(ds.operands, [{ kind: "implicit.sreg", reg: "ds" }]);

  deepStrictEqual(fs.opcode, [0x0f, 0xa1]);
  deepStrictEqual(fs.operands, [{ kind: "implicit.sreg", reg: "fs" }]);

  deepStrictEqual(gsWord.prefixes, { operandSize: "override" });
  deepStrictEqual(gsWord.opcode, [0x0f, 0xa9]);
  deepStrictEqual(gsWord.operands, [{ kind: "implicit.sreg", reg: "gs" }]);
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
  strictEqual(spec.syntax, "mov {0}, {1}");
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
  strictEqual(byte.syntax, "xchg {0}, {1}");

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
  strictEqual(ax.syntax, "xchg {0}, {1}");

  deepStrictEqual(eax.opcode, [{ byte: 0x90, bits: 5 }]);
  deepStrictEqual(eax.operands, [
    { kind: "implicit.reg", reg: "eax", type: "r32" },
    { kind: "opcode.reg", type: "r32" }
  ]);
  strictEqual(eax.syntax, "xchg {0}, {1}");
});

test("compare-exchange forms cover cmpxchg, xadd, and cmpxchg8b", () => {
  const cmpxchgByte = instruction("cmpxchg.rm8_r8");
  const cmpxchgWord = instruction("cmpxchg.rm16_r16");
  const cmpxchgDword = instruction("cmpxchg.rm32_r32");
  const xaddByte = instruction("xadd.rm8_r8");
  const xaddWord = instruction("xadd.rm16_r16");
  const xaddDword = instruction("xadd.rm32_r32");
  const cmpxchg8b = instruction("cmpxchg8b.m64");

  deepStrictEqual(cmpxchgByte.opcode, [0x0f, 0xb0]);
  deepStrictEqual(cmpxchgByte.operands, [
    { kind: "modrm.rm", type: "rm8" },
    { kind: "modrm.reg", type: "r8" }
  ]);
  strictEqual(cmpxchgByte.syntax, "cmpxchg {0}, {1}");

  deepStrictEqual(cmpxchgWord.prefixes, { operandSize: "override" });
  deepStrictEqual(cmpxchgWord.opcode, [0x0f, 0xb1]);
  deepStrictEqual(cmpxchgWord.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" }
  ]);

  deepStrictEqual(cmpxchgDword.opcode, [0x0f, 0xb1]);
  deepStrictEqual(cmpxchgDword.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "modrm.reg", type: "r32" }
  ]);

  deepStrictEqual(xaddByte.opcode, [0x0f, 0xc0]);
  deepStrictEqual(xaddByte.operands, [
    { kind: "modrm.rm", type: "rm8" },
    { kind: "modrm.reg", type: "r8" }
  ]);
  strictEqual(xaddByte.syntax, "xadd {0}, {1}");

  deepStrictEqual(xaddWord.prefixes, { operandSize: "override" });
  deepStrictEqual(xaddWord.opcode, [0x0f, 0xc1]);
  deepStrictEqual(xaddWord.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" }
  ]);

  deepStrictEqual(xaddDword.opcode, [0x0f, 0xc1]);
  deepStrictEqual(xaddDword.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "modrm.reg", type: "r32" }
  ]);

  deepStrictEqual(cmpxchg8b.opcode, [0x0f, 0xc7]);
  deepStrictEqual(cmpxchg8b.modrm, { match: { reg: 1 } });
  deepStrictEqual(cmpxchg8b.operands, [
    { kind: "modrm.rm", type: "m64" }
  ]);
  strictEqual(cmpxchg8b.syntax, "cmpxchg8b {0}");
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
  strictEqual(regDword.syntax, "imul {0}, {1}");

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
  strictEqual(immDword.syntax, "imul {0}, {1}, {2}");

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
  strictEqual(mulByte.syntax, "mul {0}");

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
  strictEqual(imulByte.syntax, "imul {0}");

  deepStrictEqual(imulWord.prefixes, { operandSize: "override" });
  deepStrictEqual(imulWord.opcode, [0xf7]);
  deepStrictEqual(imulWord.modrm, { match: { reg: 5 } });
  deepStrictEqual(imulWord.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(imulDword.opcode, [0xf7]);
  deepStrictEqual(imulDword.modrm, { match: { reg: 5 } });
  deepStrictEqual(imulDword.operands, [{ kind: "modrm.rm", type: "rm32" }]);
});

test("divide forms use one source operand and grouped opcodes", () => {
  const divByte = instruction("div.rm8");
  const divWord = instruction("div.rm16");
  const divDword = instruction("div.rm32");
  const idivByte = instruction("idiv.rm8");
  const idivWord = instruction("idiv.rm16");
  const idivDword = instruction("idiv.rm32");

  deepStrictEqual(divByte.opcode, [0xf6]);
  deepStrictEqual(divByte.modrm, { match: { reg: 6 } });
  deepStrictEqual(divByte.operands, [{ kind: "modrm.rm", type: "rm8" }]);
  strictEqual(divByte.syntax, "div {0}");

  deepStrictEqual(divWord.prefixes, { operandSize: "override" });
  deepStrictEqual(divWord.opcode, [0xf7]);
  deepStrictEqual(divWord.modrm, { match: { reg: 6 } });
  deepStrictEqual(divWord.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(divDword.opcode, [0xf7]);
  deepStrictEqual(divDword.modrm, { match: { reg: 6 } });
  deepStrictEqual(divDword.operands, [{ kind: "modrm.rm", type: "rm32" }]);

  deepStrictEqual(idivByte.opcode, [0xf6]);
  deepStrictEqual(idivByte.modrm, { match: { reg: 7 } });
  deepStrictEqual(idivByte.operands, [{ kind: "modrm.rm", type: "rm8" }]);
  strictEqual(idivByte.syntax, "idiv {0}");

  deepStrictEqual(idivWord.prefixes, { operandSize: "override" });
  deepStrictEqual(idivWord.opcode, [0xf7]);
  deepStrictEqual(idivWord.modrm, { match: { reg: 7 } });
  deepStrictEqual(idivWord.operands, [{ kind: "modrm.rm", type: "rm16" }]);

  deepStrictEqual(idivDword.opcode, [0xf7]);
  deepStrictEqual(idivDword.modrm, { match: { reg: 7 } });
  deepStrictEqual(idivDword.operands, [{ kind: "modrm.rm", type: "rm32" }]);
});

test("accumulator sign-extension forms are no-operand instructions", () => {
  const cbw = instruction("cbw.word");
  const cwde = instruction("cwde.dword");
  const cwd = instruction("cwd.word");
  const cdq = instruction("cdq.dword");

  deepStrictEqual(cbw.prefixes, { operandSize: "override" });
  deepStrictEqual(cbw.opcode, [0x98]);
  strictEqual(cbw.operands, undefined);
  strictEqual(cbw.syntax, "cbw");

  deepStrictEqual(cwde.opcode, [0x98]);
  strictEqual(cwde.operands, undefined);
  strictEqual(cwde.syntax, "cwde");

  deepStrictEqual(cwd.prefixes, { operandSize: "override" });
  deepStrictEqual(cwd.opcode, [0x99]);
  strictEqual(cwd.operands, undefined);
  strictEqual(cwd.syntax, "cwd");

  deepStrictEqual(cdq.opcode, [0x99]);
  strictEqual(cdq.operands, undefined);
  strictEqual(cdq.syntax, "cdq");
});

test("rotate forms share group-2 count and width shapes", () => {
  const rol = instruction("rol.rm32_1");
  const ror = instruction("ror.rm16_imm8");
  const rcl = instruction("rcl.rm8_cl");
  const rcr = instruction("rcr.rm32_cl");

  deepStrictEqual(rol.opcode, [0xd1]);
  deepStrictEqual(rol.modrm, { match: { reg: 0 } });
  deepStrictEqual(rol.operands, [{ kind: "modrm.rm", type: "rm32" }]);
  strictEqual(rol.syntax, "rol {0}, 1");

  deepStrictEqual(ror.prefixes, { operandSize: "override" });
  deepStrictEqual(ror.opcode, [0xc1]);
  deepStrictEqual(ror.modrm, { match: { reg: 1 } });
  deepStrictEqual(ror.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "imm", width: 8 }
  ]);
  strictEqual(ror.syntax, "ror {0}, {1}");

  deepStrictEqual(rcl.opcode, [0xd2]);
  deepStrictEqual(rcl.modrm, { match: { reg: 2 } });
  deepStrictEqual(rcl.operands, [
    { kind: "modrm.rm", type: "rm8" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  strictEqual(rcl.syntax, "rcl {0}, {1}");

  deepStrictEqual(rcr.opcode, [0xd3]);
  deepStrictEqual(rcr.modrm, { match: { reg: 3 } });
  deepStrictEqual(rcr.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  strictEqual(rcr.syntax, "rcr {0}, {1}");
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
  strictEqual(shldImm.syntax, "shld {0}, {1}, {2}");

  deepStrictEqual(shldCl.prefixes, { operandSize: "override" });
  deepStrictEqual(shldCl.opcode, [0x0f, 0xa5]);
  deepStrictEqual(shldCl.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  strictEqual(shldCl.syntax, "shld {0}, {1}, {2}");

  deepStrictEqual(shrdImm.prefixes, { operandSize: "override" });
  deepStrictEqual(shrdImm.opcode, [0x0f, 0xac]);
  deepStrictEqual(shrdImm.operands, [
    { kind: "modrm.rm", type: "rm16" },
    { kind: "modrm.reg", type: "r16" },
    { kind: "imm", width: 8 }
  ]);
  strictEqual(shrdImm.syntax, "shrd {0}, {1}, {2}");

  deepStrictEqual(shrdCl.opcode, [0x0f, 0xad]);
  deepStrictEqual(shrdCl.operands, [
    { kind: "modrm.rm", type: "rm32" },
    { kind: "modrm.reg", type: "r32" },
    { kind: "implicit.reg", reg: "cl", type: "r8" }
  ]);
  strictEqual(shrdCl.syntax, "shrd {0}, {1}, {2}");
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
  strictEqual(spec.syntax, "bswap {0}");
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
  strictEqual(spec.syntax, "ret {0}");

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

test("ecx loop control forms use default rel8 targets", () => {
  const jecxz = instruction("jecxz.rel8");
  const loop = instruction("loop.rel8");
  const loope = instruction("loope.rel8");
  const loopne = instruction("loopne.rel8");

  deepStrictEqual(jecxz.opcode, [0xe3]);
  deepStrictEqual(loop.opcode, [0xe2]);
  deepStrictEqual(loope.opcode, [0xe1]);
  deepStrictEqual(loopne.opcode, [0xe0]);

  for (const spec of [jecxz, loop, loope, loopne]) {
    strictEqual(spec.prefixes, undefined);
    deepStrictEqual(spec.operands, [{ kind: "rel", width: 8 }]);
    strictEqual(spec.syntax, `${spec.mnemonic} {0}`);
  }

  const loopTrace = buildSemanticTrace(semanticsOf(loop));

  deepStrictEqual(loopTrace.events, [
    "%0 = get ecx:32",
    "set ecx:32 <- %1",
    "%3 = get op0:32",
    "branch %2 ? %3 : nextEip"
  ]);
  strictEqual(loopTrace.defs[1], "sub(%0, 1)");
  strictEqual(loopTrace.defs[2], "cmp32.ne(%1, 0)");
});

test("breakpoint trap forms expose host-trap semantics", () => {
  const int3 = instruction("int3.near");
  const into = instruction("into.near");

  deepStrictEqual(int3.opcode, [0xcc]);
  strictEqual(int3.operands, undefined);
  strictEqual(int3.syntax, "int3");
  deepStrictEqual(buildSemanticTrace(semanticsOf(int3)).events, ["hostTrap 3"]);

  deepStrictEqual(into.opcode, [0xce]);
  strictEqual(into.operands, undefined);
  strictEqual(into.syntax, "into");
  deepStrictEqual(buildSemanticTrace(semanticsOf(into)).events, [
    "%0 = flag OF",
    "hostTrapIf %0 4"
  ]);
});

test("jcc forms are concrete specs with condition-specific semantics", () => {
  const short = instruction("jne.rel8");
  const word = instruction("jne.rel16");
  const near = instruction("jne.rel32");

  deepStrictEqual(short.opcode, [0x75]);
  deepStrictEqual(short.operands, [{ kind: "rel", width: 8 }]);
  strictEqual(short.syntax, "jne {0}");

  deepStrictEqual(word.opcode, [0x0f, 0x85]);
  deepStrictEqual(word.prefixes, { operandSize: "override" });
  deepStrictEqual(word.operands, [{ kind: "rel", width: 16 }]);
  strictEqual(word.syntax, "jne {0}");

  deepStrictEqual(near.opcode, [0x0f, 0x85]);
  deepStrictEqual(near.operands, [{ kind: "rel", width: 32 }]);
  strictEqual(near.syntax, "jne {0}");

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
  return spec.semantics;
}

function statusFlagKeys(write: Partial<Record<(typeof x86StatusFlags)[number], unknown>>): string[] {
  return x86StatusFlags.filter((flag) => flag in write);
}
