import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { x86StatusFlags } from "#x86/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { callSemantic, retSemantic } from "#x86/semantics/control.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { leaSemantic } from "#x86/semantics/lea.js";
import { intSemantic, nopSemantic } from "#x86/semantics/misc.js";
import { cmovSemantic, movSemantic } from "#x86/semantics/mov.js";
import { shiftSemantic } from "#x86/semantics/shift.js";
import { leaveSemantic, popSemantic } from "#x86/semantics/stack.js";
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

    deepStrictEqual(trace.events.slice(0, 5), [
      "%0 = addr op0",
      "guard read %0:4",
      "guard write %0:4",
      "%1 = get op0:32",
      "%2 = get op1:32"
    ], op);
    strictEqual(trace.events.some((event) => event.startsWith("set op0:32 <- %")), true, op);
  }
});

test("adc and sbb read old CF after operands and before replacing arithmetic flags", () => {
  for (const op of ["adc", "sbb"] as const) {
    const trace = buildSemanticTrace(aluSemantic(op, 32), regOperands(2));
    const flagReadIndex = trace.events.findIndex((event) => event.endsWith(" = flag CF"));
    const firstFlagWrite = trace.events.findIndex((event) => event.startsWith("flag "));
    const setEvent = trace.events.find((event) => event.startsWith("set op0:32 <- "));

    strictEqual(trace.events[0], "%0 = get op0:32", op);
    strictEqual(trace.events[1], "%1 = get op1:32", op);
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

  deepStrictEqual(immTrace.events.slice(0, 5), [
    "%0 = addr op0",
    "guard read %0:4",
    "guard write %0:4",
    "%1 = get op0:32",
    "%2 = get op1:8"
  ]);

  const clTrace = buildSemanticTrace(shiftSemantic("shr", 16, "cl"), operands("mem"));

  deepStrictEqual(clTrace.events.slice(0, 5), [
    "%0 = addr op0",
    "guard read %0:2",
    "guard write %0:2",
    "%1 = get op0:16",
    "%2 = get cl:8"
  ]);
});

test("runtime shift counts are masked before result and flag use", () => {
  const trace = buildSemanticTrace(shiftSemantic("shl", 8, "cl"), regOperands(1));

  strictEqual(trace.defs[2], "project8(%0)");
  strictEqual(trace.defs[3], "and(%1, 31)");
  strictEqual(trace.defs[4], "shl(%2, %3)");
  strictEqual(trace.defs[5], "project8(%4)");
  strictEqual(trace.defs[7], "select(%6, %5, %2)");
  strictEqual(trace.defs[14], "cmp32.eq(%3, 1)");
  strictEqual(trace.defs[15], "sub(8, %3)");
  strictEqual(trace.defs[21], "cmp32.le_u(%3, 8)");
  strictEqual(trace.events[14], "set op0:8 <- %7");
});

test("runtime shift count zero selects the original destination and old flags", () => {
  const trace = buildSemanticTrace(shiftSemantic("shr", 16, "imm8"), operands("reg", "imm"));
  const write = trace.flagWrites[0]!;

  strictEqual(trace.defs[7], "select(%6, %5, %2)");
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

test("sar semantics use signed right shift after width sign extension", () => {
  const trace = buildSemanticTrace(shiftSemantic("sar", 16, "imm8"), operands("reg", "imm"));

  strictEqual(trace.defs[2], "project16(%0)");
  strictEqual(trace.defs[3], "and(%1, 31)");
  strictEqual(trace.defs[4], "extend16_s(%2)");
  strictEqual(trace.defs[5], "shr_s(%4, %3)");
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

function flagSourceEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("flagSource "));
}
