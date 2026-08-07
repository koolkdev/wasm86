import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import { integerUnreachable, integerZeroTest } from "./value.js";
import type { AnyInteger, Integer, BitValue, I32Value } from "./types.js";

export function unreachable(): I32Value;
export function unreachable<Width extends IntegerWidth>(width: Width): Integer<Width>;
export function unreachable(width: IntegerWidth = 32): AnyInteger {
  switch (width) {
    case 1:
      return integerUnreachable(1);
    case 8:
      return integerUnreachable(8);
    case 16:
      return integerUnreachable(16);
    case 32:
      return integerUnreachable(32);
    case 64:
      return integerUnreachable(64);
  }
}

export function nonzero(value: AnyInteger): BitValue {
  return integerZeroTest("nonzero", value);
}
