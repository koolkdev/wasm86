import { divideError } from "#x86/exceptions.js";
import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { guardStorageRead } from "./memory.js";

type DivideKind = "signed" | "unsigned";
type DivideResult = Readonly<{ quotient: Value; remainder: Value }>;
type UnsignedDividend = Readonly<{ high: Value; full: Value }>;

export function divImplicitSemantic(width: OperandWidth): SemanticTemplate {
  return implicitDivideSemantic("unsigned", width);
}

export function idivImplicitSemantic(width: OperandWidth): SemanticTemplate {
  return implicitDivideSemantic("signed", width);
}

function implicitDivideSemantic(kind: DivideKind, width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);

    guardStorageRead(s, context, src, width);

    const divisor = s.get(src, width, { signed: kind === "signed" });
    const result = kind === "signed"
      ? signedDivide(s, width, divisor)
      : unsignedDivide(s, width, divisor);

    // The undefined DIV/IDIV status flags keep their prior values on observed
    // hardware, so no flags are written.
    writeDivideResult(s, width, result);
  };
}

function unsignedDivide(
  s: SemanticsBuilder,
  width: OperandWidth,
  divisor: Value
): DivideResult {
  const dividend = unsignedDividend(s, width);

  // The quotient fits if the dividend's high half is below the divisor; a
  // zero divisor fails that too, so one check covers both #DE causes.
  s.cpuExceptionIf(s.compare(width, "ge_u", dividend.high, divisor), divideError());

  switch (width) {
    case 8:
    case 16:
      return {
        quotient: s.binary("div_u", dividend.full, divisor),
        remainder: s.binary("rem_u", dividend.full, divisor)
      };
    case 32: {
      const divisor64 = s.extend64(32, divisor, false);

      return {
        quotient: s.truncate64(32, s.binary64("div_u", dividend.full, divisor64)),
        remainder: s.truncate64(32, s.binary64("rem_u", dividend.full, divisor64))
      };
    }
  }
}

function signedDivide(
  s: SemanticsBuilder,
  width: OperandWidth,
  divisor: Value
): DivideResult {
  switch (width) {
    case 8:
    case 16: {
      const dividend = signedNarrowDividend(s, width);

      s.cpuExceptionIf(undefinedSignedDivision(s, width, dividend, divisor), divideError());

      const quotient = s.binary("div_s", dividend, divisor);

      s.cpuExceptionIf(narrowQuotientOverflows(s, width, quotient), divideError());

      return { quotient, remainder: s.binary("rem_s", dividend, divisor) };
    }
    case 32: {
      const dividend = signedDwordDividend(s);

      s.cpuExceptionIf(undefinedSignedDivision(s, width, dividend, divisor), divideError());

      const divisor64 = s.extend64(32, divisor, true);
      const quotient64 = s.binary64("div_s", dividend, divisor64);
      const quotient = s.truncate64(32, quotient64);

      // The quotient fits if it round-trips through its low 32 bits; the
      // truncation is shared with the register write.
      s.cpuExceptionIf(s.compare64("ne", s.extend64(32, quotient, true), quotient64), divideError());

      return { quotient, remainder: s.truncate64(32, s.binary64("rem_s", dividend, divisor64)) };
    }
  }
}

// The division cannot evaluate a zero divisor, nor the minimum dividend of
// its computation type over -1; both raise #DE (the latter overflows the
// destination), so both are checked before dividing.
function undefinedSignedDivision(
  s: SemanticsBuilder,
  width: OperandWidth,
  dividend: Value,
  divisor: Value
): Value {
  const divisorZero = s.compare(32, "eq", divisor, s.const32(0));

  // A byte divide's sign-extended 16-bit dividend cannot reach INT32_MIN.
  if (width === 8) {
    return divisorZero;
  }

  const dividendMin = width === 16
    ? s.compare(32, "eq", dividend, s.const32(-0x8000_0000))
    : s.compare64("eq", dividend, s.const64(-0x8000_0000_0000_0000n));
  const divisorMinusOne = s.compare(32, "eq", divisor, s.const32(-1));

  return s.binary("or", divisorZero, s.binary("and", dividendMin, divisorMinusOne));
}

// The quotient fits its signed width if quotient + 2^(width-1) fits the
// unsigned width.
function narrowQuotientOverflows(
  s: SemanticsBuilder,
  width: Extract<OperandWidth, 8 | 16>,
  quotient: Value
): Value {
  const bias = width === 8 ? 0x80 : 0x8000;

  return s.compare(32, "ge_u", s.binary("add", quotient, s.const32(bias)), s.const32(bias * 2));
}

function unsignedDividend(s: SemanticsBuilder, width: OperandWidth): UnsignedDividend {
  switch (width) {
    case 8: {
      const ax = s.get(s.reg("ax"), 16);

      return {
        high: s.binary("shr_u", ax, s.const32(8)),
        full: ax
      };
    }
    case 16: {
      const low = s.get(s.reg("ax"), 16);
      const high = s.get(s.reg("dx"), 16);

      return {
        high,
        full: s.binary("or", s.binary("shl", high, s.const32(16)), low)
      };
    }
    case 32: {
      const low = s.get(s.reg("eax"), 32);
      const high = s.get(s.reg("edx"), 32);
      const low64 = s.extend64(32, low, false);
      const high64 = s.extend64(32, high, false);

      return {
        high,
        full: s.binary64("or", s.binary64("shl", high64, s.const64(32n)), low64)
      };
    }
  }
}

function signedNarrowDividend(
  s: SemanticsBuilder,
  width: Extract<OperandWidth, 8 | 16>
): Value {
  switch (width) {
    case 8:
      return s.get(s.reg("ax"), 16, { signed: true });
    case 16: {
      const low = s.get(s.reg("ax"), 16);
      const high = s.get(s.reg("dx"), 16, { signed: true });

      return s.binary("or", s.binary("shl", high, s.const32(16)), low);
    }
  }
}

function signedDwordDividend(s: SemanticsBuilder): Value {
  const low = s.get(s.reg("eax"), 32);
  const high = s.get(s.reg("edx"), 32);
  const low64 = s.extend64(32, low, false);
  const high64 = s.extend64(32, high, true);

  return s.binary64("or", s.binary64("shl", high64, s.const64(32n)), low64);
}

function writeDivideResult(
  s: SemanticsBuilder,
  width: OperandWidth,
  result: DivideResult
): void {
  switch (width) {
    case 8:
      s.set(s.reg("al"), result.quotient, 8);
      s.set(s.reg("ah"), result.remainder, 8);
      return;
    case 16:
      s.set(s.reg("ax"), result.quotient, 16);
      s.set(s.reg("dx"), result.remainder, 16);
      return;
    case 32:
      s.set(s.reg("eax"), result.quotient, 32);
      s.set(s.reg("edx"), result.remainder, 32);
      return;
  }
}
