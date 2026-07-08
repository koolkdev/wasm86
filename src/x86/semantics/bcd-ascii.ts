import { zspValues } from "#x86/flag-values.js";
import { divideError } from "#x86/exceptions.js";
import type { SemanticTemplate, SemanticsBuilder, Values } from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";
import { writeAddFlags, writeStatusFlagValues } from "./flag-writes.js";
import { semanticFlagOps } from "./flag-value-ops.js";

export function daaSemantic(): SemanticTemplate {
  return (s, v) => {
    const oldAl = s.get(s.reg("al"), 8);
    const lowAdjust = decimalLowAdjust(s, v, oldAl);
    const highAdjust = v.binary("or", v.compare(8, "gt_u", oldAl, v.const(0x99)), s.readFlag("CF"));
    const afterLowAdjust = addSelectedByte(v, oldAl, lowAdjust, 0x06);
    const result = addSelectedByte(v, afterLowAdjust, highAdjust, 0x60);

    s.set(s.reg("al"), result, 8);
    writeAdjustFlags(s, v, result, { highAdjust, lowAdjust });
  };
}

export function dasSemantic(): SemanticTemplate {
  return (s, v) => {
    const oldAl = s.get(s.reg("al"), 8);
    const lowAdjust = decimalLowAdjust(s, v, oldAl);
    const highAdjust = v.binary("or", v.compare(8, "gt_u", oldAl, v.const(0x99)), s.readFlag("CF"));
    const lowBorrow = v.binary("and", lowAdjust, v.compare(8, "lt_u", oldAl, v.const(0x06)));
    const carryAdjust = v.binary("or", highAdjust, lowBorrow);
    const afterLowAdjust = subSelectedByte(v, oldAl, lowAdjust, 0x06);
    const result = subSelectedByte(v, afterLowAdjust, highAdjust, 0x60);

    s.set(s.reg("al"), result, 8);
    writeAdjustFlags(s, v, result, { highAdjust: carryAdjust, lowAdjust });
  };
}

export function aaaSemantic(): SemanticTemplate {
  return (s, v) => {
    asciiAdjust(s, v, "add");
  };
}

export function aasSemantic(): SemanticTemplate {
  return (s, v) => {
    asciiAdjust(s, v, "sub");
  };
}

export function aamSemantic(): SemanticTemplate {
  return (s, v) => {
    const base = s.get(s.operand(0), 8);
    const oldAl = s.get(s.reg("al"), 8);

    s.cpuExceptionIf(v.compare(8, "eq", base, v.const(0)), divideError());

    const quotient = v.binary("div_u", oldAl, base);
    const remainder = v.binary("rem_u", oldAl, base);

    s.set(s.reg("ah"), quotient, 8);
    s.set(s.reg("al"), remainder, 8);
    writeAdjustFlags(s, v, remainder);
  };
}

export function aadSemantic(): SemanticTemplate {
  return (s, v) => {
    const base = s.get(s.operand(0), 8);
    const oldAl = s.get(s.reg("al"), 8);
    const oldAh = s.get(s.reg("ah"), 8);
    const addend = v.binary("mul", oldAh, base);
    const result = v.truncate(8, v.binary("add", oldAl, addend));

    s.set(s.reg("al"), result, 8);
    s.set(s.reg("ah"), v.const(0), 8);
    writeAddFlags(s, v, { width: 8, left: oldAl, right: addend, result });
  };
}

function asciiAdjust(s: SemanticsBuilder, v: Values, op: "add" | "sub"): void {
  const oldAx = s.get(s.reg("ax"), 16);
  const oldAl = s.get(s.reg("al"), 8);
  const adjust = decimalLowAdjust(s, v, oldAl);
  const adjustedAx = v.truncate(
    16,
    op === "add"
      ? v.binary("add", oldAx, v.select(adjust, v.const(0x0106), v.const(0)))
      : v.binary("sub", oldAx, v.select(adjust, v.const(0x0106), v.const(0)))
  );
  const resultAl = v.binary("and", adjustedAx, v.const(0x0f));
  const resultAx = v.binary("and", adjustedAx, v.const(0xff0f));

  s.set(s.reg("ax"), resultAx, 16);
  writeAdjustFlags(s, v, resultAl, { lowAdjust: adjust });
}

function decimalLowAdjust(s: SemanticsBuilder, v: Values, oldAl: ValueInput): Value {
  return v.binary(
    "or",
    v.compare(8, "gt_u", v.binary("and", oldAl, v.const(0x0f)), v.const(9)),
    s.readFlag("AF")
  );
}

function addSelectedByte(v: Values, value: ValueInput, condition: ValueInput, amount: number): Value {
  return v.truncate(8, v.binary("add", value, v.select(condition, v.const(amount), v.const(0))));
}

function subSelectedByte(v: Values, value: ValueInput, condition: ValueInput, amount: number): Value {
  return v.truncate(8, v.binary("sub", value, v.select(condition, v.const(amount), v.const(0))));
}

function writeAdjustFlags(
  s: SemanticsBuilder,
  v: Values,
  result: ValueInput,
  adjust?: Readonly<{ highAdjust?: ValueInput; lowAdjust?: ValueInput }>
): void {
  const zero = v.const(0);
  // Missing adjust values mean CF/AF are architecturally undefined; choose zero as observed.
  const lowAdjust = adjust?.lowAdjust ?? zero;
  const highAdjust = adjust?.highAdjust ?? lowAdjust;

  writeStatusFlagValues(s, {
    ...zspValues(semanticFlagOps(v), { width: 8, result }),
    CF: highAdjust,
    AF: lowAdjust,
    // OF is architecturally undefined; choose zero as observed.
    OF: zero
  });
}
