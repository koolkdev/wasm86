import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { x86StatusFlags } from "#core/flags/definitions.js";
import { aluSemantic, unaryAluSemantic } from "#core/semantics/alu.js";
import { bitScanSemantic, bitTestSemantic } from "#core/semantics/bits.js";
import {
  callSemantic,
  enterSemantic,
  jecxzSemantic,
  loopSemantic,
  retSemantic
} from "#core/semantics/control.js";
import {
  cmpxchg8bSemantic,
  cmpxchgSemantic,
  xaddSemantic
} from "#core/semantics/compare-exchange.js";
import { cmpSemantic } from "#core/semantics/cmp.js";
import { divImplicitSemantic, idivImplicitSemantic } from "#core/semantics/div.js";
import {
  cmcSemantic,
  lahfSemantic,
  sahfSemantic,
  writeFlagSemantic,
  xlatSemantic
} from "#core/semantics/flags.js";
import { leaSemantic } from "#core/semantics/lea.js";
import { int3Semantic, intoSemantic, intSemantic, nopSemantic } from "#core/semantics/misc.js";
import {
  cmovSemantic,
  movSregSemantic,
  movToSregSemantic
} from "#core/semantics/mov.js";
import {
  imulImplicitSemantic,
  imulRegRmImmSemantic,
  imulRegRmSemantic,
  mulImplicitSemantic
} from "#core/semantics/mul.js";
import { doubleShiftSemantic, shiftSemantic } from "#core/semantics/shift.js";
import {
  accumulatorSignExtendSemantic,
  highAccumulatorSignExtendSemantic
} from "#core/semantics/sign-extend.js";
import { rotateSemantic } from "#core/semantics/rotate.js";
import {
  leaveSemantic,
  popadSemantic,
  popaSemantic,
  popSemantic,
  pushadSemantic,
  pushaSemantic,
  pushSemantic
} from "#core/semantics/stack.js";
import {
  cmpsSemantic,
  lodsSemantic,
  movsSemantic,
  repLodsSemantic,
  repMovsSemantic,
  repneScasSemantic,
  scasSemantic,
  stosSemantic
} from "#core/semantics/strings.js";
import { testSemantic } from "#core/semantics/test.js";
import { xchgSemantic } from "#core/semantics/xchg.js";
import type { ValueInput } from "#core/semantics/refs.js";

import {
  buildSemanticTrace,
  flagCell,
  operands,
  regOperands,
  segmentOperand,
  type SemanticTrace
} from "./test-semantics-trace.js";

test("MOV to CS raises #UD before loading the selector source", () => {
  const trace = buildSemanticTrace(movToSregSemantic(), [segmentOperand("cs"), { storage: "reg" }]);

  deepStrictEqual(trace.events, [
    "if 1",
    "cpuException UD",
    "ifEnd",
    "%0 = get op1:16",
    "set op0:16 <- %0",
    "next"
  ]);
});

test("MOV from a segment register keeps its memory transfer at 16 bits", () => {
  const register = buildSemanticTrace(movSregSemantic(32), regOperands(2));
  const memory = buildSemanticTrace(movSregSemantic(32), operands("mem", "reg"));

  deepStrictEqual(register.events, [
    "%0 = get op1:16",
    "set op0:32 <- %0",
    "next"
  ]);
  deepStrictEqual(memory.events, [
    "%0 = get op1:16",
    "resolve r0 = operand(op0):2",
    "if %2",
    "cpuException PF r0.write",
    "ifEnd",
    "write r0.write+0:16 <- %0",
    "next"
  ]);
});

test("cmov semantic reads the source unconditionally and selects the destination value", () => {
  const trace = buildSemanticTrace(cmovSemantic("E"), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op1:32",
    "%1 = condition E",
    "%2 = get op0:32",
    "set op0:32 <- %3",
    "next"
  ]);
  strictEqual(trace.defs[3], "select(%1, %0, %2)");
});

test("nop semantic falls through without side effects", () => {
  const trace = buildSemanticTrace(nopSemantic());

  deepStrictEqual(trace.events, ["next"]);
});

test("int semantic reads the vector and exits to a host trap", () => {
  const trace = buildSemanticTrace(intSemantic(), regOperands(1));

  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "hostTrap %0"
  ]);
});

test("int3 and into semantics expose host trap exits", () => {
  const int3 = buildSemanticTrace(int3Semantic());
  const into = buildSemanticTrace(intoSemantic());

  deepStrictEqual(int3.events, ["hostTrap 3"]);
  deepStrictEqual(into.events, [
    "%0 = flag OF",
    "if %0",
    "hostTrap 4",
    "ifEnd",
    "next"
  ]);
});

test("flag scalar semantics write only their target flag", () => {
  for (const [name, template, expected] of [
    ["clc", writeFlagSemantic("CF", 0), "flag CF <- 0"],
    ["stc", writeFlagSemantic("CF", 1), "flag CF <- 1"],
    ["cld", writeFlagSemantic("DF", 0), "flag DF <- 0"],
    ["std", writeFlagSemantic("DF", 1), "flag DF <- 1"]
  ] as const) {
    const trace = buildSemanticTrace(template);

    deepStrictEqual(trace.events, [expected, "next"], name);
  }
});

test("cmc resolves and complements CF without touching other flags directly", () => {
  const trace = buildSemanticTrace(cmcSemantic());

  deepStrictEqual(trace.events, [
    "%0 = flag CF",
    "flag CF <- %1",
    "next"
  ]);
  strictEqual(trace.defs[1], "xor(%0, 1)");
});

test("lahf builds AH from the five low status flags and the reserved bit", () => {
  const trace = buildSemanticTrace(lahfSemantic());

  for (const flag of ["CF", "PF", "AF", "ZF", "SF"] as const) {
    strictEqual(trace.events.some((event) => event.endsWith(`flag ${flag}`)), true, flag);
  }

  strictEqual(trace.events.some((event) => event.endsWith("flag OF")), false);
  strictEqual(trace.events.some((event) => event.startsWith("set ah:8 <- ")), true);
  deepStrictEqual(trace.events.at(-1), "next");
});

test("sahf writes the five low status flags from AH and leaves OF untouched", () => {
  const trace = buildSemanticTrace(sahfSemantic());

  strictEqual(trace.events[0], "%0 = get ah:8");
  deepStrictEqual(directFlagWrites(trace), ["CF", "PF", "AF", "ZF", "SF"]);
  strictEqual(directFlagWrites(trace).includes("OF"), false);
  deepStrictEqual(trace.events.at(-1), "next");
});

test("xlat derives an operand-relative READ ref from AL", () => {
  const trace = buildSemanticTrace(xlatSemantic(), operands("mem"));

  deepStrictEqual(trace.events, [
    "%0 = get al:8",
    "resolve r0 = offset(operand(op0), %0):1",
    "if %2",
    "cpuException PF r0.read",
    "ifEnd",
    "%3 = read r0.read+0:8",
    "set al:8 <- %3",
    "next"
  ]);
  strictEqual(trace.defs[1], "valid(r0.read)");
  strictEqual(trace.defs[2], "not(%1)");
});

test("movs reads the source, writes the fixed destination, then steps both pointers", () => {
  const trace = buildSemanticTrace(movsSemantic(32), operands("mem", "mem"));

  deepStrictEqual(trace.events, [
    "%0 = flag DF",
    "resolve r0 = operand(op0):4",
    "if %3",
    "cpuException PF r0.read",
    "ifEnd",
    "%4 = read r0.read+0:32",
    "resolve r1 = operand(op1):4",
    "if %6",
    "cpuException PF r1.write",
    "ifEnd",
    "write r1.write+0:32 <- %4",
    "%7 = get esi:32",
    "set esi:32 <- %8",
    "%9 = get edi:32",
    "set edi:32 <- %10",
    "next"
  ]);
  strictEqual(trace.defs[1], "select(%0, 4294967292, 4)");
  strictEqual(trace.defs[8], "add(%7, %1)");
  strictEqual(trace.defs[10], "add(%9, %1)");
});

test("cmps compares source minus destination before stepping both pointers", () => {
  const trace = buildSemanticTrace(cmpsSemantic(16), operands("mem", "mem"));

  deepStrictEqual(trace.events.slice(0, 11), [
    "%0 = flag DF",
    "resolve r0 = operand(op0):2",
    "if %3",
    "cpuException PF r0.read",
    "ifEnd",
    "%4 = read r0.read+0:16",
    "resolve r1 = operand(op1):2",
    "if %7",
    "cpuException PF r1.read",
    "ifEnd",
    "%8 = read r1.read+0:16"
  ]);
  ok(trace.events.includes("flagSource sub:16 left=%5 right=%9 result=%11"));
  ok(trace.events.includes("set esi:32 <- %13"));
  ok(trace.events.includes("set edi:32 <- %15"));
});

test("stos, lods, and scas use accumulator widths and one pointer step", () => {
  const stos = buildSemanticTrace(stosSemantic(8), operands("mem"));
  const lods = buildSemanticTrace(lodsSemantic(16), operands("mem"));
  const scas = buildSemanticTrace(scasSemantic(32), operands("mem"));

  deepStrictEqual(stos.events.slice(0, 6), [
    "%0 = get al:8",
    "%1 = flag DF",
    "resolve r0 = operand(op0):1",
    "if %4",
    "cpuException PF r0.write",
    "ifEnd"
  ]);
  strictEqual(stos.events[6], "write r0.write+0:8 <- %0");
  strictEqual(stos.events[7], "%5 = get edi:32");
  strictEqual(stos.events.some((event) => event.startsWith("set esi:32")), false);

  deepStrictEqual(lods.events.slice(0, 8), [
    "%0 = flag DF",
    "resolve r0 = operand(op0):2",
    "if %3",
    "cpuException PF r0.read",
    "ifEnd",
    "%4 = read r0.read+0:16",
    "set ax:16 <- %4",
    "%5 = get esi:32"
  ]);
  strictEqual(lods.events[8], "set esi:32 <- %6");
  strictEqual(lods.events.some((event) => event.startsWith("set edi:32")), false);

  deepStrictEqual(scas.events.slice(0, 8), [
    "%0 = flag DF",
    "%2 = get eax:32",
    "resolve r0 = operand(op0):4",
    "if %5",
    "cpuException PF r0.read",
    "ifEnd",
    "%6 = read r0.read+0:32",
    "flagSource sub:32 left=%3 right=%7 result=%9"
  ]);
  ok(scas.events.includes("set edi:32 <- %11"));
});

test("rep movs skips a zero count and fuses the unit into a state-reg loop", () => {
  const trace = buildSemanticTrace(repMovsSemantic(32), operands("mem", "mem"));

  deepStrictEqual(trace.events.slice(0, 4), [
    "%0 = get ecx:32",
    "if %1",
    "loop",
    "%2 = flag DF"
  ]);
  ok(trace.events.includes("set ecx:32 <- %14"));
  deepStrictEqual(trace.events.slice(-6), [
    "loopContinue %15",
    "loopEnd",
    "ifEnd",
    "%16 = get ecx:32",
    "addInstructionCount %18",
    "next"
  ]);
  strictEqual(trace.defs[1], "cmp32.ne(%0, 0)");
  // The back-edge count is the body's own ecx read, not the pre-loop one.
  strictEqual(trace.defs[14], "sub(%13, 1)");
  strictEqual(trace.defs[15], "cmp32.ne(%14, 0)");
  // The root settles extra units as (entryEcx - exitEcx) - enter.
  strictEqual(trace.defs[17], "sub(%0, %16)");
  strictEqual(trace.defs[18], "sub(%17, %1)");
});

test("rep lods carries its accumulator as loop state", () => {
  const trace = buildSemanticTrace(repLodsSemantic(8), operands("mem"));

  strictEqual(trace.events[1], "if %1");
  strictEqual(trace.events[2], "loop");
});

test("repne scas combines remaining ECX with ZF after the compare unit", () => {
  const trace = buildSemanticTrace(repneScasSemantic(8), operands("mem"));

  strictEqual(trace.events[1], "if %1");
  strictEqual(trace.events[2], "loop");
  ok(trace.events.includes("%17 = condition NE"));
  deepStrictEqual(trace.events.slice(-6), [
    "loopContinue %18",
    "loopEnd",
    "ifEnd",
    "%19 = get ecx:32",
    "addInstructionCount %21",
    "next"
  ]);
  strictEqual(trace.defs[18], "and(%16, %17)");
});

test("lea semantic computes an address without getting the operand value", () => {
  const trace = buildSemanticTrace(leaSemantic(), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = addr op1",
    "set op0:32 <- %0",
    "next"
  ]);
  strictEqual(trace.events.some((event) => event.includes("get op1")), false);
});

test("binary ALU memory RMWs validate one WRITE view and reuse it for read and write", () => {
  for (const op of ["add", "adc", "sbb"] as const) {
    const trace = buildSemanticTrace(aluSemantic(op, 32), operands("mem", "reg"));

    deepStrictEqual(trace.events.slice(0, 6), [
      "resolve r0 = operand(op0):4",
      "if %1",
      "cpuException PF r0.write",
      "ifEnd",
      "%2 = read r0.write+0:32",
      "%4 = get op1:32"
    ], op);
    strictEqual(memoryResolveEvents(trace).length, 1, op);
    strictEqual(trace.events.some((event) => event.includes("r0.read")), false, op);
    strictEqual(trace.events.some((event) => event.startsWith("write r0.write+0:32 <- ")), true, op);
  }
});

test("adc and sbb read old CF after operands and before replacing arithmetic flags", () => {
  for (const op of ["adc", "sbb"] as const) {
    const trace = buildSemanticTrace(aluSemantic(op, 32), regOperands(2));
    const flagReadIndex = trace.events.findIndex((event) => event.endsWith(" = flag CF"));
    const firstFlagWrite = trace.events.findIndex((event) => event.startsWith("flag "));
    const setEvent = trace.events.find((event) => event.startsWith("set op0:32 <- "));

    ok(trace.events[0]?.endsWith(" = get op0:32"), op);
    ok(trace.events[1]?.endsWith(" = get op1:32"), op);
    strictEqual(flagReadIndex, 2, op);
    strictEqual(firstFlagWrite, 3, op);
    ok(setEvent !== undefined, op);

    const oldCfValue = trace.events[flagReadIndex]!.split(" = ")[0]!;
    const resultValue = setEvent.split(" <- ")[1]!;
    const write = trace.flagWrites[0]!;
    const resultDerivedFlags = op === "adc"
      ? x86StatusFlags
      : x86StatusFlags.filter((flag) => flag !== "CF");

    deepStrictEqual(statusFlagKeys(write).sort(), [...x86StatusFlags].sort(), op);
    for (const flag of resultDerivedFlags) {
      strictEqual(referencesValue(trace, trace.def(flagCell(write, flag)), resultValue), true, `${op} ${flag}`);
    }
    strictEqual(referencesValue(trace, trace.def(flagCell(write, "CF")), oldCfValue), true, `${op} CF input`);
  }
});

test("shift semantics cover operations, widths, and count sources", () => {
  for (const op of ["shl", "shr", "sar"] as const) {
    for (const width of [8, 16, 32] as const) {
      for (const countSource of ["one", "cl", "imm8"] as const) {
        const trace = buildSemanticTrace(
          shiftSemantic(op, width, countSource),
          countSource === "imm8" ? operands("reg", "imm") : regOperands(1)
        );

        strictEqual(trace.events.some((event) => event.startsWith(`set op0:${width} <- `)), true, `${op} ${width} ${countSource}`);
        strictEqual(trace.flagWrites.length, 1, `${op} ${width} ${countSource}`);
        deepStrictEqual(statusFlagKeys(trace.flagWrites[0]!).sort(), [...x86StatusFlags].sort(), `${op} ${width} ${countSource}`);
      }
    }
  }
});

test("shift memory RMWs validate one WRITE view and read operands in ALU order", () => {
  const immTrace = buildSemanticTrace(shiftSemantic("shl", 32, "imm8"), operands("mem", "imm"));

  deepStrictEqual(immTrace.events.slice(0, 6), [
    "resolve r0 = operand(op0):4",
    "if %1",
    "cpuException PF r0.write",
    "ifEnd",
    "%2 = read r0.write+0:32",
    "%4 = get op1:8"
  ]);
  strictEqual(memoryResolveEvents(immTrace).length, 1);
  ok(immTrace.events.includes("write r0.write+0:32 <- %9"));

  const clTrace = buildSemanticTrace(shiftSemantic("shr", 16, "cl"), operands("mem"));

  deepStrictEqual(clTrace.events.slice(0, 6), [
    "resolve r0 = operand(op0):2",
    "if %1",
    "cpuException PF r0.write",
    "ifEnd",
    "%2 = read r0.write+0:16",
    "%4 = get cl:8"
  ]);
  strictEqual(memoryResolveEvents(clTrace).length, 1);
  ok(clTrace.events.includes("write r0.write+0:16 <- %9"));
});

test("double-shift semantics read destination, source, and count in operand order", () => {
  const immTrace = buildSemanticTrace(
    doubleShiftSemantic("shld", 32, "imm8"),
    operands("mem", "reg", "imm")
  );

  deepStrictEqual(immTrace.events.slice(0, 7), [
    "resolve r0 = operand(op0):4",
    "if %1",
    "cpuException PF r0.write",
    "ifEnd",
    "%2 = read r0.write+0:32",
    "%4 = get op1:32",
    "%6 = get op2:8"
  ]);
  strictEqual(memoryResolveEvents(immTrace).length, 1);
  ok(immTrace.events.some((event) => event.startsWith("write r0.write+0:32 <- ")));
  deepStrictEqual(statusFlagKeys(immTrace.flagWrites[0]!).sort(), [...x86StatusFlags].sort());

  const clTrace = buildSemanticTrace(doubleShiftSemantic("shrd", 16, "cl"), regOperands(2));

  deepStrictEqual(clTrace.events.slice(0, 3), [
    "%0 = get op0:16",
    "%2 = get op1:16",
    "%4 = get cl:8"
  ]);
  ok(clTrace.events.some((event) => event.startsWith("set op0:16 <- ")));
  deepStrictEqual(statusFlagKeys(clTrace.flagWrites[0]!).sort(), [...x86StatusFlags].sort());
});

test("double-shift semantics combine the destination and source in the shift direction", () => {
  const shld = buildSemanticTrace(doubleShiftSemantic("shld", 32, "imm8"), regOperands(3));
  const shrd = buildSemanticTrace(doubleShiftSemantic("shrd", 32, "imm8"), regOperands(3));

  strictEqual(shld.defs.some((definition) => definition.startsWith("shl(")), true);
  strictEqual(shld.defs.some((definition) => definition.startsWith("shr_u(")), true);
  ok(shld.defs.some((definition) => /^or\(%\d+, %\d+\)$/.test(definition)));

  strictEqual(shrd.defs.some((definition) => definition.startsWith("shr_u(")), true);
  strictEqual(shrd.defs.some((definition) => definition.startsWith("shl(")), true);
  ok(shrd.defs.some((definition) => /^or\(%\d+, %\d+\)$/.test(definition)));
});

test("runtime shift counts are masked before result and flag use", () => {
  const trace = buildSemanticTrace(shiftSemantic("shl", 8, "cl"), regOperands(1));

  strictEqual(trace.defs[1], "truncate8(%0)");
  strictEqual(trace.defs[3], "and(%2, 31)");
  strictEqual(trace.defs[4], "shl(%1, %3)");
  strictEqual(trace.defs[5], "truncate8(%4)");
  strictEqual(trace.defs[7], "select(%6, %5, %1)");
  strictEqual(trace.defs[14], "cmp32.eq(%3, 1)");
  strictEqual(trace.defs[15], "sub(8, %3)");
  strictEqual(trace.defs[21], "cmp32.le_u(%3, 8)");
  strictEqual(trace.events[14], "set op0:8 <- %7");
});

test("runtime shift count zero selects the original destination and old flags", () => {
  const trace = buildSemanticTrace(shiftSemantic("shr", 16, "imm8"), operands("reg", "imm"));
  const write = trace.flagWrites[0]!;

  strictEqual(trace.defs[7], "select(%6, %5, %1)");
  strictEqual(trace.def(flagCell(write, "CF")), "select(%21, %17, %8)");
  strictEqual(trace.def(flagCell(write, "PF")), "select(%19, %27, %9)");
  strictEqual(trace.def(flagCell(write, "AF")), "select(%19, 0, %10)");
  strictEqual(trace.def(flagCell(write, "ZF")), "select(%19, %22, %11)");
  strictEqual(trace.def(flagCell(write, "SF")), "select(%19, %23, %12)");
  strictEqual(trace.def(flagCell(write, "OF")), "select(%19, %28, %13)");
});

test("runtime shift counts greater than one write OF as zero", () => {
  const trace = buildSemanticTrace(shiftSemantic("shl", 32, "cl"), regOperands(1));
  const write = trace.flagWrites[0]!;

  strictEqual(trace.defs[14], "cmp32.eq(%3, 1)");
  strictEqual(trace.defs[29], "select(%14, %19, 0)");
  strictEqual(trace.def(flagCell(write, "OF")), "select(%20, %29, %13)");
});

test("bit-test register forms write only CF and mask the bit offset", () => {
  const trace = buildSemanticTrace(bitTestSemantic("bt", 32, "reg"), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op1:32:signed",
    "%2 = get op0:32",
    "flag CF <- %5",
    "next"
  ]);
  strictEqual(trace.defs[1], "and(%0, 31)");
  strictEqual(trace.defs[3], "truncate32(%2)");
  strictEqual(trace.defs[4], "shr_u(%3, %1)");
  strictEqual(trace.defs[5], "and(%4, 1)");
  strictEqual(trace.defs.some((definition) => definition.startsWith("shr_s(")), false);
  strictEqual(trace.defs.some((definition) => definition.startsWith("shl(")), false);
  deepStrictEqual(directFlagWrites(trace), ["CF"]);
  strictEqual(trace.events.some((event) => event.startsWith("set ")), false);
});

test("bit-string memory forms offset the logical ref and select access intent", () => {
  const trace = buildSemanticTrace(bitTestSemantic("bts", 32, "reg"), operands("mem", "reg"));

  deepStrictEqual(trace.events, [
    "%0 = get op1:32:signed",
    "resolve r0 = offset(operand(op0), %3):4",
    "if %5",
    "cpuException PF r0.write",
    "ifEnd",
    "%6 = read r0.write+0:32",
    "flag CF <- %9",
    "write r0.write+0:32 <- %13",
    "next"
  ]);
  strictEqual(trace.defs[1], "and(%0, 31)");
  strictEqual(trace.defs[2], "shr_s(%0, 5)");
  strictEqual(trace.defs[3], "shl(%2, 2)");
  strictEqual(memoryResolveEvents(trace).length, 1);

  const readOnly = buildSemanticTrace(bitTestSemantic("bt", 32, "reg"), operands("mem", "reg"));

  strictEqual(readOnly.events[1], "resolve r0 = offset(operand(op0), %3):4");
  ok(readOnly.events.includes("cpuException PF r0.read"));
  ok(readOnly.events.includes("%6 = read r0.read+0:32"));
  strictEqual(readOnly.events.some((event) => event.startsWith("write ")), false);
});

test("bit-scan semantics preserve destination on zero source and write observed undefined flags", () => {
  const bsf = buildSemanticTrace(bitScanSemantic("bsf", 32), regOperands(2));
  const bsr = buildSemanticTrace(bitScanSemantic("bsr", 32), regOperands(2));

  deepStrictEqual(bsf.events.slice(0, 2), [
    "%0 = get op1:32",
    "%2 = get op0:32"
  ]);
  ok(bsf.defs.includes("ctz(%1)"));
  ok(bsf.defs.includes("select(%3, 0, %4)"));
  ok(bsf.defs.includes("select(%3, %2, %4)"));
  deepStrictEqual(directFlagWrites(bsf), ["CF", "PF", "AF", "ZF", "SF", "OF"]);
  ok(bsf.events.includes("flag CF <- 0"));
  ok(bsf.events.includes("flag AF <- 0"));
  ok(bsf.events.includes("flag SF <- 0"));
  ok(bsf.events.includes("flag OF <- 0"));
  ok(bsf.events.includes("flag ZF <- %3"));
  ok(bsf.events.includes("set op0:32 <- %6"));

  ok(bsr.defs.some((def) => def.startsWith("clz(%1)")));
  ok(bsr.defs.some((def) => def.startsWith("sub(31, ")));
});

test("cmpxchg writes the destination only on equality", () => {
  const trace = buildSemanticTrace(cmpxchgSemantic(32), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "%2 = get op1:32",
    "%4 = get eax:32",
    "flagSource sub:32 left=%5 right=%1 result=%7",
    "if %8",
    "set op0:32 <- %3",
    "else",
    "set eax:32 <- %1",
    "ifEnd",
    "next"
  ]);
  strictEqual(trace.defs[1], "truncate32(%0)");
  strictEqual(trace.defs[3], "truncate32(%2)");
  strictEqual(trace.defs[5], "truncate32(%4)");
  strictEqual(trace.defs[6], "sub(%5, %1)");
  strictEqual(trace.defs[7], "truncate32(%6)");
  strictEqual(trace.defs[8], "cmp32.eq(%5, %1)");
});

test("cmpxchg memory validates one WRITE view and stores only on equality", () => {
  const trace = buildSemanticTrace(cmpxchgSemantic(32), operands("mem", "reg"));

  deepStrictEqual(trace.events, [
    "resolve r0 = operand(op0):4",
    "if %1",
    "cpuException PF r0.write",
    "ifEnd",
    "%2 = read r0.write+0:32",
    "%4 = get op1:32",
    "%6 = get eax:32",
    "flagSource sub:32 left=%7 right=%3 result=%9",
    "if %10",
    "write r0.write+0:32 <- %5",
    "else",
    "set eax:32 <- %3",
    "ifEnd",
    "next"
  ]);
  strictEqual(memoryResolveEvents(trace).length, 1);
  strictEqual(trace.defs[10], "cmp32.eq(%7, %3)");
  strictEqual(trace.events.filter((event) => event.startsWith("write ")).length, 1);
});

test("xadd writes the source before the destination for same-register doubling", () => {
  const trace = buildSemanticTrace(xaddSemantic(32), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "%2 = get op1:32",
    "flagSource add:32 left=%1 right=%3 result=%5",
    "set op1:32 <- %1",
    "set op0:32 <- %5",
    "next"
  ]);
  strictEqual(trace.defs[1], "truncate32(%0)");
  strictEqual(trace.defs[3], "truncate32(%2)");
  strictEqual(trace.defs[4], "add(%1, %3)");
  strictEqual(trace.defs[5], "truncate32(%4)");
});

test("xadd memory reuses one WRITE view for its read and unconditional store", () => {
  const trace = buildSemanticTrace(xaddSemantic(32), operands("mem", "reg"));

  deepStrictEqual(trace.events.slice(0, 7), [
    "resolve r0 = operand(op0):4",
    "if %1",
    "cpuException PF r0.write",
    "ifEnd",
    "%2 = read r0.write+0:32",
    "%4 = get op1:32",
    "flagSource add:32 left=%3 right=%5 result=%7"
  ]);
  strictEqual(memoryResolveEvents(trace).length, 1);
  deepStrictEqual(trace.events.slice(7), [
    "set op1:32 <- %3",
    "write r0.write+0:32 <- %7",
    "next"
  ]);
});

test("cmpxchg8b reuses one qword WRITE view and conditionally stores both halves", () => {
  const trace = buildSemanticTrace(cmpxchg8bSemantic(), operands("mem"));

  deepStrictEqual(trace.events, [
    "resolve r0 = operand(op0):8",
    "if %1",
    "cpuException PF r0.write",
    "ifEnd",
    "%2 = read r0.write+0:32",
    "%3 = read r0.write+4:32",
    "%4 = get eax:32",
    "%5 = get edx:32",
    "flag ZF <- %8",
    "if %8",
    "%9 = get ebx:32",
    "write r0.write+0:32 <- %9",
    "%10 = get ecx:32",
    "write r0.write+4:32 <- %10",
    "ifEnd",
    "set eax:32 <- %11",
    "set edx:32 <- %12",
    "next"
  ]);
  strictEqual(trace.defs[6], "cmp32.eq(%4, %2)");
  strictEqual(trace.defs[7], "cmp32.eq(%5, %3)");
  strictEqual(trace.defs[8], "and(%6, %7)");
  strictEqual(trace.defs[11], "select(%8, %4, %2)");
  strictEqual(trace.defs[12], "select(%8, %5, %3)");
  strictEqual(memoryResolveEvents(trace).length, 1);
  strictEqual(trace.events.filter((event) => event.startsWith("write ")).length, 2);
  deepStrictEqual(directFlagWrites(trace), ["ZF"]);
});

test("imul reg-rm semantics use a signed full product and explicit status flags", () => {
  const trace = buildSemanticTrace(imulRegRmSemantic(32), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op1:32",
    "%1 = get op0:32",
    "flag CF <- %10",
    "flag PF <- 1",
    "flag AF <- 0",
    "flag ZF <- 0",
    "flag SF <- 0",
    "flag OF <- %10",
    "set op0:32 <- %5",
    "next"
  ]);
  strictEqual(trace.defs[2], "extend64.s32(%1)");
  strictEqual(trace.defs[3], "extend64.s32(%0)");
  strictEqual(trace.defs[4], "mul64(%2, %3)");
  strictEqual(trace.defs[5], "truncate64.32(%4)");
  strictEqual(trace.defs[8], "truncate64.32(%7)");
  strictEqual(trace.defs[9], "extend64.s32(%5)");
  strictEqual(trace.defs[10], "cmp64.ne(%4, %9)");
  deepStrictEqual(statusFlagKeys(trace.flagWrites[0]!).sort(), [...x86StatusFlags].sort());
});

test("imul reg-rm-imm semantics read the r/m source and immediate before writing the destination", () => {
  const trace = buildSemanticTrace(imulRegRmImmSemantic(16), operands("reg", "reg", "imm"));

  deepStrictEqual(trace.events.slice(0, 2), [
    "%0 = get op1:16",
    "%1 = get op2:16"
  ]);
  ok(trace.events.includes("set op0:16 <- %5"));
  strictEqual(trace.defs[2], "extend.s16(%0)");
  strictEqual(trace.defs[3], "extend.s16(%1)");
  strictEqual(trace.defs[4], "mul(%2, %3)");
  strictEqual(trace.defs[9], "cmp32.ne(%4, %8)");
});

test("imul memory source validates a READ view before destination state", () => {
  const trace = buildSemanticTrace(imulRegRmSemantic(32), operands("reg", "mem"));

  deepStrictEqual(trace.events.slice(0, 6), [
    "resolve r0 = operand(op1):4",
    "if %1",
    "cpuException PF r0.read",
    "ifEnd",
    "%2 = read r0.read+0:32",
    "%3 = get op0:32"
  ]);
});

test("implicit mul byte writes AX and deterministic multiply flags", () => {
  const trace = buildSemanticTrace(mulImplicitSemantic(8), regOperands(1));

  deepStrictEqual(trace.events.slice(0, 2), [
    "%0 = get op0:8",
    "%1 = get al:8"
  ]);
  ok(trace.defs.includes("extend.u8(%1)"));
  ok(trace.defs.includes("extend.u8(%0)"));
  ok(trace.defs.some((entry) => entry.startsWith("shr_u(")));
  strictEqual(trace.events.some((event) => event.startsWith("set ax:16 <- ")), true);

  const write = trace.flagWrites[0]!;

  strictEqual(trace.value(write.CF), trace.value(write.OF));
  strictEqual(trace.value(write.PF), "1");
  strictEqual(trace.value(write.AF), "0");
  strictEqual(trace.value(write.ZF), "0");
  strictEqual(trace.value(write.SF), "0");
});

test("implicit imul dword writes EDX:EAX from a signed full product", () => {
  const trace = buildSemanticTrace(imulImplicitSemantic(32), regOperands(1));

  deepStrictEqual(trace.events.slice(0, 2), [
    "%0 = get op0:32",
    "%1 = get eax:32"
  ]);
  ok(trace.defs.includes("extend64.s32(%1)"));
  ok(trace.defs.includes("extend64.s32(%0)"));
  ok(trace.defs.some((entry) => entry.startsWith("shr_u64(")));
  strictEqual(trace.events.some((event) => event.startsWith("set eax:32 <- ")), true);
  strictEqual(trace.events.some((event) => event.startsWith("set edx:32 <- ")), true);

  const write = trace.flagWrites[0]!;

  strictEqual(trace.value(write.CF), trace.value(write.OF));
  strictEqual(trace.value(write.PF), "1");
});

test("implicit multiply memory source validates READ before accumulator reads", () => {
  const trace = buildSemanticTrace(mulImplicitSemantic(16), operands("mem"));

  deepStrictEqual(trace.events.slice(0, 6), [
    "resolve r0 = operand(op0):2",
    "if %1",
    "cpuException PF r0.read",
    "ifEnd",
    "%2 = read r0.read+0:16",
    "%3 = get ax:16"
  ]);
});

test("implicit div validates and reads its source before divide-error checks and writes", () => {
  const trace = buildSemanticTrace(divImplicitSemantic(16), operands("mem"));
  const divideErrorIndex = trace.events.findIndex((event) => event === "cpuException DE");
  const firstSetIndex = trace.events.findIndex((event) => event.startsWith("set "));
  const firstFlagIndex = trace.events.findIndex((event) => event.startsWith("flag "));

  deepStrictEqual(trace.events.slice(0, 5), [
    "resolve r0 = operand(op0):2",
    "if %1",
    "cpuException PF r0.read",
    "ifEnd",
    "%2 = read r0.read+0:16"
  ]);
  ok(trace.events[5]?.endsWith(" = get ax:16"));
  ok(trace.events[6]?.endsWith(" = get dx:16"));
  ok(divideErrorIndex > 6);
  ok(firstSetIndex > divideErrorIndex);
  strictEqual(firstFlagIndex, -1);
  strictEqual(trace.flagWrites.length, 0);
  ok(trace.defs.some((entry) => entry.startsWith("div_u(")));
  ok(trace.defs.some((entry) => entry.startsWith("rem_u(")));
});

test("implicit idiv builds signed full-width values and guards before writes", () => {
  const trace = buildSemanticTrace(idivImplicitSemantic(32), regOperands(1));
  const exceptionIndexes = trace.events.flatMap((event, index) => (event.startsWith("cpuException ") ? [index] : []));
  const firstSetIndex = trace.events.findIndex((event) => event.startsWith("set "));

  deepStrictEqual(trace.events.slice(0, 3), [
    "%0 = get op0:32:signed",
    "%1 = get eax:32",
    "%2 = get edx:32"
  ]);
  strictEqual(exceptionIndexes.length, 2);
  ok(trace.defs.includes("extend64.s32(%2)"));
  ok(trace.defs.includes("extend64.u32(%1)"));
  ok(trace.defs.some((entry) => entry.startsWith("div_s64(")));
  ok(trace.defs.some((entry) => entry.startsWith("rem_s64(")));
  ok(trace.defs.some((entry) => entry.endsWith(", 9223372036854775808)") && entry.startsWith("cmp64.eq(")));
  ok(trace.defs.some((entry) => entry.startsWith("cmp64.ne(")));
  ok(firstSetIndex > exceptionIndexes[1]!);
});

test("implicit idiv word form guards undefined divisions before dividing and checks fit after", () => {
  const trace = buildSemanticTrace(idivImplicitSemantic(16), regOperands(1));
  const exceptionIndexes = trace.events.flatMap((event, index) => (event.startsWith("cpuException ") ? [index] : []));
  const firstSetIndex = trace.events.findIndex((event) => event.startsWith("set "));

  deepStrictEqual(trace.events.slice(0, 3), [
    "%0 = get op0:16:signed",
    "%1 = get ax:16",
    "%2 = get dx:16:signed"
  ]);
  strictEqual(exceptionIndexes.length, 2);
  ok(trace.defs.includes("cmp32.eq(%4, 2147483648)"));
  ok(trace.defs.includes("cmp32.eq(%0, 4294967295)"));
  ok(trace.defs.some((entry) => entry.startsWith("div_s(")));
  ok(trace.defs.some((entry) => entry.startsWith("rem_s(")));
  ok(trace.defs.some((entry) => entry.startsWith("cmp32.ge_u(")));
  ok(firstSetIndex > exceptionIndexes[1]!);
});

test("accumulator sign-extension forms are flagless", () => {
  const cbw = buildSemanticTrace(accumulatorSignExtendSemantic(8));
  const cwde = buildSemanticTrace(accumulatorSignExtendSemantic(16));

  deepStrictEqual(cbw.events, [
    "%0 = get al:8:signed",
    "set ax:16 <- %0",
    "next"
  ]);
  deepStrictEqual(cwde.events, [
    "%0 = get ax:16:signed",
    "set eax:32 <- %0",
    "next"
  ]);
  strictEqual(cbw.flagWrites.length, 0);
  strictEqual(cwde.flagWrites.length, 0);
});

test("high accumulator sign-extension forms are flagless", () => {
  const cwd = buildSemanticTrace(highAccumulatorSignExtendSemantic(16));
  const cdq = buildSemanticTrace(highAccumulatorSignExtendSemantic(32));

  deepStrictEqual(cwd.events, [
    "%0 = get ax:16:signed",
    "set dx:16 <- %2",
    "next"
  ]);
  strictEqual(cwd.defs[1], "shr_s(%0, 15)");
  strictEqual(cwd.defs[2], "truncate16(%1)");
  deepStrictEqual(cdq.events, [
    "%0 = get eax:32",
    "set edx:32 <- %1",
    "next"
  ]);
  strictEqual(cdq.defs[1], "shr_s(%0, 31)");
  strictEqual(cwd.flagWrites.length, 0);
  strictEqual(cdq.flagWrites.length, 0);
});

test("sar semantics use signed right shift after width sign extension", () => {
  const trace = buildSemanticTrace(shiftSemantic("sar", 16, "imm8"), operands("reg", "imm"));

  strictEqual(trace.defs[1], "truncate16(%0)");
  strictEqual(trace.defs[3], "and(%2, 31)");
  strictEqual(trace.defs[4], "extend.s16(%1)");
  strictEqual(trace.defs[5], "shr_s(%4, %3)");
});

test("plain rotate semantics write only carry and overflow flags", () => {
  const trace = buildSemanticTrace(rotateSemantic("rol", 8, "imm8"), operands("reg", "imm"));

  deepStrictEqual(directFlagWrites(trace).sort(), ["CF", "OF"]);
  strictEqual(trace.flagWrites.length, 0);
  strictEqual(directFlagWrites(trace).some((flag) => ["AF", "PF", "SF", "ZF"].includes(flag)), false);
});

test("plain dword rotate semantics use IR rotate operators", () => {
  const rol = buildSemanticTrace(rotateSemantic("rol", 32, "cl"), regOperands(1));
  const ror = buildSemanticTrace(rotateSemantic("ror", 32, "cl"), regOperands(1));
  const byte = buildSemanticTrace(rotateSemantic("rol", 8, "cl"), regOperands(1));

  strictEqual(rol.defs.some((definition) => definition.startsWith("rotl(")), true);
  strictEqual(ror.defs.some((definition) => definition.startsWith("rotr(")), true);
  strictEqual(byte.defs.some((definition) => definition.startsWith("rotl(")), false);
});

test("rotate count zero preserves destination, CF, and OF", () => {
  const trace = buildSemanticTrace(rotateSemantic("ror", 16, "cl"), regOperands(1));
  const set = trace.events.find((event) => event.startsWith("set op0:16 <- "));
  const oldCfRead = trace.events.find((event) => event.endsWith(" = flag CF"));
  const oldOfRead = trace.events.find((event) => event.endsWith(" = flag OF"));
  const cfWrite = trace.events.find((event) => event.startsWith("flag CF <- "));
  const ofWrite = trace.events.find((event) => event.startsWith("flag OF <- "));

  ok(set !== undefined);
  ok(oldCfRead !== undefined);
  ok(oldOfRead !== undefined);
  ok(cfWrite !== undefined);
  ok(ofWrite !== undefined);

  const result = set.split(" <- ")[1]!;
  const oldCf = oldCfRead.split(" = ")[0]!;
  const oldOf = oldOfRead.split(" = ")[0]!;
  const cfValue = cfWrite.split(" <- ")[1]!;
  const ofValue = ofWrite.split(" <- ")[1]!;

  strictEqual(referencesValue(trace, definitionForDisplay(trace, result), "%1"), true);
  strictEqual(referencesValue(trace, definitionForDisplay(trace, cfValue), oldCf), true);
  strictEqual(referencesValue(trace, definitionForDisplay(trace, ofValue), oldOf), true);
});

test("rotate counts greater than one write OF as zero", () => {
  const trace = buildSemanticTrace(rotateSemantic("rol", 32, "cl"), regOperands(1));

  strictEqual(trace.defs.some((definition) => /^select\(%\d+, %\d+, 0\)$/.test(definition)), true);
});

test("rotate-through-carry semantics read old CF before writing flags", () => {
  for (const op of ["rcl", "rcr"] as const) {
    const trace = buildSemanticTrace(rotateSemantic(op, 32, "cl"), regOperands(1));
    const cfReadIndex = trace.events.findIndex((event) => event.endsWith(" = flag CF"));
    const firstFlagWrite = trace.events.findIndex((event) => event.startsWith("flag "));

    strictEqual(cfReadIndex > -1, true, op);
    strictEqual(firstFlagWrite > cfReadIndex, true, op);
    deepStrictEqual(directFlagWrites(trace).sort(), ["CF", "OF"], op);
  }
});

test("xchg semantic reads both operands before writing either operand", () => {
  const trace = buildSemanticTrace(xchgSemantic(), regOperands(2));
  const firstSet = trace.events.findIndex((event) => event.startsWith("set "));

  ok(trace.events.indexOf("%0 = get op0:32") < firstSet);
  ok(trace.events.indexOf("%1 = get op1:32") < firstSet);
  deepStrictEqual(trace.events.slice(firstSet), [
    "set op1:32 <- %0",
    "set op0:32 <- %1",
    "next"
  ]);
});

test("cmp and test semantics emit flag sources without setting operands", () => {
  for (const [name, template, kind] of [
    ["cmp", cmpSemantic(), "sub"],
    ["test", testSemantic(), "logic"]
  ] as const) {
    const trace = buildSemanticTrace(template, regOperands(2));
    const sources = flagSourceEvents(trace);

    strictEqual(trace.events.some((event) => event.startsWith("set ")), false, name);
    strictEqual(trace.flagWrites.length, 0, name);
    strictEqual(sources.length, 1, name);
    strictEqual(sources[0]!.startsWith(`flagSource ${kind}:32`), true, name);
    deepStrictEqual(trace.events.at(-1), "next");
  }
});

test("pop semantic loads from old esp, increments esp, then writes the destination", () => {
  const trace = buildSemanticTrace(popSemantic(), operands("reg"));

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "resolve r0 = segment(ss, %0):4",
    "if %2",
    "cpuException PF r0.read",
    "ifEnd",
    "%3 = read r0.read+0:32",
    "set esp:32 <- %4",
    "set op0:32 <- %3",
    "next"
  ]);
  strictEqual(trace.defs[4], "add(%0, 4)");
});

test("push semantic accepts 16-bit stack cells with 32-bit esp", () => {
  const trace = buildSemanticTrace(pushSemantic(16), operands("reg"));

  deepStrictEqual(trace.events, [
    "%0 = get op0:16",
    "%1 = get esp:32",
    "resolve r0 = segment(ss, %2):2",
    "if %4",
    "cpuException PF r0.write",
    "ifEnd",
    "write r0.write+0:16 <- %0",
    "set esp:32 <- %2",
    "next"
  ]);
  strictEqual(trace.defs[2], "sub(%1, 2)");
});

test("pop semantic accepts 16-bit stack cells with 32-bit esp", () => {
  const trace = buildSemanticTrace(popSemantic(16), operands("reg"));

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "resolve r0 = segment(ss, %0):2",
    "if %2",
    "cpuException PF r0.read",
    "ifEnd",
    "%3 = read r0.read+0:16",
    "set esp:32 <- %4",
    "set op0:16 <- %3",
    "next"
  ]);
  strictEqual(trace.defs[4], "add(%0, 2)");
});

test("pop memory destination computes the destination address after esp update", () => {
  const trace = buildSemanticTrace(popSemantic(), operands("mem"));

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "resolve r0 = segment(ss, %0):4",
    "if %2",
    "cpuException PF r0.read",
    "ifEnd",
    "%3 = read r0.read+0:32",
    "set esp:32 <- %4",
    "resolve r1 = operand(op0):4",
    "if %6",
    "cpuException PF r1.write",
    "ifEnd",
    "write r1.write+0:32 <- %3",
    "next"
  ]);
});

test("pushad and pusha resolve one SS range and save original SP", () => {
  const pushad = buildSemanticTrace(pushadSemantic());
  const pusha = buildSemanticTrace(pushaSemantic());

  deepStrictEqual(memoryResolveEvents(pushad), [
    "resolve r0 = segment(ss, %1):32"
  ]);
  deepStrictEqual(memoryFaultEvents(pushad), ["cpuException PF r0.write"]);
  strictEqual(pushad.defs[1], "sub(%0, 32)");
  strictEqual(memoryResolveEvents(pushad).every((event) => pushad.events.indexOf(event) < firstMemoryWrite(pushad)), true);
  deepStrictEqual(memoryWriteEvents(pushad), [
    "write r0.write+28:32 <- %4",
    "write r0.write+24:32 <- %5",
    "write r0.write+20:32 <- %6",
    "write r0.write+16:32 <- %7",
    "write r0.write+12:32 <- %0",
    "write r0.write+8:32 <- %8",
    "write r0.write+4:32 <- %9",
    "write r0.write+0:32 <- %10"
  ]);

  deepStrictEqual(memoryResolveEvents(pusha), [
    "resolve r0 = segment(ss, %1):16"
  ]);
  deepStrictEqual(memoryFaultEvents(pusha), ["cpuException PF r0.write"]);
  strictEqual(pusha.defs[1], "sub(%0, 16)");
  strictEqual(memoryResolveEvents(pusha).every((event) => pusha.events.indexOf(event) < firstMemoryWrite(pusha)), true);
  strictEqual(pusha.defs[8], "truncate16(%0)");
  deepStrictEqual(memoryWriteEvents(pusha), [
    "write r0.write+14:16 <- %4",
    "write r0.write+12:16 <- %5",
    "write r0.write+10:16 <- %6",
    "write r0.write+8:16 <- %7",
    "write r0.write+6:16 <- %8",
    "write r0.write+4:16 <- %9",
    "write r0.write+2:16 <- %10",
    "write r0.write+0:16 <- %11"
  ]);
});

test("popad and popa resolve one full SS range without loading saved SP", () => {
  const popad = buildSemanticTrace(popadSemantic());
  const popa = buildSemanticTrace(popaSemantic());

  deepStrictEqual(memoryResolveEvents(popad), [
    "resolve r0 = segment(ss, %0):32"
  ]);
  deepStrictEqual(memoryFaultEvents(popad), ["cpuException PF r0.read"]);
  deepStrictEqual(memoryReadEvents(popad), [
    "%3 = read r0.read+0:32",
    "%4 = read r0.read+4:32",
    "%5 = read r0.read+8:32",
    "%6 = read r0.read+16:32",
    "%7 = read r0.read+20:32",
    "%8 = read r0.read+24:32",
    "%9 = read r0.read+28:32"
  ]);
  deepStrictEqual(popad.events.filter((event) => event.startsWith("set ")), [
    "set edi:32 <- %3",
    "set esi:32 <- %4",
    "set ebp:32 <- %5",
    "set ebx:32 <- %6",
    "set edx:32 <- %7",
    "set ecx:32 <- %8",
    "set eax:32 <- %9",
    "set esp:32 <- %10"
  ]);

  deepStrictEqual(memoryResolveEvents(popa), [
    "resolve r0 = segment(ss, %0):16"
  ]);
  deepStrictEqual(memoryFaultEvents(popa), ["cpuException PF r0.read"]);
  deepStrictEqual(memoryReadEvents(popa), [
    "%3 = read r0.read+0:16",
    "%4 = read r0.read+2:16",
    "%5 = read r0.read+4:16",
    "%6 = read r0.read+8:16",
    "%7 = read r0.read+10:16",
    "%8 = read r0.read+12:16",
    "%9 = read r0.read+14:16"
  ]);
  deepStrictEqual(popa.events.filter((event) => event.startsWith("set ")), [
    "set di:16 <- %3",
    "set si:16 <- %4",
    "set bp:16 <- %5",
    "set bx:16 <- %6",
    "set dx:16 <- %7",
    "set cx:16 <- %8",
    "set ax:16 <- %9",
    "set esp:32 <- %10"
  ]);
});

test("leave semantic reads saved frame before updating esp and ebp", () => {
  const trace = buildSemanticTrace(leaveSemantic());

  deepStrictEqual(trace.events, [
    "%0 = get ebp:32",
    "resolve r0 = segment(ss, %0):4",
    "if %2",
    "cpuException PF r0.read",
    "ifEnd",
    "%3 = read r0.read+0:32",
    "set esp:32 <- %4",
    "set ebp:32 <- %3",
    "next"
  ]);
  strictEqual(trace.defs[4], "add(%0, 4)");
});

test("call semantic resolves the target before pushing the return address", () => {
  const trace = buildSemanticTrace(callSemantic(), regOperands(1));

  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "%1 = get esp:32",
    "resolve r0 = segment(ss, %2):4",
    "if %4",
    "cpuException PF r0.write",
    "ifEnd",
    "write r0.write+0:32 <- nextEip",
    "set esp:32 <- %2",
    "jump %0"
  ]);
  strictEqual(trace.defs[2], "sub(%1, 4)");
});

test("ret semantic jumps to the popped value after incrementing esp", () => {
  const trace = buildSemanticTrace(retSemantic());

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "resolve r0 = segment(ss, %0):4",
    "if %2",
    "cpuException PF r0.read",
    "ifEnd",
    "%3 = read r0.read+0:32",
    "set esp:32 <- %4",
    "jump %3"
  ]);
  strictEqual(trace.defs[4], "add(%0, 4)");
});

test("enter uses one nonwrapping destination and display range", () => {
  const trace = buildSemanticTrace(enterSemantic(), operands("imm", "imm"));
  const destination = "resolve r0 = segment(ss, %12):%11";
  const source = "resolve r1 = segment(ss, %18):%17";
  const destinationIndex = trace.events.indexOf(destination);
  const levelBranchIndex = trace.events.indexOf("if %7", destinationIndex);
  const sourceIndex = trace.events.indexOf(source);
  const firstWriteIndex = trace.events.findIndex(
    (event, index) => index > sourceIndex && event.startsWith("write ")
  );
  const loopIndex = trace.events.indexOf("loop", sourceIndex);
  const loopEndIndex = trace.events.indexOf("loopEnd", loopIndex);

  strictEqual(destinationIndex > -1, true);
  deepStrictEqual(memoryResolveEvents(trace), [destination, source]);
  ok(trace.events.includes("cpuException PF r0.write"));
  strictEqual(levelBranchIndex > destinationIndex, true);
  strictEqual(
    trace.events.slice(destinationIndex + 1, levelBranchIndex).some(
      (event) => event.startsWith("resolve ")
    ),
    false
  );
  strictEqual(sourceIndex > levelBranchIndex, true);
  ok(trace.events.includes("cpuException PF r1.read"));
  strictEqual(firstWriteIndex > sourceIndex, true);
  strictEqual(
    trace.events.slice(sourceIndex + 1, firstWriteIndex).some(
      (event) => event.startsWith("resolve ")
    ),
    false
  );

  const loopEvents = trace.events.slice(loopIndex, loopEndIndex + 1);

  strictEqual(loopEvents.some((event) => event.startsWith("resolve ")), false);
  strictEqual(loopEvents.some((event) => /^%\d+ = read r1\.read\+%\d+:32$/.test(event)), true);
  strictEqual(loopEvents.some((event) => /^write r0\.write\+%\d+:32 <- %\d+$/.test(event)), true);
  strictEqual(trace.events.includes("else"), true);
});

test("jecxz and loop semantic branch conditions use ecx without writing flags", () => {
  const jecxz = buildSemanticTrace(jecxzSemantic());
  const loop = buildSemanticTrace(loopSemantic("none"));
  const loope = buildSemanticTrace(loopSemantic("E"));
  const loopne = buildSemanticTrace(loopSemantic("NE"));

  deepStrictEqual(jecxz.events, [
    "%0 = get ecx:32",
    "%2 = get op0:32",
    "if %1",
    "jump %2",
    "ifEnd",
    "next"
  ]);
  strictEqual(jecxz.defs[1], "cmp32.eq(%0, 0)");

  deepStrictEqual(loop.events, [
    "%0 = get ecx:32",
    "set ecx:32 <- %1",
    "%3 = get op0:32",
    "if %2",
    "jump %3",
    "ifEnd",
    "next"
  ]);
  strictEqual(loop.defs[1], "sub(%0, 1)");
  strictEqual(loop.defs[2], "cmp32.ne(%1, 0)");

  deepStrictEqual(loope.events, [
    "%0 = get ecx:32",
    "set ecx:32 <- %1",
    "%3 = condition E",
    "%5 = get op0:32",
    "if %4",
    "jump %5",
    "ifEnd",
    "next"
  ]);
  strictEqual(loope.defs[4], "and(%2, %3)");

  deepStrictEqual(loopne.events, [
    "%0 = get ecx:32",
    "set ecx:32 <- %1",
    "%3 = condition NE",
    "%5 = get op0:32",
    "if %4",
    "jump %5",
    "ifEnd",
    "next"
  ]);
  strictEqual(loopne.defs[4], "and(%2, %3)");
});

test("common flag-producing templates emit flag sources", () => {
  for (const [name, template, operandInfo, kind] of [
    ["add", aluSemantic("add", 32), regOperands(2), "add"],
    ["sub", aluSemantic("sub", 32), regOperands(2), "sub"],
    ["cmp", cmpSemantic(), regOperands(2), "sub"],
    ["test", testSemantic(), regOperands(2), "logic"],
    ["and", aluSemantic("and", 32), regOperands(2), "logic"],
    ["or", aluSemantic("or", 32), regOperands(2), "logic"],
    ["xor", aluSemantic("xor", 32), regOperands(2), "logic"]
  ] as const) {
    const trace = buildSemanticTrace(template, operandInfo);
    const sources = flagSourceEvents(trace);

    strictEqual(trace.flagWrites.length, 0, name);
    strictEqual(sources.length, 1, name);
    strictEqual(sources[0]!.startsWith(`flagSource ${kind}:32`), true, name);
  }
});

test("remaining concrete flag-writing templates write the six architectural flag values", () => {
  for (const [name, template, operandInfo] of [
    ["adc", aluSemantic("adc", 32), regOperands(2)],
    ["sbb", aluSemantic("sbb", 32), regOperands(2)],
    ["imul", imulRegRmSemantic(32), regOperands(2)],
    ["neg", unaryAluSemantic("neg", 32), regOperands(1)]
  ] as const) {
    const trace = buildSemanticTrace(template, operandInfo);

    strictEqual(trace.flagWrites.length, 1, name);
    deepStrictEqual(statusFlagKeys(trace.flagWrites[0]!).sort(), [...x86StatusFlags].sort(), name);
  }
});

test("inc writes partial flags and preserves CF by omitting it", () => {
  const trace = buildSemanticTrace(unaryAluSemantic("inc", 32), regOperands(1));

  strictEqual(trace.flagWrites.length, 0);
  deepStrictEqual(directFlagWrites(trace).sort(), ["AF", "OF", "PF", "SF", "ZF"].sort());
});

function referencesValue(trace: SemanticTrace, definition: string, value: string, seen = new Set<string>()): boolean {
  if (referencedValues(definition).includes(value)) {
    return true;
  }

  for (const display of referencedValues(definition)) {
    if (seen.has(display)) {
      continue;
    }
    seen.add(display);

    const index = Number(display.slice(1));
    const nested = trace.defs[index];

    if (nested !== undefined && referencesValue(trace, nested, value, seen)) {
      return true;
    }
  }

  return false;
}

function definitionForDisplay(trace: SemanticTrace, value: string): string {
  const index = Number(value.slice(1));
  const definition = trace.defs[index];

  ok(definition !== undefined, `expected definition for ${value}`);
  return definition;
}

function referencedValues(definition: string): string[] {
  return Array.from(definition.matchAll(/%\d+/g), (match) => match[0]);
}

function statusFlagKeys(write: Partial<Record<(typeof x86StatusFlags)[number], ValueInput>>): string[] {
  return x86StatusFlags.filter((flag) => flag in write);
}

function directFlagWrites(trace: SemanticTrace): string[] {
  return trace.events.flatMap((event) => {
    const match = /^flag ([A-Z]+) <- /.exec(event);

    return match === null ? [] : [match[1]!];
  });
}

function memoryResolveEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("resolve "));
}

function memoryReadEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => /^%\d+ = read /.test(event));
}

function memoryFaultEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => /^cpuException PF r\d+\.(?:read|write)$/.test(event));
}

function memoryWriteEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("write "));
}

function firstMemoryWrite(trace: SemanticTrace): number {
  const index = trace.events.findIndex((event) => event.startsWith("write "));

  return index === -1 ? trace.events.length : index;
}

function flagSourceEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("flagSource "));
}
