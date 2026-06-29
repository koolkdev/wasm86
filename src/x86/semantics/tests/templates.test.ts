import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { x86StatusFlags } from "#x86/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { callSemantic, retSemantic } from "#x86/semantics/control.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { leaSemantic } from "#x86/semantics/lea.js";
import { intSemantic, nopSemantic } from "#x86/semantics/misc.js";
import { cmovSemantic, movSemantic } from "#x86/semantics/mov.js";
import {
  imulImplicitSemantic,
  imulRegRmImmSemantic,
  imulRegRmSemantic,
  mulImplicitSemantic
} from "#x86/semantics/mul.js";
import { doubleShiftSemantic, shiftSemantic } from "#x86/semantics/shift.js";
import {
  accumulatorSignExtendSemantic,
  highAccumulatorSignExtendSemantic
} from "#x86/semantics/sign-extend.js";
import { rotateSemantic } from "#x86/semantics/rotate.js";
import {
  leaveSemantic,
  popadSemantic,
  popaSemantic,
  popSemantic,
  pushadSemantic,
  pushaSemantic,
  pushSemantic
} from "#x86/semantics/stack.js";
import { testSemantic } from "#x86/semantics/test.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";
import type { ValueInput } from "#x86/semantics/refs.js";

import {
  buildSemanticTrace,
  flagCell,
  operands,
  regOperands,
  type SemanticTrace
} from "./test-semantics-trace.js";

test("mov semantic gets the source, sets the destination, and falls through", () => {
  const trace = buildSemanticTrace(movSemantic(), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = get op1:32",
    "set op0:32 <- %0",
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

test("lea semantic computes an address without getting the operand value", () => {
  const trace = buildSemanticTrace(leaSemantic(), regOperands(2));

  deepStrictEqual(trace.events, [
    "%0 = addr op1",
    "set op0:32 <- %0",
    "next"
  ]);
  strictEqual(trace.events.some((event) => event.includes("get op1")), false);
});

test("mov semantic guards memory source and destination operands explicitly", () => {
  const trace = buildSemanticTrace(movSemantic(), operands("mem", "mem"));

  deepStrictEqual(trace.events, [
    "%0 = addr op1",
    "guard read %0:4",
    "%1 = get op1:32",
    "%2 = addr op0",
    "guard write %2:4",
    "set op0:32 <- %1",
    "next"
  ]);
});

test("binary ALU semantics guard memory read-modify-write before operand reads", () => {
  for (const op of ["add", "adc", "sbb"] as const) {
    const trace = buildSemanticTrace(aluSemantic(op, 32), operands("mem", "reg"));

    deepStrictEqual(trace.events.slice(0, 3), [
      "%0 = addr op0",
      "guard read %0:4",
      "guard write %0:4"
    ], op);
    ok(trace.events[3]?.endsWith(" = get op0:32"), op);
    ok(trace.events[4]?.endsWith(" = get op1:32"), op);
    strictEqual(trace.events.some((event) => event.startsWith("set op0:32 <- %")), true, op);
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

test("shift semantics guard and read operands in ALU order", () => {
  const immTrace = buildSemanticTrace(shiftSemantic("shl", 32, "imm8"), operands("mem", "imm"));

  deepStrictEqual(immTrace.events.slice(0, 3), [
    "%0 = addr op0",
    "guard read %0:4",
    "guard write %0:4"
  ]);
  ok(immTrace.events[3]?.endsWith(" = get op0:32"));
  ok(immTrace.events[4]?.endsWith(" = get op1:8"));

  const clTrace = buildSemanticTrace(shiftSemantic("shr", 16, "cl"), operands("mem"));

  deepStrictEqual(clTrace.events.slice(0, 3), [
    "%0 = addr op0",
    "guard read %0:2",
    "guard write %0:2"
  ]);
  ok(clTrace.events[3]?.endsWith(" = get op0:16"));
  ok(clTrace.events[4]?.endsWith(" = get cl:8"));
});

test("double-shift semantics read destination, source, and count in operand order", () => {
  const immTrace = buildSemanticTrace(
    doubleShiftSemantic("shld", 32, "imm8"),
    operands("mem", "reg", "imm")
  );

  deepStrictEqual(immTrace.events.slice(0, 6), [
    "%0 = addr op0",
    "guard read %0:4",
    "guard write %0:4",
    "%1 = get op0:32",
    "%3 = get op1:32",
    "%5 = get op2:8"
  ]);
  ok(immTrace.events.some((event) => event.startsWith("set op0:32 <- ")));
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

  strictEqual(trace.defs[1], "project8(%0)");
  strictEqual(trace.defs[3], "and(%2, 31)");
  strictEqual(trace.defs[4], "shl(%1, %3)");
  strictEqual(trace.defs[5], "project8(%4)");
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
  strictEqual(trace.defs[5], "project64.32(%4)");
  strictEqual(trace.defs[8], "project64.32(%7)");
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

test("imul memory source is guarded and read before destination state", () => {
  const trace = buildSemanticTrace(imulRegRmSemantic(32), operands("reg", "mem"));

  deepStrictEqual(trace.events.slice(0, 4), [
    "%0 = addr op1",
    "guard read %0:4",
    "%1 = get op1:32",
    "%2 = get op0:32"
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

test("implicit multiply memory source is guarded before accumulator reads", () => {
  const trace = buildSemanticTrace(mulImplicitSemantic(16), operands("mem"));

  deepStrictEqual(trace.events.slice(0, 4), [
    "%0 = addr op0",
    "guard read %0:2",
    "%1 = get op0:16",
    "%2 = get ax:16"
  ]);
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
  strictEqual(cwd.defs[2], "project16(%1)");
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

  strictEqual(trace.defs[1], "project16(%0)");
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
    "guard read %0:4",
    "%1 = get mem(%0):32",
    "set esp:32 <- %2",
    "set op0:32 <- %1",
    "next"
  ]);
  strictEqual(trace.defs[2], "add(%0, 4)");
});

test("push semantic accepts 16-bit stack cells with 32-bit esp", () => {
  const trace = buildSemanticTrace(pushSemantic(16), operands("reg"));

  deepStrictEqual(trace.events, [
    "%0 = get op0:16",
    "%1 = get esp:32",
    "guard write %2:2",
    "set mem(%2):16 <- %0",
    "set esp:32 <- %2",
    "next"
  ]);
  strictEqual(trace.defs[2], "sub(%1, 2)");
});

test("pop semantic accepts 16-bit stack cells with 32-bit esp", () => {
  const trace = buildSemanticTrace(popSemantic(16), operands("reg"));

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "guard read %0:2",
    "%1 = get mem(%0):16",
    "set esp:32 <- %2",
    "set op0:16 <- %1",
    "next"
  ]);
  strictEqual(trace.defs[2], "add(%0, 2)");
});

test("pop memory destination computes the destination address after esp update", () => {
  const trace = buildSemanticTrace(popSemantic(), operands("mem"));

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "guard read %0:4",
    "%1 = get mem(%0):32",
    "set esp:32 <- %2",
    "%3 = addr op0",
    "guard write %3:4",
    "set mem(%3):32 <- %1",
    "next"
  ]);
});

test("pushad and pusha preflight one range and save the original stack pointer", () => {
  const pushad = buildSemanticTrace(pushadSemantic());
  const pusha = buildSemanticTrace(pushaSemantic());

  deepStrictEqual(pushad.events.slice(0, 2), [
    "%0 = get esp:32",
    "guard write %1:32"
  ]);
  strictEqual(pushad.defs[1], "sub(%0, 32)");
  strictEqual(pushad.events.filter((event) => event.startsWith("guard ")).length, 1);
  strictEqual(pushad.events.some((event, index) => index > firstMemoryWrite(pushad) && event.startsWith("guard ")), false);
  ok(pushad.events.includes("set mem(%13):32 <- %0"));
  strictEqual(pushad.defs[13], "sub(%0, 20)");

  deepStrictEqual(pusha.events.slice(0, 2), [
    "%0 = get esp:32",
    "guard write %1:16"
  ]);
  strictEqual(pusha.defs[1], "sub(%0, 16)");
  strictEqual(pusha.events.filter((event) => event.startsWith("guard ")).length, 1);
  strictEqual(pusha.events.some((event, index) => index > firstMemoryWrite(pusha) && event.startsWith("guard ")), false);
  ok(pusha.events.includes("set mem(%14):16 <- %6"));
  strictEqual(pusha.defs[6], "project16(%0)");
  strictEqual(pusha.defs[14], "sub(%0, 10)");
});

test("popad and popa preflight one range and skip the saved stack pointer slot", () => {
  const popad = buildSemanticTrace(popadSemantic());
  const popa = buildSemanticTrace(popaSemantic());

  deepStrictEqual(popad.events.slice(0, 2), [
    "%0 = get esp:32",
    "guard read %0:32"
  ]);
  strictEqual(popad.events.filter((event) => event.startsWith("guard ")).length, 1);
  strictEqual(popad.events.some((event, index) => index > firstMemoryWrite(popad) && event.startsWith("guard ")), false);
  strictEqual(popad.defs.includes("add(%0, 12)"), false);
  deepStrictEqual(popad.events.filter((event) => event.startsWith("set ")), [
    "set edi:32 <- %1",
    "set esi:32 <- %3",
    "set ebp:32 <- %5",
    "set ebx:32 <- %7",
    "set edx:32 <- %9",
    "set ecx:32 <- %11",
    "set eax:32 <- %13",
    "set esp:32 <- %14"
  ]);

  deepStrictEqual(popa.events.slice(0, 2), [
    "%0 = get esp:32",
    "guard read %0:16"
  ]);
  strictEqual(popa.events.filter((event) => event.startsWith("guard ")).length, 1);
  strictEqual(popa.events.some((event, index) => index > firstMemoryWrite(popa) && event.startsWith("guard ")), false);
  strictEqual(popa.defs.includes("add(%0, 6)"), false);
  deepStrictEqual(popa.events.filter((event) => event.startsWith("set ")), [
    "set di:16 <- %1",
    "set si:16 <- %3",
    "set bp:16 <- %5",
    "set bx:16 <- %7",
    "set dx:16 <- %9",
    "set cx:16 <- %11",
    "set ax:16 <- %13",
    "set esp:32 <- %14"
  ]);
});

test("leave semantic reads saved frame before updating esp and ebp", () => {
  const trace = buildSemanticTrace(leaveSemantic());

  deepStrictEqual(trace.events, [
    "%0 = get ebp:32",
    "guard read %0:4",
    "%1 = get mem(%0):32",
    "set esp:32 <- %2",
    "set ebp:32 <- %1",
    "next"
  ]);
  strictEqual(trace.defs[2], "add(%0, 4)");
});

test("call semantic resolves the target before pushing the return address", () => {
  const trace = buildSemanticTrace(callSemantic(), regOperands(1));

  deepStrictEqual(trace.events, [
    "%0 = get op0:32",
    "%1 = get esp:32",
    "guard write %2:4",
    "set mem(%2):32 <- nextEip",
    "set esp:32 <- %2",
    "jump %0"
  ]);
  strictEqual(trace.defs[2], "sub(%1, 4)");
});

test("ret semantic jumps to the popped value after incrementing esp", () => {
  const trace = buildSemanticTrace(retSemantic());

  deepStrictEqual(trace.events, [
    "%0 = get esp:32",
    "guard read %0:4",
    "%1 = get mem(%0):32",
    "set esp:32 <- %2",
    "jump %1"
  ]);
  strictEqual(trace.defs[2], "add(%0, 4)");
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

function firstMemoryWrite(trace: SemanticTrace): number {
  const index = trace.events.findIndex((event) => event.startsWith("set mem("));

  return index === -1 ? trace.events.length : index;
}

function flagSourceEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("flagSource "));
}
