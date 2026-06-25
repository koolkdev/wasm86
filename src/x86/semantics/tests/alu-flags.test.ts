import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { SemanticTemplate, StatusFlagValues } from "#x86/semantics/builder.js";
import type { ValueInput } from "#x86/semantics/refs.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import {
  buildAddResultAndWriteFlags,
  buildCmpFlagSource,
  buildLogicResultAndFlagSource,
  buildSubResultAndWriteFlags,
  buildTestFlagSource,
  writeDecFlags,
  writeIncFlags,
  writeNegFlags
} from "#x86/semantics/alu-flags.js";

import {
  buildSemanticTrace,
  flagCell,
  regOperands,
  type SemanticTrace
} from "./test-semantics-trace.js";

test("ADD and SUB helpers write every arithmetic flag value", () => {
  for (const helper of [buildAddResultAndWriteFlags, buildSubResultAndWriteFlags]) {
    const trace = buildHelperTrace((s) => {
      const left = s.get(s.operand(0), 32);
      const right = s.get(s.operand(1), 32);
      const result = helper(s, { width: 32, left, right });

      s.set(s.operand(0), result);
    });
    const write = onlyFlagWrite(trace);

    assertFlagSet(write, x86StatusFlags);
  }
});

test("CMP source helper builds an arithmetic flag source without setting a result", () => {
  let source: ReturnType<typeof buildCmpFlagSource> | undefined;
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 16);
    const right = s.get(s.operand(1), 16);

    source = buildCmpFlagSource(s, { width: 16, left, right });
    s.writeStatusFlagsSource(source);
  }, regOperands(2));

  strictEqual(source?.kind, "sub");
  strictEqual(trace.events.some((event) => event.startsWith("set ")), false);
  strictEqual(trace.flagWrites.length, 0);
  strictEqual(flagSourceEvents(trace).length, 1);
  strictEqual(flagSourceEvents(trace)[0]!.startsWith("flagSource sub:16"), true);
});

test("TEST source helper builds a logic flag source", () => {
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 32);
    const right = s.get(s.operand(1), 32);

    s.writeStatusFlagsSource(buildTestFlagSource(s, { width: 32, left, right }));
  });

  strictEqual(flagSourceEvents(trace).length, 1);
  strictEqual(flagSourceEvents(trace)[0]!.startsWith("flagSource logic:32"), true);
});

test("INC and DEC helpers preserve CF by writing only the other status flags", () => {
  for (const [name, helper] of [
    ["inc", writeIncFlags],
    ["dec", writeDecFlags]
  ] as const) {
    const trace = buildHelperTrace((s) => {
      const input = s.get(s.operand(0), 8);
      const one = s.const32(1);
      const result = name === "inc" ? s.i32Add(input, one) : s.i32Sub(input, one);

      helper(s, { width: 8, input, result });
    }, regOperands(1));

    strictEqual(trace.flagWrites.length, 0);
    deepStrictEqual(directFlagWrites(trace).sort(), ["AF", "OF", "PF", "SF", "ZF"].sort());
    assertDefinitionStarts(directFlagDefinition(trace, "AF"), "cmp32.eq(");
    assertDefinitionStarts(directFlagDefinition(trace, "OF"), "cmp8.eq(");
    ok(directFlagDefinition(trace, "AF").includes(name === "inc" ? ", 15)" : ", 0)"));
    ok(directFlagDefinition(trace, "OF").includes(name === "inc" ? ", 127)" : ", 128)"));
  }
});

test("NEG helper follows x86 CF and OF rules", () => {
  const trace = buildHelperTrace((s) => {
    const input = s.get(s.operand(0), 8);
    const result = s.i32Sub(s.const32(0), input);

    writeNegFlags(s, { width: 8, input, result });
  }, regOperands(1));
  const write = onlyFlagWrite(trace);

  assertFlagSet(write, x86StatusFlags);
  assertDefStarts(trace, flagCell(write, "CF"), "cmp8.ne(");
  ok(trace.def(flagCell(write, "CF")).endsWith(", 0)"));
  assertDefStarts(trace, flagCell(write, "AF"), "cmp32.ne(");
  assertDefStarts(trace, flagCell(write, "OF"), "cmp8.eq(");
  ok(trace.def(flagCell(write, "OF")).endsWith(", 128)"));
});

test("parity formulas use popcnt over only the low byte", () => {
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 32);
    const right = s.get(s.operand(1), 32);

    buildAddResultAndWriteFlags(s, { width: 32, left, right });
  });
  const pf = trace.def(flagCell(onlyFlagWrite(trace), "PF"));

  assertDefStarts(trace, flagCell(onlyFlagWrite(trace), "PF"), "cmp32.eq(");
  ok(trace.defs.some((def) => def.startsWith("popcnt(")));
  ok(trace.defs.some((def) => def.endsWith(", 255)") && def.startsWith("and(")));
  ok(pf.endsWith(", 0)"));
});

test("sign and overflow formulas consume the operation sign bit", () => {
  for (const width of [8, 16, 32] as const) {
    const trace = buildHelperTrace((s) => {
      const left = s.get(s.operand(0), width);
      const right = s.get(s.operand(1), width);

      buildAddResultAndWriteFlags(s, { width, left, right });
    }, regOperands(2));
    const write = onlyFlagWrite(trace);

    ok(trace.def(flagCell(write, "SF")).endsWith(`, ${width - 1})`));
    ok(trace.def(flagCell(write, "OF")).endsWith(`, ${width - 1})`));
  }
});

test("carryIn and borrowIn helpers use ADC/SBB-style carry selects", () => {
  let addCarryIn: ValueInput | undefined;
  const addTrace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 8);
    const right = s.get(s.operand(1), 8);

    addCarryIn = s.compare(8, "ne", left, s.const32(0));
    buildAddResultAndWriteFlags(s, { width: 8, left, right, carryIn: addCarryIn });
  });
  const addCf = addTrace.def(flagCell(onlyFlagWrite(addTrace), "CF"));

  if (addCarryIn === undefined) {
    throw new Error("expected captured add carry input");
  }

  ok(addCf.startsWith(`select(${addTrace.value(addCarryIn)}, `));
  ok(addTrace.defs.some((def) => def.startsWith("cmp8.le_u(")));
  ok(addTrace.defs.some((def) => def.startsWith("cmp8.lt_u(")));

  let subBorrowIn: ValueInput | undefined;
  const subTrace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 8);
    const right = s.get(s.operand(1), 8);

    subBorrowIn = s.compare(8, "ne", right, s.const32(0));
    buildSubResultAndWriteFlags(s, { width: 8, left, right, borrowIn: subBorrowIn });
  });
  const subCf = subTrace.def(flagCell(onlyFlagWrite(subTrace), "CF"));

  if (subBorrowIn === undefined) {
    throw new Error("expected captured sub borrow input");
  }

  ok(subCf.startsWith(`select(${subTrace.value(subBorrowIn)}, `));
  ok(subTrace.defs.some((def) => def.startsWith("cmp8.le_u(")));
  ok(subTrace.defs.some((def) => def.startsWith("cmp8.lt_u(")));
});

test("result helpers share destination writeback result with flag values", () => {
  let result: ValueInput | undefined;
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 16);
    const right = s.get(s.operand(1), 16);
    const built = buildAddResultAndWriteFlags(s, { width: 16, left, right });

    result = built;
    s.set(s.operand(0), built, 16);
  });

  if (result === undefined) {
    throw new Error("expected captured helper result");
  }

  const resultValue = trace.value(result);
  const write = onlyFlagWrite(trace);

  ok(trace.events.includes(`set op0:16 <- ${resultValue}`));
  ok(trace.def(flagCell(write, "ZF")).includes(`(${resultValue}, 0)`));
  ok(trace.def(flagCell(write, "SF")).startsWith(`shr_u(${resultValue}, `));
  ok(trace.def(flagCell(write, "CF")).startsWith(`cmp16.lt_u(${resultValue}, `));
});

test("logic source helpers build source-backed results without direct conditions", () => {
  for (const op of ["and", "or", "xor"] as const) {
    const trace = buildHelperTrace((s) => {
      const left = s.get(s.operand(0), 8);
      const right = s.get(s.operand(1), 8);
      const built = buildLogicResultAndFlagSource(s, { width: 8, op, left, right });

      s.set(s.operand(0), built.result, 8);
      s.writeStatusFlagsSource(built.source);
    });

    strictEqual(flagSourceEvents(trace).length, 1);
    strictEqual(trace.flagWrites.length, 0);
  }
});

function buildHelperTrace(
  template: SemanticTemplate,
  operandInfo = regOperands(2)
): SemanticTrace {
  return buildSemanticTrace(template, operandInfo);
}

function onlyFlagWrite(trace: SemanticTrace): StatusFlagValues {
  strictEqual(trace.flagWrites.length, 1);
  return trace.flagWrites[0]!;
}

function assertFlagSet(write: StatusFlagValues, flags: readonly X86StatusFlag[]): void {
  deepStrictEqual(statusFlagKeys(write).sort(), [...flags].sort());
}

function assertDefStarts(trace: SemanticTrace, value: ValueInput, prefix: string): void {
  ok(trace.def(value).startsWith(prefix), `${trace.def(value)} should start with ${prefix}`);
}

function assertDefinitionStarts(definition: string, prefix: string): void {
  ok(definition.startsWith(prefix), `${definition} should start with ${prefix}`);
}

function statusFlagKeys(write: StatusFlagValues): X86StatusFlag[] {
  return x86StatusFlags.filter((flag) => flag in write);
}

function directFlagWrites(trace: SemanticTrace): X86StatusFlag[] {
  return trace.events.flatMap((event) => {
    const match = /^flag ([A-Z]+) <- /.exec(event);

    return match === null ? [] : [match[1]! as X86StatusFlag];
  });
}

function directFlagDefinition(trace: SemanticTrace, flag: X86StatusFlag): string {
  const prefix = `flag ${flag} <- `;
  const event = trace.events.find((entry) => entry.startsWith(prefix));

  if (event === undefined) {
    throw new Error(`expected direct ${flag} flag write`);
  }

  const value = event.slice(prefix.length);
  const display = /^%(\d+)$/.exec(value);

  return display === null ? value : expectDefined(trace.defs[Number(display[1]!)]);
}

function flagSourceEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("flagSource "));
}

function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected value to be captured");
  }

  return value;
}
