import {
  type Integer,
  type BitValue,
  type I32Value,
  type I64Value
} from "#compiler/function/values.js";
import { divideError } from "#core/exceptions.js";
import type { OperandWidth } from "#core/types.js";
import type { InstructionSemantics, SemanticsBuilder } from "#instructions/semantics/builder.js";
import { reg, type RegRefForWidth } from "#instructions/semantics/refs.js";

type DivideKind = "signed" | "unsigned";
type DivideResult<Width extends OperandWidth> = Readonly<{
  quotient: Integer<Width>;
  remainder: Integer<Width>;
}>;
type DivideOperation<Width extends OperandWidth> = (
  s: SemanticsBuilder,
  kind: DivideKind,
  divisor: Integer<Width>
) => DivideResult<Width>;

export function divImplicitSemantic(width: OperandWidth): InstructionSemantics {
  return implicitDivideSemantic("unsigned", width);
}

export function idivImplicitSemantic(width: OperandWidth): InstructionSemantics {
  return implicitDivideSemantic("signed", width);
}

function implicitDivideSemantic(kind: DivideKind, width: OperandWidth): InstructionSemantics {
  switch (width) {
    case 8:
      return divideTemplate(kind, reg("al"), reg("ah"), divideByte);
    case 16:
      return divideTemplate(kind, reg("ax"), reg("dx"), divideWord);
    case 32:
      return divideTemplate(kind, reg("eax"), reg("edx"), divideDword);
  }
}

function divideTemplate<Width extends OperandWidth>(
  kind: DivideKind,
  quotientTarget: RegRefForWidth<Width>,
  remainderTarget: RegRefForWidth<Width>,
  divide: DivideOperation<Width>
): InstructionSemantics {
  return (s) => {
    const divisor = s.read(s.operand(0), quotientTarget.width);
    const result = divide(s, kind, divisor);

    // The undefined DIV/IDIV status flags keep their prior values on observed
    // hardware, so no flags are written.
    s.write(quotientTarget, result.quotient);
    s.write(remainderTarget, result.remainder);
  };
}

function divideByte(s: SemanticsBuilder, kind: DivideKind, divisor: Integer<8>): DivideResult<8> {
  const ax = s.read(s.reg("ax"));

  if (kind === "signed") {
    return signedNarrowDivide(s, ax.signed.extend(32), divisor);
  }

  return unsignedNarrowDivide(s, ax.unsigned.shr(8).truncate(8), ax.unsigned.extend(32), divisor);
}

function divideWord(s: SemanticsBuilder, kind: DivideKind, divisor: Integer<16>): DivideResult<16> {
  const low = s.read(s.reg("ax"));
  const high = s.read(s.reg("dx"));
  const dividend = high.unsigned.extend(32).shl(16).or(low.unsigned.extend(32));

  return kind === "signed"
    ? signedNarrowDivide(s, dividend, divisor)
    : unsignedNarrowDivide(s, high, dividend, divisor);
}

function divideDword(
  s: SemanticsBuilder,
  kind: DivideKind,
  divisor: Integer<32>
): DivideResult<32> {
  const low = s.read(s.reg("eax"));
  const high = s.read(s.reg("edx"));
  const dividend = high.unsigned.extend(64).shl(32).or(low.unsigned.extend(64));

  if (kind === "unsigned") {
    guardUnsignedDivision(s, high, divisor);
    const divisor64 = divisor.unsigned.extend(64);

    return {
      quotient: dividend.unsigned.div(divisor64).truncate(32),
      remainder: dividend.unsigned.rem(divisor64).truncate(32)
    };
  }

  s.if(
    undefinedSignedDwordDivision(dividend, divisor),
    (then) => then.cpuException(divideError()),
    "unlikely"
  );

  const divisor64 = divisor.signed.extend(64);
  const quotient64 = dividend.signed.div(divisor64);
  const quotient = quotient64.truncate(32);

  // The quotient fits if it round-trips through its low 32 bits; the
  // truncation is shared with the register write.
  s.if(
    quotient64.ne(quotient.signed.extend(64)),
    (then) => then.cpuException(divideError()),
    "unlikely"
  );

  return {
    quotient,
    remainder: dividend.signed.rem(divisor64).truncate(32)
  };
}

function unsignedNarrowDivide<Width extends 8 | 16>(
  s: SemanticsBuilder,
  high: Integer<Width>,
  dividend: I32Value,
  divisor: Integer<Width>
): DivideResult<Width> {
  guardUnsignedDivision(s, high, divisor);
  const divisor32 = divisor.unsigned.extend(32);

  return {
    quotient: dividend.unsigned.div(divisor32).truncate(divisor.width),
    remainder: dividend.unsigned.rem(divisor32).truncate(divisor.width)
  };
}

function signedNarrowDivide<Width extends 8 | 16>(
  s: SemanticsBuilder,
  dividend: I32Value,
  divisor: Integer<Width>
): DivideResult<Width> {
  const divisor32 = divisor.signed.extend(32);

  // The division cannot evaluate a zero divisor, nor the minimum dividend of
  // its computation type over -1; both raise #DE (the latter overflows the
  // destination), so both are checked before dividing.
  s.if(
    undefinedSignedNarrowDivision(divisor.width, dividend, divisor32),
    (then) => then.cpuException(divideError()),
    "unlikely"
  );

  const quotient = dividend.signed.div(divisor32);

  s.if(
    narrowQuotientOverflows(divisor.width, quotient),
    (then) => then.cpuException(divideError()),
    "unlikely"
  );

  return {
    quotient: quotient.truncate(divisor.width),
    remainder: dividend.signed.rem(divisor32).truncate(divisor.width)
  };
}

function guardUnsignedDivision<Width extends OperandWidth>(
  s: SemanticsBuilder,
  high: Integer<Width>,
  divisor: Integer<NoInfer<Width>>
): void {
  // The quotient fits if the dividend's high half is below the divisor; a
  // zero divisor fails that too, so one check covers both #DE causes.
  s.if(high.unsigned.ge(divisor), (then) => then.cpuException(divideError()), "unlikely");
}

function undefinedSignedNarrowDivision(
  width: 8 | 16,
  dividend: I32Value,
  divisor: I32Value
): BitValue {
  const divisorZero = divisor.eq(0);

  // A byte divide's sign-extended 16-bit dividend cannot reach INT32_MIN.
  if (width === 8) {
    return divisorZero;
  }

  return divisorZero.or(dividend.eq(-0x8000_0000).and(divisor.eq(-1)));
}

function undefinedSignedDwordDivision(dividend: I64Value, divisor: I32Value): BitValue {
  return divisor.eq(0).or(dividend.eq(-0x8000_0000_0000_0000n).and(divisor.eq(-1)));
}

// The quotient fits its signed width if quotient + 2^(width-1) fits the
// unsigned width.
function narrowQuotientOverflows(width: 8 | 16, quotient: I32Value): BitValue {
  const bias = width === 8 ? 0x80 : 0x8000;

  return quotient.add(bias).unsigned.ge(bias * 2);
}
