import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import { integerConstant } from "./value.js";
import type { AnyInteger, I32Value, I64Value, Integer, IntegerLiteral } from "./types.js";

export function integer<Width extends IntegerWidth>(
  width: Width,
  value: IntegerLiteral<Width>
): Integer<Width>;
export function integer(width: IntegerWidth, value: number | bigint): AnyInteger {
  switch (width) {
    case 1:
      return integerConstant(1, value);
    case 8:
      return integerConstant(8, value);
    case 16:
      return integerConstant(16, value);
    case 32:
      return integerConstant(32, value);
    case 64:
      return integerConstant(64, value);
  }
}

export function i32(value: number): I32Value {
  return integer(32, value);
}

export function i64(value: bigint): I64Value {
  return integer(64, value);
}

export function u8(value: number): Integer<8> {
  return integer(8, value);
}

export function u16(value: number): Integer<16> {
  return integer(16, value);
}
