import { zspValues } from "#x86/flag-values.js";
import { divideError } from "#x86/exceptions.js";
import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";
import { writeAddFlags, writeStatusFlagValues } from "./flag-writes.js";
import { semanticFlagOps } from "./flag-value-ops.js";

export function daaSemantic(): SemanticTemplate {
  return (s) => {
    const oldAl = s.get(s.reg("al"), 8);
    const lowAdjust = decimalLowAdjust(s, oldAl);
    const highAdjust = s.binary("or", s.compare(8, "gt_u", oldAl, s.const32(0x99)), s.readFlag("CF"));
    const afterLowAdjust = addSelectedByte(s, oldAl, lowAdjust, 0x06);
    const result = addSelectedByte(s, afterLowAdjust, highAdjust, 0x60);

    s.set(s.reg("al"), result, 8);
    writeAdjustFlags(s, result, { highAdjust, lowAdjust });
  };
}

export function dasSemantic(): SemanticTemplate {
  return (s) => {
    const oldAl = s.get(s.reg("al"), 8);
    const lowAdjust = decimalLowAdjust(s, oldAl);
    const highAdjust = s.binary("or", s.compare(8, "gt_u", oldAl, s.const32(0x99)), s.readFlag("CF"));
    const lowBorrow = s.binary("and", lowAdjust, s.compare(8, "lt_u", oldAl, s.const32(0x06)));
    const carryAdjust = s.binary("or", highAdjust, lowBorrow);
    const afterLowAdjust = subSelectedByte(s, oldAl, lowAdjust, 0x06);
    const result = subSelectedByte(s, afterLowAdjust, highAdjust, 0x60);

    s.set(s.reg("al"), result, 8);
    writeAdjustFlags(s, result, { highAdjust: carryAdjust, lowAdjust });
  };
}

export function aaaSemantic(): SemanticTemplate {
  return (s) => {
    asciiAdjust(s, "add");
  };
}

export function aasSemantic(): SemanticTemplate {
  return (s) => {
    asciiAdjust(s, "sub");
  };
}

export function aamSemantic(): SemanticTemplate {
  return (s) => {
    const base = s.get(s.operand(0), 8);
    const oldAl = s.get(s.reg("al"), 8);

    s.cpuExceptionIf(s.compare(8, "eq", base, s.const32(0)), divideError());

    const quotient = s.binary("div_u", oldAl, base);
    const remainder = s.binary("rem_u", oldAl, base);

    s.set(s.reg("ah"), quotient, 8);
    s.set(s.reg("al"), remainder, 8);
    writeAdjustFlags(s, remainder);
  };
}

export function aadSemantic(): SemanticTemplate {
  return (s) => {
    const base = s.get(s.operand(0), 8);
    const oldAl = s.get(s.reg("al"), 8);
    const oldAh = s.get(s.reg("ah"), 8);
    const addend = s.binary("mul", oldAh, base);
    const result = s.truncate(8, s.binary("add", oldAl, addend));

    s.set(s.reg("al"), result, 8);
    s.set(s.reg("ah"), s.const32(0), 8);
    writeAddFlags(s, { width: 8, left: oldAl, right: addend, result });
  };
}

function asciiAdjust(s: SemanticsBuilder, op: "add" | "sub"): void {
  const oldAx = s.get(s.reg("ax"), 16);
  const oldAl = s.get(s.reg("al"), 8);
  const adjust = decimalLowAdjust(s, oldAl);
  const adjustedAx = s.truncate(
    16,
    op === "add"
      ? s.binary("add", oldAx, s.select(adjust, s.const32(0x0106), s.const32(0)))
      : s.binary("sub", oldAx, s.select(adjust, s.const32(0x0106), s.const32(0)))
  );
  const resultAl = s.binary("and", adjustedAx, s.const32(0x0f));
  const resultAx = s.binary("and", adjustedAx, s.const32(0xff0f));

  s.set(s.reg("ax"), resultAx, 16);
  writeAdjustFlags(s, resultAl, { lowAdjust: adjust });
}

function decimalLowAdjust(s: SemanticsBuilder, oldAl: ValueInput): Value {
  return s.binary(
    "or",
    s.compare(8, "gt_u", s.binary("and", oldAl, s.const32(0x0f)), s.const32(9)),
    s.readFlag("AF")
  );
}

function addSelectedByte(
  s: SemanticsBuilder,
  value: ValueInput,
  condition: ValueInput,
  amount: number
): Value {
  return s.truncate(8, s.binary("add", value, s.select(condition, s.const32(amount), s.const32(0))));
}

function subSelectedByte(
  s: SemanticsBuilder,
  value: ValueInput,
  condition: ValueInput,
  amount: number
): Value {
  return s.truncate(8, s.binary("sub", value, s.select(condition, s.const32(amount), s.const32(0))));
}

function writeAdjustFlags(
  s: SemanticsBuilder,
  result: ValueInput,
  adjust?: Readonly<{ highAdjust?: ValueInput; lowAdjust?: ValueInput }>
): void {
  const zero = s.const32(0);
  // Missing adjust values mean CF/AF are architecturally undefined; choose zero as observed.
  const lowAdjust = adjust?.lowAdjust ?? zero;
  const highAdjust = adjust?.highAdjust ?? lowAdjust;

  writeStatusFlagValues(s, {
    ...zspValues(semanticFlagOps(s), { width: 8, result }),
    CF: highAdjust,
    AF: lowAdjust,
    // OF is architecturally undefined; choose zero as observed.
    OF: zero
  });
}
