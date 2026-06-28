import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { SemanticTemplate, StatusFlagValues } from "#x86/semantics/builder.js";
import type { ValueInput } from "#x86/semantics/refs.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import {
  addFlagSource,
  logicFlagSource,
  subFlagSource,
  writeAddFlags,
  writeDecFlags,
  writeIncFlags,
  writeNegFlags,
  writeRotateFlags,
  writeShiftFlags,
  writeSubFlags
} from "#x86/semantics/flag-writes.js";

import {
  buildSemanticTrace,
  flagCell,
  regOperands,
  type SemanticTrace
} from "./test-semantics-trace.js";

test("ADD and SUB flag writers write every arithmetic flag value from caller-provided results", () => {
  for (const op of ["add", "sub"] as const) {
    const trace = buildHelperTrace((s) => {
      const left = s.get(s.operand(0), 32);
      const right = s.get(s.operand(1), 32);
      const result = op === "add"
        ? s.project(32, s.binary("add", left, right))
        : s.project(32, s.binary("sub", left, right));

      if (op === "add") {
        writeAddFlags(s, { width: 32, left, right, result });
      } else {
        writeSubFlags(s, { width: 32, left, right, result });
      }

      s.set(s.operand(0), result);
    });
    const write = onlyFlagWrite(trace);

    assertFlagSet(write, x86StatusFlags);
  }
});

test("arithmetic flag source helpers wrap precomputed results without setting operands", () => {
  let addSource: ReturnType<typeof addFlagSource> | undefined;
  let subSource: ReturnType<typeof subFlagSource> | undefined;
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 16);
    const right = s.get(s.operand(1), 16);
    const addResult = s.project(16, s.binary("add", left, right));
    const subResult = s.project(16, s.binary("sub", left, right));

    addSource = addFlagSource({ width: 16, left, right, result: addResult });
    subSource = subFlagSource({ width: 16, left, right, result: subResult });
    s.writeStatusFlagsSource(addSource);
    s.writeStatusFlagsSource(subSource);
  }, regOperands(2));

  strictEqual(addSource?.kind, "add");
  strictEqual(subSource?.kind, "sub");
  strictEqual(trace.events.some((event) => event.startsWith("set ")), false);
  strictEqual(trace.flagWrites.length, 0);
  strictEqual(flagSourceEvents(trace).length, 2);
  strictEqual(flagSourceEvents(trace)[0]!.startsWith("flagSource add:16"), true);
  strictEqual(flagSourceEvents(trace)[1]!.startsWith("flagSource sub:16"), true);
});

test("logic flag source helper wraps a precomputed logic result", () => {
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 32);
    const right = s.get(s.operand(1), 32);
    const result = s.project(32, s.binary("and", left, right));

    s.writeStatusFlagsSource(logicFlagSource({ width: 32, result }));
  });

  strictEqual(flagSourceEvents(trace).length, 1);
  strictEqual(flagSourceEvents(trace)[0]!.startsWith("flagSource logic:32"), true);
  strictEqual(trace.flagWrites.length, 0);
});

test("INC and DEC helpers preserve CF by writing only the other status flags", () => {
  for (const [name, helper] of [
    ["inc", writeIncFlags],
    ["dec", writeDecFlags]
  ] as const) {
    const trace = buildHelperTrace((s) => {
      const input = s.get(s.operand(0), 8);
      const one = s.const32(1);
      const result = name === "inc" ? s.binary("add", input, one) : s.binary("sub", input, one);

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
    const result = s.binary("sub", s.const32(0), input);

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
    const result = s.project(32, s.binary("add", left, right));

    writeAddFlags(s, { width: 32, left, right, result });
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
      const result = s.project(width, s.binary("add", left, right));

      writeAddFlags(s, { width, left, right, result });
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
    const result = s.project(8, s.binary("add", s.binary("add", left, right), addCarryIn));

    writeAddFlags(s, { width: 8, left, right, result, carryIn: addCarryIn });
  });
  const addCf = addTrace.def(flagCell(onlyFlagWrite(addTrace), "CF"));

  ok(addCarryIn !== undefined, "expected captured add carry input");

  ok(addCf.startsWith(`select(${addTrace.value(addCarryIn)}, `));
  ok(addTrace.defs.some((def) => def.startsWith("cmp8.le_u(")));
  ok(addTrace.defs.some((def) => def.startsWith("cmp8.lt_u(")));

  let subBorrowIn: ValueInput | undefined;
  const subTrace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 8);
    const right = s.get(s.operand(1), 8);

    subBorrowIn = s.compare(8, "ne", right, s.const32(0));
    const result = s.project(8, s.binary("sub", s.binary("sub", left, right), subBorrowIn));

    writeSubFlags(s, { width: 8, left, right, result, borrowIn: subBorrowIn });
  });
  const subCf = subTrace.def(flagCell(onlyFlagWrite(subTrace), "CF"));

  ok(subBorrowIn !== undefined, "expected captured sub borrow input");

  ok(subCf.startsWith(`select(${subTrace.value(subBorrowIn)}, `));
  ok(subTrace.defs.some((def) => def.startsWith("cmp8.le_u(")));
  ok(subTrace.defs.some((def) => def.startsWith("cmp8.lt_u(")));
});

test("flag writers use the supplied result value for result-derived flags", () => {
  let result: ValueInput | undefined;
  const trace = buildHelperTrace((s) => {
    const left = s.get(s.operand(0), 16);
    const right = s.get(s.operand(1), 16);

    result = s.project(16, s.binary("add", left, right));
    writeAddFlags(s, { width: 16, left, right, result });
    s.set(s.operand(0), result, 16);
  });

  ok(result !== undefined, "expected captured result");

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
      const result = op === "and"
        ? s.binary("and", left, right)
        : op === "or"
          ? s.binary("or", left, right)
          : s.binary("xor", left, right);

      s.set(s.operand(0), result, 8);
      s.writeStatusFlagsSource(logicFlagSource({ width: 8, result }));
    });

    strictEqual(flagSourceEvents(trace).length, 1);
    strictEqual(trace.flagWrites.length, 0);
  }
});

test("shift flag writer consumes the masked count and supplied result", () => {
  const trace = buildHelperTrace((s) => {
    const value = s.project(16, s.get(s.operand(0), 16));
    const count = s.binary("and", s.get(s.operand(1), 8), s.const32(0x1f));
    const result = s.get(s.operand(2), 16);

    writeShiftFlags(s, {
      op: "shl",
      width: 16,
      value,
      count,
      result
    });
  }, regOperands(3));
  const write = onlyFlagWrite(trace);

  assertFlagSet(write, x86StatusFlags);
  strictEqual(trace.defs.some((def) => def.startsWith("shl(")), false);
  strictEqual(trace.defs.some((def) => def.startsWith("shr_s(")), false);
  ok(trace.def(flagCell(write, "CF")).startsWith("select("));
  ok(trace.def(flagCell(write, "OF")).startsWith("select("));
});

test("rotate flag writer updates only carry and overflow", () => {
  const trace = buildHelperTrace((s) => {
    const result = s.get(s.operand(0), 8);
    const count = s.get(s.operand(1), 8);
    const carry = s.binary("and", result, s.const32(1));
    const carryDefined = s.compare(32, "ne", count, s.const32(0));

    writeRotateFlags(s, {
      op: "rol",
      width: 8,
      count,
      result,
      carry,
      carryDefined
    });
  }, regOperands(2));

  strictEqual(trace.flagWrites.length, 0);
  deepStrictEqual(directFlagWrites(trace).sort(), ["CF", "OF"]);
  ok(directFlagDefinition(trace, "CF").startsWith("select("));
  ok(directFlagDefinition(trace, "OF").startsWith("select("));
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

  ok(event !== undefined, `expected direct ${flag} flag write`);

  const value = event.slice(prefix.length);
  const display = /^%(\d+)$/.exec(value);

  if (display === null) {
    return value;
  }

  const definition = trace.defs[Number(display[1]!)];

  ok(definition !== undefined, `missing definition for ${value}`);

  return definition;
}

function flagSourceEvents(trace: SemanticTrace): string[] {
  return trace.events.filter((event) => event.startsWith("flagSource "));
}
