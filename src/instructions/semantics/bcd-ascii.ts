import {
  integer,
  select,
  u8,
  u16,
  type Integer,
  type BitValue
} from "#compiler/function/values.js";
import { zspValues } from "#core/flags/values.js";
import { divideError } from "#core/exceptions.js";
import type { InstructionSemantics, SemanticsBuilder } from "#instructions/semantics/builder.js";
import { writeAddFlags, writeStatusFlagValues } from "./flag-writes.js";

export function daaSemantic(): InstructionSemantics {
  return (s) => {
    const oldAl = s.read(s.reg("al"));
    const lowAdjust = decimalLowAdjust(s, oldAl);
    const highAdjust = oldAl.unsigned.gt(0x99).or(s.readFlag("CF"));
    const afterLowAdjust = oldAl.add(select(lowAdjust, u8(0x06), u8(0)));
    const result = afterLowAdjust.add(select(highAdjust, u8(0x60), u8(0)));

    s.write(s.reg("al"), result);
    writeAdjustFlags(s, result, { highAdjust, lowAdjust });
  };
}

export function dasSemantic(): InstructionSemantics {
  return (s) => {
    const oldAl = s.read(s.reg("al"));
    const lowAdjust = decimalLowAdjust(s, oldAl);
    const highAdjust = oldAl.unsigned.gt(0x99).or(s.readFlag("CF"));
    const lowBorrow = lowAdjust.and(oldAl.unsigned.lt(0x06));
    const carryAdjust = highAdjust.or(lowBorrow);
    const afterLowAdjust = oldAl.sub(select(lowAdjust, u8(0x06), u8(0)));
    const result = afterLowAdjust.sub(select(highAdjust, u8(0x60), u8(0)));

    s.write(s.reg("al"), result);
    writeAdjustFlags(s, result, { highAdjust: carryAdjust, lowAdjust });
  };
}

export function aaaSemantic(): InstructionSemantics {
  return (s) => asciiAdjust(s, "add");
}

export function aasSemantic(): InstructionSemantics {
  return (s) => asciiAdjust(s, "sub");
}

export function aamSemantic(): InstructionSemantics {
  return (s) => {
    const base = s.read(s.operand(0), 8);
    const oldAl = s.read(s.reg("al"));

    s.if(base.eq(0), (then) => then.cpuException(divideError()), "unlikely");

    const quotient = oldAl.unsigned.div(base);
    const remainder = oldAl.unsigned.rem(base);

    s.write(s.reg("ah"), quotient);
    s.write(s.reg("al"), remainder);
    writeAdjustFlags(s, remainder);
  };
}

export function aadSemantic(): InstructionSemantics {
  return (s) => {
    const base = s.read(s.operand(0), 8);
    const oldAl = s.read(s.reg("al"));
    const oldAh = s.read(s.reg("ah"));
    const addend = oldAh.mul(base);
    const result = oldAl.add(addend);

    s.write(s.reg("al"), result);
    s.write(s.reg("ah"), u8(0));
    writeAddFlags(s, { left: oldAl, right: addend, result });
  };
}

function asciiAdjust(s: SemanticsBuilder, op: "add" | "sub"): void {
  const oldAx = s.read(s.reg("ax"));
  const oldAl = s.read(s.reg("al"));
  const adjust = decimalLowAdjust(s, oldAl);
  const adjustedAx = oldAx[op](select(adjust, u16(0x0106), u16(0)));
  const resultAl = adjustedAx.and(0x0f).truncate(8);
  const resultAx = adjustedAx.and(0xff0f);

  s.write(s.reg("ax"), resultAx);
  writeAdjustFlags(s, resultAl, { lowAdjust: adjust });
}

function decimalLowAdjust(s: SemanticsBuilder, oldAl: Integer<8>): BitValue {
  return oldAl.and(0x0f).unsigned.gt(9).or(s.readFlag("AF"));
}

function writeAdjustFlags(
  s: SemanticsBuilder,
  result: Integer<8>,
  adjust?: Readonly<{ highAdjust?: BitValue; lowAdjust?: BitValue }>
): void {
  // Missing adjust values mean CF/AF are architecturally undefined; choose zero as observed.
  const lowAdjust = adjust?.lowAdjust ?? integer(1, 0);
  const highAdjust = adjust?.highAdjust ?? lowAdjust;

  writeStatusFlagValues(s, {
    ...zspValues(result),
    CF: highAdjust,
    AF: lowAdjust,
    // OF is architecturally undefined; choose zero as observed.
    OF: integer(1, 0)
  });
}
