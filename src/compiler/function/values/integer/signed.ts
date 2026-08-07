import type {
  BinaryOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { ValueRef } from "../reference.js";
import { extendInteger } from "./conversion.js";
import { binary, compare, shift } from "./value.js";
import type {
  IntegerOperand,
  BitValue,
  Integer,
  ExtensionTargets,
  ShiftCount,
  Signedness,
  SignednessView,
  WidthsAtMost
} from "./types.js";

export function signednessView<Width extends IntegerWidth, Mode extends Signedness>(
  value: Integer<Width>,
  signedness: Mode
): SignednessView<Width, Mode> {
  return new ValueSignednessView(value, signedness);
}

class ValueSignednessView<
  Width extends IntegerWidth,
  Mode extends Signedness
> implements SignednessView<Width, Mode> {
  readonly #value: Integer<Width>;

  constructor(
    value: Integer<Width>,
    readonly signedness: Mode
  ) {
    this.#value = value;
  }

  get width(): Width {
    return this.#value.width;
  }

  div(other: IntegerOperand<Width>): Integer<Width> {
    return binary(this.#value, signedOperator("div", this.signedness), other);
  }

  rem(other: IntegerOperand<Width>): Integer<Width> {
    return binary(this.#value, signedOperator("rem", this.signedness), other);
  }

  shr(count: ShiftCount): Integer<Width> {
    return shift(this.#value, this.signedness === "signed" ? "shr_s" : "shr_u", count);
  }

  lt(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("lt", this.signedness), other);
  }

  le(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("le", this.signedness), other);
  }

  gt(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("gt", this.signedness), other);
  }

  ge(other: IntegerOperand<Width>): BitValue {
    return compare(this.#value, signedComparison("ge", this.signedness), other);
  }

  extend<TargetWidth extends ExtensionTargets<Width>>(
    this: SignednessView<Width, Mode>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  extend<TargetWidth extends IntegerWidth>(
    this: SignednessView<Width, Mode> &
      Readonly<{
        width: WidthsAtMost<TargetWidth>;
      }>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  extend(width: IntegerWidth): ValueRef {
    return extendInteger(this.#value, this.signedness, width);
  }
}

function signedOperator(operation: "div" | "rem", signedness: Signedness): BinaryOperator {
  return `${operation}_${signedness === "signed" ? "s" : "u"}`;
}

function signedComparison(
  operation: "lt" | "le" | "gt" | "ge",
  signedness: Signedness
): CompareOperator {
  return `${operation}_${signedness === "signed" ? "s" : "u"}`;
}
