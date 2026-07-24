import { divideError } from "#core/exceptions.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { SemanticTemplate, SemanticsBuilder } from "#instructions/semantics/builder.js";
import type { Value } from "#instructions/semantics/refs.js";
import type { OperandWidth } from "#core/types.js";

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
  return (s, v) => {
    const src = s.operand(0);
    const divisor = s.read(src, { width, signed: kind === "signed" });
    const result = kind === "signed"
      ? signedDivide(s, v, width, divisor)
      : unsignedDivide(s, v, width, divisor);

    // The undefined DIV/IDIV status flags keep their prior values on observed
    // hardware, so no flags are written.
    writeDivideResult(s, width, result);
  };
}

function unsignedDivide(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: OperandWidth,
  divisor: Value
): DivideResult {
  const dividend = unsignedDividend(s, v, width);

  // The quotient fits if the dividend's high half is below the divisor; a
  // zero divisor fails that too, so one check covers both #DE causes.
  s.if(
    v.compare(width, "ge_u", dividend.high, divisor),
    (then) => then.cpuException(divideError()),
    "unlikely"
  );

  switch (width) {
    case 8:
    case 16:
      return {
        quotient: v.binary("div_u", dividend.full, divisor),
        remainder: v.binary("rem_u", dividend.full, divisor)
      };
    case 32: {
      const divisor64 = v.extend64(32, divisor, false);

      return {
        quotient: v.truncate64(32, v.binary64("div_u", dividend.full, divisor64)),
        remainder: v.truncate64(32, v.binary64("rem_u", dividend.full, divisor64))
      };
    }
  }
}

function signedDivide(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: OperandWidth,
  divisor: Value
): DivideResult {
  switch (width) {
    case 8:
    case 16: {
      const dividend = signedNarrowDividend(s, v, width);

      s.if(
        undefinedSignedDivision(v, width, dividend, divisor),
        (then) => then.cpuException(divideError()),
        "unlikely"
      );

      const quotient = v.binary("div_s", dividend, divisor);

      s.if(
        narrowQuotientOverflows(v, width, quotient),
        (then) => then.cpuException(divideError()),
        "unlikely"
      );

      return { quotient, remainder: v.binary("rem_s", dividend, divisor) };
    }
    case 32: {
      const dividend = signedDwordDividend(s, v);

      s.if(
        undefinedSignedDivision(v, width, dividend, divisor),
        (then) => then.cpuException(divideError()),
        "unlikely"
      );

      const divisor64 = v.extend64(32, divisor, true);
      const quotient64 = v.binary64("div_s", dividend, divisor64);
      const quotient = v.truncate64(32, quotient64);

      // The quotient fits if it round-trips through its low 32 bits; the
      // truncation is shared with the register write.
      s.if(
        v.compare64("ne", v.extend64(32, quotient, true), quotient64),
        (then) => then.cpuException(divideError()),
        "unlikely"
      );

      return { quotient, remainder: v.truncate64(32, v.binary64("rem_s", dividend, divisor64)) };
    }
  }
}

// The division cannot evaluate a zero divisor, nor the minimum dividend of
// its computation type over -1; both raise #DE (the latter overflows the
// destination), so both are checked before dividing.
function undefinedSignedDivision(
  v: ValueBuilder,
  width: OperandWidth,
  dividend: Value,
  divisor: Value
): Value {
  const divisorZero = v.compare(32, "eq", divisor, v.const(0));

  // A byte divide's sign-extended 16-bit dividend cannot reach INT32_MIN.
  if (width === 8) {
    return divisorZero;
  }

  const dividendMin = width === 16
    ? v.compare(32, "eq", dividend, v.const(-0x8000_0000))
    : v.compare64("eq", dividend, v.const64(-0x8000_0000_0000_0000n));
  const divisorMinusOne = v.compare(32, "eq", divisor, v.const(-1));

  return v.binary("or", divisorZero, v.binary("and", dividendMin, divisorMinusOne));
}

// The quotient fits its signed width if quotient + 2^(width-1) fits the
// unsigned width.
function narrowQuotientOverflows(
  v: ValueBuilder,
  width: Extract<OperandWidth, 8 | 16>,
  quotient: Value
): Value {
  const bias = width === 8 ? 0x80 : 0x8000;

  return v.compare(32, "ge_u", v.binary("add", quotient, v.const(bias)), v.const(bias * 2));
}

function unsignedDividend(s: SemanticsBuilder, v: ValueBuilder, width: OperandWidth): UnsignedDividend {
  switch (width) {
    case 8: {
      const ax = s.read(s.reg("ax"), { width: 16 });

      return {
        high: v.binary("shr_u", ax, v.const(8)),
        full: ax
      };
    }
    case 16: {
      const low = s.read(s.reg("ax"), { width: 16 });
      const high = s.read(s.reg("dx"), { width: 16 });

      return {
        high,
        full: v.binary("or", v.binary("shl", high, v.const(16)), low)
      };
    }
    case 32: {
      const low = s.read(s.reg("eax"), { width: 32 });
      const high = s.read(s.reg("edx"), { width: 32 });
      const low64 = v.extend64(32, low, false);
      const high64 = v.extend64(32, high, false);

      return {
        high,
        full: v.binary64("or", v.binary64("shl", high64, v.const64(32n)), low64)
      };
    }
  }
}

function signedNarrowDividend(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: Extract<OperandWidth, 8 | 16>
): Value {
  switch (width) {
    case 8:
      return s.read(s.reg("ax"), { width: 16, signed: true });
    case 16: {
      const low = s.read(s.reg("ax"), { width: 16 });
      const high = s.read(s.reg("dx"), { width: 16, signed: true });

      return v.binary("or", v.binary("shl", high, v.const(16)), low);
    }
  }
}

function signedDwordDividend(s: SemanticsBuilder, v: ValueBuilder): Value {
  const low = s.read(s.reg("eax"), { width: 32 });
  const high = s.read(s.reg("edx"), { width: 32 });
  const low64 = v.extend64(32, low, false);
  const high64 = v.extend64(32, high, true);

  return v.binary64("or", v.binary64("shl", high64, v.const64(32n)), low64);
}

function writeDivideResult(
  s: SemanticsBuilder,
  width: OperandWidth,
  result: DivideResult
): void {
  switch (width) {
    case 8:
      s.write(s.reg("al"), result.quotient, { width: 8 });
      s.write(s.reg("ah"), result.remainder, { width: 8 });
      return;
    case 16:
      s.write(s.reg("ax"), result.quotient, { width: 16 });
      s.write(s.reg("dx"), result.remainder, { width: 16 });
      return;
    case 32:
      s.write(s.reg("eax"), result.quotient, { width: 32 });
      s.write(s.reg("edx"), result.remainder, { width: 32 });
      return;
  }
}
